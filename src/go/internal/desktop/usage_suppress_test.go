package desktop

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// suppressUsageRow withholds a live-usage readout when the active account is
// known not to be the live login: the quota comes from the live credential,
// so showing it on the active row misattributes someone else's quota (the
// Codex desktop app keeps its own account). Unknown comparisons fail open.
func TestSuppressUsageRowKnownMismatch(t *testing.T) {
	env := newTrayEnv(t)
	ctx := context.Background()

	codexAuth := os.Getenv("CODEX_AUTH_PATH")
	if codexAuth == "" {
		t.Fatal("CODEX_AUTH_PATH not set by newTrayEnv")
	}
	writeAuth := func(doc string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(codexAuth), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(codexAuth, []byte(doc), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	// Save account A, then move the live login to B: the active row (A) is a
	// known mismatch and its quota must be suppressed.
	writeAuth(`{"tokens":{"access_token":"at-a","id_token":"h.e30.sig","account_id":"acct-a"}}`)
	if _, err := env.Svc.Save(ctx, "codex", "work", true); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := env.Deps.Store.SetActiveContext(ctx, "codex", "work"); err != nil {
		t.Fatalf("set active: %v", err)
	}
	writeAuth(`{"tokens":{"access_token":"at-b","id_token":"h.e30.sig","account_id":"acct-b"}}`)
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})

	if !suppressUsageRow(ctx, srv, "codex", "work") {
		t.Fatal("known live mismatch must suppress the usage row")
	}

	// Restoring the matching login lifts the suppression.
	writeAuth(`{"tokens":{"access_token":"at-a2","id_token":"h.e30.sig","account_id":"acct-a"}}`)
	if suppressUsageRow(ctx, srv, "codex", "work") {
		t.Fatal("matching live login must not suppress the usage row")
	}

	// No active account: nothing to misattribute, fail open.
	if suppressUsageRow(ctx, srv, "codex", "") {
		t.Fatal("empty active must not suppress")
	}
}

func TestUsageSuppressionDoesNotWaitForProviderMutation(t *testing.T) {
	env := newTrayEnv(t)
	saveGrokAccountAndClearLive(t, env)
	if err := env.Deps.Store.SetActiveContext(context.Background(), "grok", "work"); err != nil {
		t.Fatal(err)
	}
	release := holdProviderScope(t, env.Deps.Root, "grok")
	defer release()
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	done := make(chan bool, 1)
	go func() { done <- suppressUsageRow(context.Background(), srv, "grok", "work") }()
	select {
	case <-done:
	case <-time.After(displayReadBudget):
		t.Fatal("quota display waited on provider mutation")
	}
}
