package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/pricing"
	"github.com/outof0/anypick/go/internal/usagelog"
)

const usageCmdUsage = "usage: anypick usage [--since 7d|24h|2006-01-02] [--by model|account|provider|day] [--json]"

// cmdUsage prints the token usage local proxies, pools and hubs served, with a
// dated API-list-price estimate (ADR-0037).
func cmdUsage(ctx context.Context, a *appView, args []string) int {
	fs := fsFor(args)
	sinceFlag := fs.String("since", "7d", "window start: 7d, 24h, or a local date")
	by := fs.String("by", "model", "group by model, account, provider or day")
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 0 {
		return usageError(usageCmdUsage)
	}
	if !usagelog.ValidGroupBy(*by) {
		return usageError(usageCmdUsage)
	}
	now := time.Now()
	since, err := usagelog.ParseSince(*sinceFlag, now)
	if err != nil {
		return reportErr(anyerr.Newf(err.Error(), "INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage)))
	}
	summary, err := a.UsageSummary(ctx, since, *by, now)
	if err != nil {
		return reportErr(err)
	}
	if wantJSON(args) {
		jsonOut(summary)
		return int(anyerr.Success)
	}
	printUsageSummary(summary, since)
	return int(anyerr.Success)
}

func printUsageSummary(s usagelog.Summary, since time.Time) {
	cliPrintf("Usage since %s, by %s\n", since.Format("2006-01-02 15:04"), s.By)
	if s.Total.Requests == 0 {
		cliPrintln("No requests recorded. Usage is recorded for requests served by a running proxy, pool or Proxy Hub.")
		return
	}
	cliPrintf("%-36s %9s %12s %12s %12s %12s\n", "", "requests", "input", "output", "cached", "est. USD")
	for _, line := range append(s.Lines, s.Total) {
		cliPrintf("%-36s %9d %12s %12s %12s %12s\n", line.Key, line.Requests,
			tokens(line.InputTokens), tokens(line.OutputTokens),
			tokens(line.CacheReadTokens+line.CacheWriteTokens), usd(line))
	}
	cliPrintf("\nEstimated at API list prices as of %s; not a bill. Subscription logins are not charged per token.\n", s.PricesAsOf)
	if len(s.Overridden) > 0 {
		cliPrintf("Prices from your %s: %s\n", pricing.OverrideFile, strings.Join(s.Overridden, ", "))
	}
	if s.Total.UnpricedRequests > 0 {
		cliPrintf("%d request(s) use a model with no listed price and are not in the estimate; add it to %s.\n",
			s.Total.UnpricedRequests, pricing.OverrideFile)
	}
	if s.Total.Unreported > 0 {
		cliPrintf("%d response(s) carried no token counts (for example an OpenAI stream without include_usage).\n",
			s.Total.Unreported)
	}
}

func tokens(n int64) string { return strconv.FormatInt(n, 10) }

func usd(line usagelog.Line) string {
	if line.CostUSD == nil {
		return "—"
	}
	text := fmt.Sprintf("%.4f", *line.CostUSD)
	if *line.CostUSD > 0 && *line.CostUSD < 0.0001 {
		text = "<0.0001"
	}
	if line.UnpricedRequests > 0 {
		text += "+"
	}
	return text
}
