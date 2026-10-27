package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/outof0/anypick/go/internal/quotacache"
)

// The cached account read names a snapshot directory without making sure it
// is on disk. A fresh pool or hub child that refreshed from it found nothing,
// dropped the account's reading, and soonest-reset quietly fell back to
// failover order forever.
func TestRefreshQuotaCacheReadsASnapshotThatIsNotMaterialised(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"rate_limit":{"primary_window":{"used_percent":40,"reset_after_seconds":3600,"limit_window_seconds":18000}}}`))
	}))
	t.Cleanup(stub.Close)
	t.Setenv("ANYPICK_CODEX_USAGE_ENDPOINT", stub.URL)

	root := filepath.Join(t.TempDir(), "anypick")
	a, closeFn, err := Ready(context.Background(), Options{Root: root, Home: testHome(t)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(closeFn)
	ctx := context.Background()
	if _, err := a.Accounts.SavePastedAuth(ctx, "codex", "work",
		[]byte(`{"tokens":{"access_token":"saved-token","refresh_token":"r","account_id":"acct"}}`), false); err != nil {
		t.Fatalf("seed a codex account: %v", err)
	}
	cached, err := a.Accounts.CachedAccount(ctx, "codex", "work")
	if err != nil || cached == nil || cached.SnapshotDir == "" {
		t.Fatalf("cached account = %+v, %v", cached, err)
	}
	if err := os.RemoveAll(cached.SnapshotDir); err != nil {
		t.Fatal(err)
	}

	a.RefreshQuotaCache(ctx, "codex", []string{"work"})

	entry, ok := quotacache.Load(a.Root, "codex").Accounts["work"]
	if !ok || len(entry.Windows) != 1 || entry.Windows[0].RemainingPercent != 60 {
		t.Fatalf("quota cache entry = %+v (present %v), want the reading taken from the materialised snapshot", entry, ok)
	}
}
