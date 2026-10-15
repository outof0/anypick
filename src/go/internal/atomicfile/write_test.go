package atomicfile

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// ── unit tests ────────────────────────────────────────────────────────

func TestWriteReplacesByRename(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := Write(path, []byte("new"), 0o600); err != nil {
		t.Fatalf("Write: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil || string(data) != "new" {
		t.Fatalf("content = %q err=%v, want %q", data, err, "new")
	}
}

func TestWriteSetsModeAndLeavesNoStagingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "auth.json")

	if err := Write(path, []byte("x"), 0o600); err != nil {
		t.Fatalf("Write into a missing directory: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		perm := info.Mode().Perm()
		t.Fatalf("mode = %v, want 0600", perm)
	}
	leftovers, err := filepath.Glob(filepath.Join(dir, "nested", ".anypick-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(leftovers) != 0 {
		t.Fatalf("staging file left behind: %v", leftovers)
	}
}

func TestWriteHonoursRequestedMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cfg.json")
	if err := Write(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o644 {
		perm := info.Mode().Perm()
		t.Fatalf("mode = %v, want 0644", perm)
	}
}

// ── the gate ──────────────────────────────────────────────────────────

// TestNoHandRolledAtomicWrite is the reason this package exists.
//
// Before it, three packages each hand-rolled "write a temp file, chmod it,
// rename it over the target" — and they had already drifted: one used a fixed
// ".tmp" suffix, so two concurrent writers raced on the same staging path.
// Meanwhile a fourth place wrote the user's live ~/.grok/auth.json with a plain
// os.WriteFile, which destroys their login if the process dies mid-write
// (invariant #4, ADR 0004).
//
// One implementation is the only shape where the next ported provider cannot get
// this wrong, so this fails the build if another appears. The companion rule
// is TestLiveCredentialWritesAreAtomic below: a plain os.WriteFile to a live
// credential or client-config path is the same bug without the rename half,
// so the gate that only matches stage+rename pairs cannot see it.
//
// CODE_REVIEW.md §5: mechanical, structural, silently violable → rung 3.
func TestNoHandRolledAtomicWrite(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatalf("resolve the module root: %v", err)
	}

	fset := token.NewFileSet()
	var violations []string

	err = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			base := info.Name()
			if base == ".git" || base == "bin" || base == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		// This package owns the pattern.
		if filepath.ToSlash(filepath.Dir(rel)) == "internal/atomicfile" {
			return nil
		}
		file, parseErr := parser.ParseFile(fset, path, nil, 0)
		if parseErr != nil {
			return parseErr
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			stages := false
			renames := false
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || sel.Sel == nil {
					return true
				}
				pkg := ""
				if id, ok := sel.X.(*ast.Ident); ok {
					pkg = id.Name
				}
				if pkg != "os" {
					return true
				}
				switch sel.Sel.Name {
				case "CreateTemp", "Create", "WriteFile":
					stages = true
				case "Rename":
					renames = true
				}
				return true
			})
			if stages && renames {
				pos := fset.Position(fn.Pos())
				violations = append(violations,
					pos.Filename+":"+strconv.Itoa(pos.Line)+": "+fn.Name.Name+
						" hand-rolls an atomic write; use atomicfile.Write")
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk the module: %v", err)
	}

	if len(violations) > 0 {
		t.Errorf("more than one atomic-write implementation:\n  %s",
			strings.Join(violations, "\n  "))
	}
}

// TestLiveCredentialWritesAreAtomic closes the blind spot in
// TestNoHandRolledAtomicWrite: that gate only fires when one function both
// stages and renames, so a plain os.WriteFile to a live credential or
// client-config path passes silently — and a crash mid-write destroys a login
// the user owns (invariant #4, ADR 0004). Snapshot staging under a destDir is
// exempt: the store's writeMeta commit point owns its atomicity.
//
// CODE_REVIEW.md §5: mechanical, structural, silently violable → rung 3.
func TestLiveCredentialWritesAreAtomic(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatalf("resolve the module root: %v", err)
	}

	fset := token.NewFileSet()
	var violations []string

	err = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			base := info.Name()
			if base == ".git" || base == "bin" || base == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		dir := filepath.Dir(rel)
		if dir != "internal/provider" && dir != "internal/client" {
			return nil
		}
		file, parseErr := parser.ParseFile(fset, path, nil, 0)
		if parseErr != nil {
			return parseErr
		}
		// Staging helpers take the snapshot directory: their writes are
		// committed by writeMeta, not by this rule.
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil || fn.Type == nil {
				continue
			}
			takesStagingDir := false
			for _, field := range fn.Type.Params.List {
				for _, name := range field.Names {
					if name.Name == "destDir" {
						takesStagingDir = true
					}
				}
			}
			if takesStagingDir {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || sel.Sel == nil || sel.Sel.Name != "WriteFile" {
					return true
				}
				id, ok := sel.X.(*ast.Ident)
				if !ok || id.Name != "os" {
					return true
				}
				pos := fset.Position(call.Pos())
				violations = append(violations,
					pos.Filename+":"+strconv.Itoa(pos.Line)+": "+fn.Name.Name+
						" writes a live credential or client config with os.WriteFile; use atomicfile.Write (ADR 0004)")
				return true
			})
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk the module: %v", err)
	}

	if len(violations) > 0 {
		t.Errorf("live credential writes must go through atomicfile:\n  %s",
			strings.Join(violations, "\n  "))
	}
}
