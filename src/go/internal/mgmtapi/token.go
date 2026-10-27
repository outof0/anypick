// Package mgmtapi is AnyPick's loopback management API (ADR-0034): a
// versioned, token-gated HTTP surface third-party tools use to read status and
// to switch accounts or start and stop proxies. The desktop hosts do not use
// it; they keep the stdio protocol of ADR-0020.
package mgmtapi

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/atomicfile"
	"github.com/outof0/anypick/go/internal/proxy"
)

// TokenFile is the bearer's file under the data directory.
const TokenFile = "serve.token"

// TokenPath is where the bearer lives for the data directory root.
func TokenPath(root string) string { return filepath.Join(root, TokenFile) }

// EnsureToken returns the bearer, creating it on first use. Creation is
// exclusive so two first callers cannot each mint a token and leave one of
// them holding a key the server never accepts.
func EnsureToken(root string) (string, error) {
	if token, err := readToken(root); err == nil {
		return token, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	token, err := proxy.NewToken()
	if err != nil {
		return "", anyerr.Wrapf(err, "generate management API token", "SERVE_TOKEN_FAILED")
	}
	f, err := os.OpenFile(TokenPath(root), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, fs.ErrExist) {
		return readToken(root)
	}
	if err != nil {
		return "", anyerr.Wrapf(err, "create management API token", "SERVE_TOKEN_FAILED")
	}
	_, werr := f.WriteString(token + "\n")
	cerr := f.Close()
	if werr != nil || cerr != nil {
		_ = os.Remove(TokenPath(root))
		return "", anyerr.Wrapf(errors.Join(werr, cerr), "write management API token", "SERVE_TOKEN_FAILED")
	}
	return token, nil
}

// RotateToken replaces the bearer. A running server reads the file per
// request, so the old key stops working at once.
func RotateToken(root string) (string, error) {
	token, err := proxy.NewToken()
	if err != nil {
		return "", anyerr.Wrapf(err, "generate management API token", "SERVE_TOKEN_FAILED")
	}
	if err := atomicfile.Write(TokenPath(root), []byte(token+"\n"), 0o600); err != nil {
		return "", anyerr.Wrapf(err, "write management API token", "SERVE_TOKEN_FAILED")
	}
	return token, nil
}

// readToken returns the stored bearer. A file that is present but empty is an
// error, never an empty token: an empty expected token must not authenticate
// an empty presented one.
func readToken(root string) (string, error) {
	raw, err := os.ReadFile(TokenPath(root))
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return "", anyerr.Newf("The management API token file is empty.", "SERVE_TOKEN_FAILED",
			anyerr.WithSuggestions("Run `anypick serve token --rotate` to replace it."))
	}
	return token, nil
}
