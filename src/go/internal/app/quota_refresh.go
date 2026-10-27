package app

import (
	"context"
	"os"
	"time"

	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/quotacache"
)

// quotaFetchTimeout bounds one account's usage read. A slow vendor costs that
// account its reading, never the loop.
const quotaFetchTimeout = 10 * time.Second

// QuotaRefreshInterval is how often a soonest-reset pool or hub re-reads its
// accounts. It is well inside quotacache.MaxAgeMs, so one missed tick does not
// drop the strategy back to failover order.
const QuotaRefreshInterval = 5 * time.Minute

// RefreshQuotaCache reads each account's quota windows from its saved
// snapshot and records them for routing (ADR-0035). A provider that cannot
// read a saved account's usage is skipped. An account whose usage read fails
// loses its previous reading rather than keeping a stale one; one whose
// snapshot cannot be materialised (a sign-in holds its lock) keeps the reading
// until it ages out, since that failure says nothing about its quota.
//
// It reads snapshots through the cached, non-locking path first: this runs on
// a timer beside live traffic and should not queue behind a sign-in.
func (a *App) RefreshQuotaCache(ctx context.Context, providerID string, accountNames []string) {
	if a == nil || a.Providers == nil || a.Accounts == nil {
		return
	}
	pv, err := a.Providers.Get(providerID)
	if err != nil {
		return
	}
	reader, ok := pv.(provider.SnapshotUsageProvider)
	if !ok {
		return
	}
	for _, name := range accountNames {
		if ctx.Err() != nil {
			return
		}
		account, err := a.Accounts.CachedAccount(ctx, providerID, name)
		if err != nil || account == nil || account.SnapshotDir == "" {
			_ = quotacache.Forget(a.Root, providerID, name)
			continue
		}
		// The cached read names the snapshot directory without making sure it
		// is on disk; a fresh child may not have materialised it yet. Only
		// then is the locking read worth its cost. If it cannot get the lock
		// (a sign-in holds it), the previous reading stays until it ages out
		// rather than being dropped for a reason unrelated to quota.
		if _, statErr := os.Stat(account.SnapshotDir); statErr != nil {
			materialized, gerr := a.Accounts.Get(ctx, providerID, name)
			if gerr != nil || materialized == nil || materialized.SnapshotDir == "" {
				continue
			}
			account = materialized
		}
		readCtx, cancel := context.WithTimeout(ctx, quotaFetchTimeout)
		usage, err := reader.SnapshotUsage(readCtx, account.SnapshotDir)
		cancel()
		if err != nil || usage == nil {
			_ = quotacache.Forget(a.Root, providerID, name)
			continue
		}
		windows := make([]quotacache.Window, 0, len(usage.Windows))
		for _, w := range usage.Windows {
			windows = append(windows, quotacache.Window{RemainingPercent: w.RemainingPercent, ResetsAtMs: w.ResetsAtMs})
		}
		_ = quotacache.Put(a.Root, providerID, name, quotacache.Entry{
			FetchedAtMs: time.Now().UnixMilli(), Windows: windows,
		})
	}
}

// KeepQuotaCacheFresh refreshes now and then every QuotaRefreshInterval until
// ctx ends. A pool or hub child runs it beside its listener while its strategy
// is soonest-reset.
func (a *App) KeepQuotaCacheFresh(ctx context.Context, sources func() map[string][]string) {
	refresh := func() {
		for providerID, names := range sources() {
			a.RefreshQuotaCache(ctx, providerID, names)
		}
	}
	refresh()
	ticker := time.NewTicker(QuotaRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refresh()
		}
	}
}
