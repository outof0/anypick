package desktop

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/provider"

	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/refs"
)

func TestRefreshQuotaUsesOnlyTheSavedLogin(t *testing.T) {
	env := newTrayEnv(t)
	ctx := context.Background()
	for _, name := range []string{"saved", "current"} {
		env.writeCodexLive(name + "@example.com")
		if _, err := env.Svc.Save(ctx, "codex", name, false); err != nil {
			t.Fatal(err)
		}
	}
	if err := env.Deps.Store.SetActiveContext(ctx, "codex", "current"); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(env.CodexA)
	if err != nil {
		t.Fatal(err)
	}

	requests := make(chan string, 2)
	var deny atomic.Bool
	vendor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		requests <- req.Header.Get("Authorization")
		if deny.Load() {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"rate_limit":{"primary_window":{"used_percent":34}}}`))
	}))
	defer vendor.Close()
	t.Setenv("ANYPICK_CODEX_USAGE_ENDPOINT", vendor.URL)
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	cmd := Mutate{ProviderID: "codex", Name: "saved", Operation: "account-refresh-quota"}
	refresh := func() Result {
		t.Helper()
		result, _ := srv.routeMutation(ctx, nil, cmd)
		select {
		case bearer := <-requests:
			if bearer != "Bearer tok-saved@example.com" {
				t.Fatal("quota read used the wrong credential")
			}
		default:
			t.Fatal("vendor was not contacted")
		}
		return result
	}
	if result := refresh(); result.Status != "success" {
		t.Fatalf("refresh: %+v", result)
	}
	account, err := env.Svc.CachedAccount(ctx, "codex", "saved")
	if err != nil || account == nil {
		t.Fatalf("read saved account: %v", err)
	}
	quota := srv.readSavedAccountQuota(ctx, *account)
	if quota == nil || quota.FetchedAtMs <= 0 || len(quota.Windows) != 1 || quota.Windows[0].RemainingPercent != 66 {
		t.Fatalf("saved quota = %+v", quota)
	}

	if err := os.RemoveAll(account.SnapshotDir); err != nil {
		t.Fatal(err)
	}
	if cached := srv.readSavedAccountQuota(ctx, *account); cached == nil || cached.FetchedAtMs != quota.FetchedAtMs {
		t.Fatal("deleting the snapshot cache hid the committed account's last quota")
	}

	deny.Store(true)
	if result := refresh(); result.Code != "QUOTA_LOGIN_REQUIRED" {
		t.Fatalf("expired login: %+v", result)
	}
	if saved := srv.readSavedAccountQuota(ctx, *account); saved == nil || saved.FetchedAtMs != quota.FetchedAtMs {
		t.Fatal("an unanswered refresh removed the last quota reading")
	}
	after, err := os.ReadFile(env.CodexA)
	if err != nil || !bytes.Equal(after, before) {
		t.Fatalf("live credential changed, read error = %v", err)
	}
	if active, err := env.Svc.Active(ctx, "codex"); err != nil || active != "current" {
		t.Fatalf("active account = %q, error = %v", active, err)
	}
	env.writeCodexLive("replacement@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "saved", true); err != nil {
		t.Fatal(err)
	}
	if stale := srv.readSavedAccountQuota(ctx, *account); stale != nil {
		t.Fatal("replacement login inherited the old reading")
	}
}

func TestSavedQuotaRequestDoesNotLockSignInOrPublishForAReplacement(t *testing.T) {
	env := newTrayEnv(t)
	ctx := context.Background()
	env.writeCodexLive("first@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "work", false); err != nil {
		t.Fatal(err)
	}
	started, resume := make(chan struct{}), make(chan struct{})
	vendor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-resume
		_, _ = w.Write([]byte(`{"rate_limit":{"primary_window":{"used_percent":30}}}`))
	}))
	defer vendor.Close()
	defer func() {
		select {
		case <-resume:
		default:
			close(resume)
		}
	}()
	t.Setenv("ANYPICK_CODEX_USAGE_ENDPOINT", vendor.URL)
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	done := make(chan Result, 1)
	go func() {
		result, _ := srv.routeMutation(ctx, nil, Mutate{ProviderID: "codex", Name: "work", Operation: "account-refresh-quota"})
		done <- result
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("quota request did not reach the vendor")
	}

	env.writeCodexLive("second@example.com")
	err := lock.WithMutationLocks(ctx, env.Root, []string{refs.ProviderScope("codex")}, func(c context.Context) error {
		_, err := env.Svc.Save(c, "codex", "work", true)
		return err
	}, 250*time.Millisecond)
	close(resume)
	if err != nil {
		t.Fatalf("replacing the login while a quota request was pending: %v", err)
	}
	select {
	case result := <-done:
		if result.Code != "STATE_CONFLICT" {
			t.Fatalf("quota request for the replaced credential: %+v", result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("quota request did not finish")
	}
}

func TestLiveQuotaVerifiesTheCredentialItQueries(t *testing.T) {
	env := newTrayEnv(t)
	ctx := context.Background()
	env.writeCodexLive("first@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "first", false); err != nil {
		t.Fatal(err)
	}
	var called atomic.Bool
	vendor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		called.Store(true)
		if req.Header.Get("Authorization") != "Bearer tok-first@example.com" {
			t.Error("the quota read sent another account's token")
		}
		_, _ = w.Write([]byte(`{"rate_limit":{"primary_window":{"used_percent":30}}}`))
	}))
	defer vendor.Close()
	t.Setenv("ANYPICK_CODEX_USAGE_ENDPOINT", vendor.URL)
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	pv, err := env.Deps.Providers.Get("codex")
	if err != nil {
		t.Fatal(err)
	}
	state := srv.readLiveAccount(ctx, pv)
	if state.name != "first" {
		t.Fatalf("first login was not matched: %q", state.name)
	}

	env.writeCodexLive("other@example.com")
	if usage, err := srv.readLiveQuota(ctx, pv, pv.(provider.LiveUsageProvider), state); err != nil || usage != nil || called.Load() {
		t.Fatalf("quota after external sign-in = %+v, request made = %v, err = %v", usage, called.Load(), err)
	}

	if _, err := env.Svc.Save(ctx, "codex", "first", true); err != nil {
		t.Fatal(err)
	}
	if usage, err := srv.readLiveQuota(ctx, pv, pv.(provider.LiveUsageProvider), state); err != nil || usage != nil || called.Load() {
		t.Fatalf("quota after replacing the saved login = %+v, request made = %v, err = %v", usage, called.Load(), err)
	}

	env.writeCodexLive("first@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "first", true); err != nil {
		t.Fatal(err)
	}
	state = srv.readLiveAccount(ctx, pv)
	if usage, err := srv.readLiveQuota(ctx, pv, pv.(provider.LiveUsageProvider), state); err != nil || usage == nil || !called.Load() {
		t.Fatalf("quota for matching login = %+v, request made = %v, err = %v", usage, called.Load(), err)
	}
}

func TestSavedQuotaCacheRejectsOversizedProviderOutput(t *testing.T) {
	env := newTrayEnv(t)
	ctx := context.Background()
	env.writeCodexLive("first@example.com")
	if _, err := env.Svc.Save(ctx, "codex", "first", false); err != nil {
		t.Fatal(err)
	}
	account, err := env.Svc.CachedAccount(ctx, "codex", "first")
	if err != nil || account == nil {
		t.Fatalf("account lookup: %v", err)
	}
	digest, err := env.Deps.Store.SnapshotDigest(ctx, "codex", "first")
	if err != nil {
		t.Fatal(err)
	}
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	entry := savedAccountQuota{
		Digest: digest,
		SavedQuota: SavedQuota{FetchedAtMs: time.Now().UnixMilli(), Windows: []provider.UsageWindow{
			{Label: strings.Repeat("<", maxSavedQuotaEntryBytes), RemainingPercent: 80},
		}},
	}
	if err := srv.persistSavedQuota(ctx, *account, entry); err == nil {
		t.Fatal("oversized quota was accepted")
	}
	if _, err := os.Stat(savedAccountQuotaPath(*account)); !os.IsNotExist(err) {
		t.Fatalf("oversized quota cache exists: %v", err)
	}
}

func TestSavedQuotaBudgetPreservesTheMostRecentReading(t *testing.T) {
	rows := make([]AccountRow, 20)
	for idx := range rows {
		rows[idx].SavedQuota = &SavedQuota{
			FetchedAtMs: int64(idx + 1),
			Windows: []provider.UsageWindow{
				{Label: strings.Repeat("x", maxSavedQuotaEntryBytes/2), RemainingPercent: 80},
				{Label: strings.Repeat("y", maxSavedQuotaEntryBytes/4), RemainingPercent: 70},
			},
		}
	}
	builder := snapshotBuilder{snap: &Snapshot{Accounts: rows}}
	builder.boundSavedQuota()
	if rows[len(rows)-1].SavedQuota == nil || rows[0].SavedQuota != nil {
		t.Fatal("quota budget did not prioritize the latest reading")
	}
}

func TestSnapshotFollowsExternalNativeLogin(t *testing.T) {
	for _, id := range []string{"codex", "claude", "grok"} {
		t.Run(id, func(t *testing.T) {
			env := newTrayEnv(t)
			ctx := context.Background()
			t.Setenv("ANYPICK_CODEX_USAGE_ENDPOINT", "http://127.0.0.1:1/usage")
			authPath := env.CodexA
			writeLogin := func(name, _ string) { env.writeCodexLive(name + "@example.com") }
			switch id {
			case "claude":
				authPath = os.Getenv("ANYPICK_CLAUDE_CREDENTIALS_PATH")
				writeLogin = func(name, revision string) {
					// Claude Code credentials often carry only the plan.
					doc := fmt.Sprintf(`{"claudeAiOauth":{"subscriptionType":"max","accessToken":%q,"refreshToken":%q}}`, name+revision, name)
					if err := os.WriteFile(authPath, []byte(doc), 0o600); err != nil {
						t.Fatal(err)
					}
				}
			case "grok":
				authPath = filepath.Join(env.Home, ".grok", "auth.json")
				writeLogin = func(name, revision string) {
					doc := fmt.Sprintf(`{"https://auth.x.ai::test":{"user_id":%q,"key":%q,"expires_at":"2000-01-01T00:00:00Z"}}`, name, name+revision)
					if err := os.WriteFile(authPath, []byte(doc), 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"first", "second"} {
				writeLogin(name, "original")
				if _, err := env.Svc.Save(ctx, id, name, false); err != nil {
					t.Fatal(err)
				}
			}
			if err := env.Deps.Store.SetActiveContext(ctx, id, "first"); err != nil {
				t.Fatal(err)
			}
			oldSource := refs.AccountRef(id, "first")
			if id != "grok" {
				if _, err := env.Deps.Bindings.UpsertGlobalContext(ctx, bindings.Global{
					Client: id,
					Spec:   bindings.Spec{Client: id, Source: oldSource, Model: bindings.OmittedModel()},
				}); err != nil {
					t.Fatal(err)
				}
			}
			srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
			check := func(want string) {
				t.Helper()
				snap, err := srv.buildSnapshot(ctx)
				if err != nil {
					t.Fatal(err)
				}
				var active []string
				for _, row := range snap.Accounts {
					if row.ProviderID == id && row.Active {
						active = append(active, row.Name)
					}
				}
				if strings.Join(active, ",") != want {
					t.Fatalf("current accounts = %v, want %q", active, want)
				}
				if id == "grok" {
					return
				}
				var sources []string
				for _, row := range snap.Actions {
					if row.ClientID == id && row.Presentation == "app-route" && row.Selected {
						sources = append(sources, row.SourceID)
					}
				}
				wantSource := ""
				if want != "" {
					wantSource = refs.SerializeRef(refs.AccountRef(id, want))
				}
				if strings.Join(sources, ",") != wantSource {
					t.Fatalf("selected app route = %v, want %q", sources, wantSource)
				}
				for _, row := range snap.Usage {
					if row.ProviderID == id {
						wantAccount := want
						if wantAccount == "" {
							wantAccount = id
						}
						if row.Account != wantAccount || (want == "" && len(row.Windows) != 0) {
							t.Fatalf("usage = %+v, want account %q", row, wantAccount)
						}
						return
					}
				}
				t.Fatal("usage row missing")
			}
			writeLogin("second", "rotated")
			check("second")
			writeLogin("unsaved", "original")
			check("")
			if err := os.Remove(authPath); err != nil {
				t.Fatal(err)
			}
			check("")
			if active, err := env.Svc.Active(ctx, id); err != nil || active != "first" {
				t.Fatalf("stored account selection = %q, error = %v", active, err)
			}
			if id != "grok" {
				binding, err := env.Deps.Bindings.GetGlobalContext(ctx, id)
				if err != nil || binding == nil || binding.Spec.Source != oldSource {
					t.Fatalf("stored route changed: %v", err)
				}
			}
		})
	}
}

func TestLiveAccountReadDoesNotWaitForProviderMutation(t *testing.T) {
	env := newTrayEnv(t)
	env.writeCodexLive("work@example.com")
	if _, err := env.Svc.Save(context.Background(), "codex", "work", false); err != nil {
		t.Fatal(err)
	}
	pv, err := env.Deps.Providers.Get("codex")
	if err != nil {
		t.Fatal(err)
	}
	saved, err := env.Svc.CachedAccount(context.Background(), "codex", "work")
	if err != nil || saved == nil {
		t.Fatalf("saved account missing: %v", err)
	}
	if err := os.RemoveAll(saved.SnapshotDir); err != nil {
		t.Fatal(err)
	}
	release := holdProviderScope(t, env.Root, "codex")
	defer release()
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	done := make(chan liveAccountState, 1)
	go func() {
		done <- srv.readLiveAccount(context.Background(), pv)
	}()
	select {
	case state := <-done:
		if state.name != "work" {
			t.Fatalf("live account = %q, want work", state.name)
		}
	case <-time.After(displayReadBudget):
		t.Fatal("live account read waited on provider mutation")
	}
}
