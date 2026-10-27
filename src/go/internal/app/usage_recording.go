package app

import (
	"context"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/pricing"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/usagelog"
)

// RecordUsage turns on usage history for this process's serving leaves
// (ADR-0037) and returns the function that flushes and turns it off. Only the
// detached proxy, pool and hub children call it: they are the processes that
// serve requests, and each writes its own rows.
func (a *App) RecordUsage(ctx context.Context) func() {
	if a == nil || a.DB == nil {
		return func() {}
	}
	writer := usagelog.NewWriter(ctx, a.DB)
	proxy.SetUsageRecorder(writer.Record)
	return func() {
		proxy.SetUsageRecorder(nil)
		writer.Close()
	}
}

// UsageSummary reads usage history since a time, grouped by by, with a dated
// estimate. The CLI and the management API both answer from it, so the two
// cannot disagree about what was spent.
func (a *App) UsageSummary(ctx context.Context, since time.Time, by string, now time.Time) (usagelog.Summary, error) {
	_ = usagelog.Prune(ctx, a.DB, now)
	rows, err := usagelog.Rows(ctx, a.DB, since.UnixMilli())
	if err != nil {
		return usagelog.Summary{}, anyerr.Wrapf(err, "read usage history", "USAGE_READ")
	}
	prices, err := pricing.Load(a.Root)
	if err != nil {
		return usagelog.Summary{}, anyerr.Newf("Could not read "+pricing.OverrideFile+": "+err.Error(),
			"PRICING_INVALID", anyerr.WithExitCode(anyerr.Operational),
			anyerr.WithSuggestions("Fix or remove "+pricing.OverrideFile+" in the AnyPick data directory."))
	}
	return usagelog.Summarize(rows, by, since, prices), nil
}
