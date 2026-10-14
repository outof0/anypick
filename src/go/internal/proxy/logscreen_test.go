package proxy

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/paths"
	"github.com/outof0/anypick/go/internal/store"
)

// The per-instance proxy bearer (ADR 0006) must not reach any log surface the
// CLI or the native app reads. These are the tests for the screening that
// internal/proxy/logscreen.go performs; without them a change that made
// RedactSecrets return its input unchanged would leave the suite green while
// the token reached `anypick proxy logs`.

func TestRedactSecretsRemovesExactSecretAndCredentialPatterns(t *testing.T) {
	const token = "5f1c9a3e7d2b4806a1c9f3e5d7b29104"

	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "exact persisted token",
			in:   "starting proxy for account work with token " + token,
			want: "starting proxy for account work with token [redacted]",
		},
		{
			name: "bearer header",
			in:   "upstream said authorization: Bearer sk-ant-abcdefghijklmnop",
			want: "upstream said authorization: Bearer [redacted]",
		},
		{
			name: "api key assignment",
			in:   "upstream config api_key=abcd1234efgh5678ijkl rejected",
			want: "upstream config api_key=[redacted] rejected",
		},
		{
			name: "short value is below the length floor and stays",
			in:   "upstream config api_key=abcd1234 rejected",
			want: "upstream config api_key=abcd1234 rejected",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := RedactSecrets(tc.in, []string{token})
			if strings.Contains(got, token) {
				t.Fatalf("secret survived redaction: %q", got)
			}
			if got != tc.want {
				t.Errorf("RedactSecrets(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// Redacting must not depend on the caller knowing a secret's literal value:
// credential-shaped text is screened with no secrets supplied at all, which is
// the path internal/desktop/hub_snapshot.go uses.
func TestRedactSecretsScreensCredentialPatternsWithNoKnownSecrets(t *testing.T) {
	got := RedactSecrets("authorization: Bearer sk-live-0123456789abcdef", nil)
	if strings.Contains(got, "sk-live-0123456789abcdef") {
		t.Fatalf("credential pattern survived with no secrets supplied: %q", got)
	}
}

// redactErr screens the message but must leave the error chain usable, because
// exit codes and errors.Is are how the CLI reports a failure. A screening step
// that flattened the chain would turn an actionable error into a bare string.
func TestRedactErrScreensMessageAndPreservesErrorIdentity(t *testing.T) {
	const token = "5f1c9a3e7d2b4806a1c9f3e5d7b29104"

	t.Run("structured error keeps its code and exit class", func(t *testing.T) {
		err := anyerr.Newf("could not start proxy using "+token,
			"PROXY_START_FAILED", anyerr.WithExitCode(anyerr.HealthFailure))
		got := redactErr(err, []string{token})
		if strings.Contains(got.Error(), token) {
			t.Fatalf("token survived in error message: %q", got.Error())
		}
		var structured *anyerr.Error
		if !errors.As(got, &structured) {
			t.Fatalf("screening flattened the error chain: %T", got)
		}
		if structured.Code != "PROXY_START_FAILED" {
			t.Errorf("code = %q, want PROXY_START_FAILED", structured.Code)
		}
		if anyerr.ExitCodeOf(got) != anyerr.HealthFailure {
			t.Errorf("exit code = %d, want %d", anyerr.ExitCodeOf(got), anyerr.HealthFailure)
		}
	})

	t.Run("unchanged message passes the original error through", func(t *testing.T) {
		base := errors.New("connection refused")
		got := redactErr(base, []string{"unused-secret"})
		if !errors.Is(got, base) {
			t.Errorf("redactErr must return the original when nothing is screened, got %v", got)
		}
	})
}

// ProxyLogs and ScreenProxyLog are the two surfaces the CLI reads. Both must
// withhold the persisted proxy_state token, including on the `--follow` path,
// which reads the raw file rather than going through ProxyLogs.
func TestProxyLogSurfacesWithholdPersistedToken(t *testing.T) {
	ts := newTestServices(t)
	ctx := context.Background()
	seedAccount(t, ts.Service, "work", true)

	const token = "5f1c9a3e7d2b4806a1c9f3e5d7b29104"
	if err := ts.Service.Store.WriteProxyStateContext(ctx, "codex", "work",
		store.ProxyRuntimeState{AccountName: "work", Endpoint: "http://127.0.0.1:1", Token: token}); err != nil {
		t.Fatal(err)
	}

	// The log file carries the token in both forms it can appear: a bare value
	// and a bearer header.
	logPath := paths.ProxyLogPath(ts.Service.Store.Root, "codex", "work")
	if err := os.MkdirAll(pathDir(logPath), 0o700); err != nil {
		t.Fatal(err)
	}
	body := "connected with token " + token + "\n" +
		"upstream request authorization: Bearer sk-ant-abcdefghijklmnop\n"
	if err := os.WriteFile(logPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("ProxyLogs", func(t *testing.T) {
		text, err := ts.Service.ProxyLogs(ctx, "codex", "work", 100)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(text, token) {
			t.Errorf("ProxyLogs leaked the persisted token: %q", text)
		}
		if strings.Contains(text, "sk-ant-abcdefghijklmnop") {
			t.Errorf("ProxyLogs leaked a bearer credential: %q", text)
		}
		if !strings.Contains(text, "[redacted]") {
			t.Errorf("ProxyLogs must mark what it removed, got %q", text)
		}
	})

	t.Run("ScreenProxyLog --follow path", func(t *testing.T) {
		got := ts.Service.ScreenProxyLog("codex", "work", body)
		if strings.Contains(got, token) {
			t.Errorf("ScreenProxyLog leaked the persisted token: %q", got)
		}
		if strings.Contains(got, "sk-ant-abcdefghijklmnop") {
			t.Errorf("ScreenProxyLog leaked a bearer credential: %q", got)
		}
	})
}

func pathDir(p string) string {
	return filepath.Dir(p)
}
