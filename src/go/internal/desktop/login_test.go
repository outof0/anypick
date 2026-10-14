package desktop

// Desktop protocol regressions for account-login: provider-owned browser
// sign-in runs off the main loop, publishes exactly one terminal result,
// honours cancellation frames, and rejects malformed payloads.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/accounts"
	"github.com/outof0/anypick/go/internal/testexec"
)

// syncedBuffer lets tests poll protocol output while server goroutines write;
// a bare bytes.Buffer read concurrently with WriteString is a data race.
type syncedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func waitForResult(t *testing.T, out *syncedBuffer) Result {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var res Result
		for _, line := range strings.Split(out.String(), "\n") {
			raw, ok := strings.CutPrefix(line, "result\t")
			if !ok {
				continue
			}
			decoded, derr := base64.StdEncoding.DecodeString(raw)
			if derr != nil {
				continue
			}
			if json.Unmarshal(decoded, &res) == nil && res.RequestID != "" {
				return res
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no terminal result within deadline; out=%q", out.String())
	return Result{}
}

// A cancel may arrive before the login handler has registered itself: commands
// run off the select loop, so the loop is free to read the cancel frame first.
// Dropping that cancel left the host waiting on a sign-in the user had already
// cancelled (and the browser launcher running for its full 30s).
func TestDesktopAccountLoginCancelBeforeStart(t *testing.T) {
	env := newTrayEnv(t)
	authPath := filepath.Join(env.Home, ".grok", "auth.json")
	t.Setenv("GROK_AUTH_PATH", authPath)
	marker := filepath.Join(t.TempDir(), "launched")
	launcher := testexec.Build(t)
	t.Setenv("ANYPICK_TESTEXEC_MARKER", marker)
	t.Setenv("ANYPICK_TESTEXEC_WAIT_MS", "30000")
	t.Setenv("GROK_BINARY", launcher)

	in, inWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	var out syncedBuffer
	srv := New(env.Deps, in, &out)
	go func() { _ = srv.Run(context.Background()) }()
	defer func() { _ = inWrite.Close() }()

	mutatePayload := `{"version":1,"requestId":"login-early","operation":"account-login","providerId":"grok","methodId":"grok-subscription"}`
	cancelPayload, _ := json.Marshal(cancelPayload{Version: 1, RequestID: "login-early"})
	enc := func(v string) string { return base64.StdEncoding.EncodeToString([]byte(v)) }
	// Both frames are in the pipe before the loop reads either one.
	if _, err := inWrite.WriteString("mutate\t" + enc(mutatePayload) + "\ncancel\t" + enc(string(cancelPayload)) + "\n"); err != nil {
		t.Fatal(err)
	}

	res := waitForResultFor(t, &out, "login-early")
	if res.Status != "cancelled" {
		t.Fatalf("want cancelled, got %+v", res)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("a cancelled-before-start login still launched the provider")
	}
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Fatal("cancelled login must not leave credential material behind")
	}
}

func TestDesktopAccountLoginEndToEnd(t *testing.T) {
	env := newTrayEnv(t)
	authPath := filepath.Join(env.Home, ".grok", "auth.json")
	t.Setenv("GROK_AUTH_PATH", authPath)
	launcher := testexec.Build(t)
	testexec.SetWrite(t, authPath, `{"sessions":{"s1":{"email":"tray@example.com","access_token":"tok"}}}`)
	t.Setenv("GROK_BINARY", launcher)

	var out syncedBuffer
	srv := newWaitedServerOut(t, env.Deps, &out)
	payload, _ := json.Marshal(Mutate{
		Version: 1, RequestID: "login-1", Operation: "account-login",
		ProviderID: "grok", MethodID: "grok-subscription", Name: "from-tray",
	})
	if err := srv.handle(context.Background(), &Command{Kind: "mutate", Payload: payload}); err != nil {
		t.Fatal(err)
	}

	res := waitForResult(t, &out)
	if res.Status != "success" || !strings.Contains(res.Message, "Signed in with Grok subscription") {
		t.Fatalf("result = %+v", res)
	}
	acct, gerr := env.Deps.Store.Get(context.Background(), "grok", "from-tray")
	if gerr != nil || acct == nil {
		t.Fatalf("account not saved by desktop login: %v", gerr)
	}
	active, aerr := env.Deps.Store.GetActive(context.Background(), "grok")
	if aerr != nil || active != "from-tray" {
		t.Fatalf("active = %q (%v)", active, aerr)
	}
	// The terminal frame is written before the best-effort warm and the
	// snapshot refresh, so the account is only durable for the host once the
	// in-flight goroutines have drained. Without this wait the refresh outlives
	// t.TempDir() and cleanup fails with "directory not empty".
	if !srv.waitForInFlight(30 * time.Second) {
		t.Fatal("login handler still had in-flight work after the terminal frame")
	}
	// The temp root must be readable after the wait: an open store handle or a
	// late refresh would have already removed or recreated entries under it.
	if _, rerr := os.ReadDir(env.Root); rerr != nil {
		t.Fatalf("temp root unreadable after the in-flight wait: %v", rerr)
	}
}

func TestDesktopAccountLoginCancelled(t *testing.T) {
	env := newTrayEnv(t)
	authPath := filepath.Join(env.Home, ".grok", "auth.json")
	t.Setenv("GROK_AUTH_PATH", authPath)
	launcher := testexec.Build(t)
	t.Setenv("ANYPICK_TESTEXEC_WAIT_MS", "30000")
	t.Setenv("GROK_BINARY", launcher)

	in, inWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	var out syncedBuffer
	srv := New(env.Deps, in, &out)

	go func() { _ = srv.Run(context.Background()) }()
	defer func() { _ = inWrite.Close() }()

	send := func(frame string) {
		t.Helper()
		if _, err := inWrite.WriteString(frame + "\n"); err != nil {
			t.Fatal(err)
		}
	}
	mutatePayload := `{"version":1,"requestId":"login-cancel","operation":"account-login","providerId":"grok","methodId":"grok-subscription"}`
	cancelPayload, _ := json.Marshal(cancelPayload{Version: 1, RequestID: "login-cancel"})
	enc := func(v string) string { return base64.StdEncoding.EncodeToString([]byte(v)) }
	send("mutate\t" + enc(mutatePayload))
	time.Sleep(300 * time.Millisecond)
	send("cancel\t" + enc(string(cancelPayload)))

	res := waitForResult(t, &out)
	if res.Status != "cancelled" {
		t.Fatalf("want cancelled, got %+v", res)
	}
	if _, err := os.Stat(authPath); !os.IsNotExist(err) {
		t.Fatal("cancelled login must not leave credential material behind")
	}
}

func TestDesktopAccountLoginValidation(t *testing.T) {
	// Extra unknown fields must be rejected before reaching the handler
	// (mirrors the TS isTray*Command key-set guard).
	fields := map[string]json.RawMessage{
		"version":    json.RawMessage(`1`),
		"requestId":  json.RawMessage(`"v1"`),
		"operation":  json.RawMessage(`"account-login"`),
		"providerId": json.RawMessage(`"grok"`),
		"methodId":   json.RawMessage(`"grok-subscription"`),
		"bogus":      json.RawMessage(`true`),
	}
	if err := validateMutate(fields); err == nil {
		t.Fatal("unknown field must be rejected")
	}
}

// waitForResultFor waits until a result frame with exactly this requestId
// appears (earlier frames in the buffer are skipped).
func waitForResultFor(t *testing.T, out *syncedBuffer, requestID string) Result {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, line := range strings.Split(out.String(), "\n") {
			raw, ok := strings.CutPrefix(line, "result\t")
			if !ok {
				continue
			}
			decoded, derr := base64.StdEncoding.DecodeString(raw)
			if derr != nil {
				continue
			}
			var res Result
			if json.Unmarshal(decoded, &res) == nil && res.RequestID == requestID {
				return res
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no terminal result %q within deadline; out=%q", requestID, out.String())
	return Result{}
}

// A sign-in adapter that never returns and ignores cancellation must still be
// answered: the host holds its mutation slot on that request, and the launcher's
// own timeout is not a guarantee that the adapter respects.
func TestDesktopAccountLoginDeadlineAnswersAWedgedAdapter(t *testing.T) {
	env := newTrayEnv(t)
	in, inWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	var out syncedBuffer
	srv := New(env.Deps, in, &out)
	srv.loginBudget = 150 * time.Millisecond
	wedged := make(chan struct{})
	defer close(wedged)
	srv.loginAttempt = func(context.Context, string, accounts.LoginOptions) (accounts.LoginResult, error) {
		<-wedged // deliberately ignores the context
		return accounts.LoginResult{}, nil
	}
	go func() { _ = srv.Run(context.Background()) }()
	defer func() { _ = inWrite.Close() }()

	payload := `{"version":1,"requestId":"login-wedged","operation":"account-login","providerId":"grok","methodId":"grok-subscription"}`
	if _, err := inWrite.WriteString("mutate\t" + base64.StdEncoding.EncodeToString([]byte(payload)) + "\n"); err != nil {
		t.Fatal(err)
	}

	res := waitForResultFor(t, &out, "login-wedged")
	if res.Status != "error" || res.Code != "LOGIN_TIMEOUT" {
		t.Fatalf("wedged login result = %+v", res)
	}
	if !strings.Contains(res.Message, "did not finish in time") {
		t.Fatalf("message = %q", res.Message)
	}
}

// The log command's budget is shorter than the host's own log timeout, so the
// host gets an attributed engine failure instead of its generic timeout.
func TestLogCommandBudgetFitsInsideTheHostTimeout(t *testing.T) {
	srv := &Server{}
	if got := srv.budgetFor("logs"); got != 8*time.Second {
		t.Fatalf("logs budget = %s", got)
	}
	if got := srv.budgetFor("mutate"); got != DesktopActionTimeout {
		t.Fatalf("mutate budget = %s", got)
	}
}
