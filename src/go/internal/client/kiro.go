package client

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/transport"
)

// kiroAdapter is an env-file based adapter. Native Kiro auth remains under
// account backup/restore (SSO cache files).
type kiroAdapter struct{ home string }

func newKiro(home string) *kiroAdapter { return &kiroAdapter{home: home} }

func (a *kiroAdapter) ID() string   { return "kiro" }
func (a *kiroAdapter) Name() string { return "Kiro" }
func (a *kiroAdapter) ShortName() string {
	return "Kiro"
}

func (a *kiroAdapter) Capabilities() *Capabilities {
	return &Capabilities{
		ID:                       "kiro",
		AcceptedProtocols:        []transport.Protocol{transport.OpenAI, transport.Anthropic},
		SupportsIsolatedHome:     true,
		SupportsPersistentConfig: true,
		ProtocolPreference:       transport.Anthropic,
	}
}

func applyKiroEnv(ctx *ApplyContext) map[string]string {
	env := map[string]string{
		"OPENAI_API_KEY": ctx.APIKey,
	}
	if ctx.Endpoint != "" {
		env["OPENAI_BASE_URL"] = ctx.Endpoint
		// Anthropic-compatible consumers of the Kiro proxy.
		env["ANTHROPIC_BASE_URL"] = ctx.Endpoint
		env["ANTHROPIC_AUTH_TOKEN"] = ctx.APIKey
	}
	if m := firstNonEmpty(ctx.ModelRoles["default"], ctx.DefaultModel); m != "" {
		env["OPENAI_MODEL"] = m
	}
	return env
}

func (a *kiroAdapter) Apply(ctx *ApplyContext) (*ApplyResult, error) {
	env := applyKiroEnv(ctx)
	keys := sortedKeys(env)

	if ctx.DryRun {
		return &ApplyResult{
			ManagedPaths: []string{
				filepath.Join(ctx.AnyPickRoot, "clients", "kiro", "env.sh"),
				filepath.Join(ctx.AnyPickRoot, "clients", "kiro", "env.ps1"),
			},
			ManagedEnvKeys: keys,
		}, nil
	}

	if ctx.IsolatedHome != "" {
		// Write env into the isolated tree only — never touch live files.
		isoAnyPick := filepath.Join(ctx.IsolatedHome, ".anypick")
		envPaths := writeClientEnvFiles(isoAnyPick, "kiro", env)
		dotenv := filepath.Join(ctx.IsolatedHome, ".kiro-anypick.env")
		var b strings.Builder
		for _, k := range keys {
			v, _ := json.Marshal(env[k])
			b.WriteString(fmt.Sprintf("%s=%s\n", k, string(v)))
		}
		// Isolated-tree mirror: atomic like every other write — one shape.
		if err := atomicfile.Write(dotenv, []byte(b.String()), 0o600); err != nil {
			return nil, err
		}
		return &ApplyResult{ManagedPaths: append(envPaths, dotenv), ManagedEnvKeys: keys}, nil
	}

	envPaths := writeClientEnvFiles(ctx.AnyPickRoot, "kiro", env)
	return &ApplyResult{ManagedPaths: envPaths, ManagedEnvKeys: keys}, nil
}

func (a *kiroAdapter) Reset() error { return a.RestoreNative() }

// RestoreNative unroutes a proxy binding when activation switches back to a
// native account. Kiro writes no live client files — only the generated env
// files — so removing those is the complete unroute.
func (a *kiroAdapter) RestoreNative() error {
	removeClientEnvFiles(anyPickRootFallback(), "kiro")
	return nil
}

func (a *kiroAdapter) Inspect() (*InspectResult, error) {
	return &InspectResult{
		Present: true,
		Native:  true,
		Summary: "Kiro runtime uses anypick env files (account auth separate)",
	}, nil
}

// Compile-time: the direct-account unroute path above must keep working.
var _ NativeRestorer = (*kiroAdapter)(nil)
