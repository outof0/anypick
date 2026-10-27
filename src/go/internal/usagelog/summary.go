package usagelog

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/pricing"
)

// Group keys a summary can be grouped by.
var GroupBy = []string{"model", "account", "provider", "day"}

// ValidGroupBy reports whether by is one of GroupBy.
func ValidGroupBy(by string) bool {
	for _, g := range GroupBy {
		if g == by {
			return true
		}
	}
	return false
}

// Line is one group of a summary.
type Line struct {
	Key              string `json:"key"`
	Requests         int64  `json:"requests"`
	Unreported       int64  `json:"unreported"`
	InputTokens      int64  `json:"inputTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
	// CostUSD is the estimate for the priced requests in this group, or nil
	// when none of them is priced. UnpricedRequests says how many it leaves
	// out, so a partial sum is never read as the whole.
	CostUSD          *float64 `json:"costUSD"`
	UnpricedRequests int64    `json:"unpricedRequests"`
}

// Summary is usage since a time, grouped, with a dated estimate.
type Summary struct {
	Since      string `json:"since"`
	By         string `json:"by"`
	PricesAsOf string `json:"pricesAsOf"`
	// Estimate is always true; it is in the payload so a consumer that shows
	// the cost cannot miss that it is not a bill.
	Estimate   bool     `json:"estimate"`
	Overridden []string `json:"overriddenPrices,omitempty"`
	Lines      []Line   `json:"lines"`
	Total      Line     `json:"total"`
}

// Summarize groups rows by by and prices each (provider, account, model)
// group before it is merged, so a group mixing models is priced per model.
func Summarize(rows []Row, by string, since time.Time, prices *pricing.Table) Summary {
	out := Summary{Since: since.UTC().Format(time.RFC3339), By: by, Estimate: true, Lines: []Line{}}
	if prices != nil {
		out.PricesAsOf = prices.AsOf
		out.Overridden = prices.Overridden
	}
	lines := map[string]*Line{}
	out.Total.Key = "total"
	for _, r := range rows {
		key := r.Model
		switch by {
		case "account":
			key = r.Provider + "/" + r.Account
		case "provider":
			key = r.Provider
		case "day":
			key = r.Day
		}
		if key == "" {
			key = "(unknown)"
		}
		line := lines[key]
		if line == nil {
			line = &Line{Key: key}
			lines[key] = line
		}
		var cost *float64
		if price, ok := prices.Lookup(r.Model); ok {
			c := price.Cost(r.InputTokens, r.OutputTokens, r.CacheReadTokens, r.CacheWriteTokens)
			cost = &c
		}
		line.add(r, cost)
		out.Total.add(r, cost)
	}
	for _, line := range lines {
		out.Lines = append(out.Lines, *line)
	}
	sort.Slice(out.Lines, func(i, j int) bool {
		if by == "day" {
			return out.Lines[i].Key < out.Lines[j].Key
		}
		if out.Lines[i].Requests != out.Lines[j].Requests {
			return out.Lines[i].Requests > out.Lines[j].Requests
		}
		return out.Lines[i].Key < out.Lines[j].Key
	})
	return out
}

func (l *Line) add(r Row, cost *float64) {
	l.Requests += r.Requests
	l.Unreported += r.Unreported
	l.InputTokens += r.InputTokens
	l.OutputTokens += r.OutputTokens
	l.CacheReadTokens += r.CacheReadTokens
	l.CacheWriteTokens += r.CacheWriteTokens
	if cost == nil {
		l.UnpricedRequests += r.Requests
		return
	}
	if l.CostUSD == nil {
		l.CostUSD = new(float64)
	}
	*l.CostUSD += *cost
}

// ParseSince reads "7d", "24h", "90m" or a local date "2006-01-02" into the
// start of the window. It never reaches past Retention, which holds nothing.
func ParseSince(s string, now time.Time) (time.Time, error) {
	s = strings.TrimSpace(s)
	var since time.Time
	switch {
	case s == "":
		since = now.Add(-7 * 24 * time.Hour)
	case strings.HasSuffix(s, "d"):
		n, err := strconv.Atoi(strings.TrimSuffix(s, "d"))
		if err != nil || n <= 0 {
			return time.Time{}, fmt.Errorf("--since %q: want a positive day count like 7d", s)
		}
		since = now.Add(-time.Duration(n) * 24 * time.Hour)
	default:
		if d, err := time.ParseDuration(s); err == nil && d > 0 {
			since = now.Add(-d)
			break
		}
		t, err := time.ParseInLocation("2006-01-02", s, now.Location())
		if err != nil {
			return time.Time{}, fmt.Errorf("--since %q: want 7d, 24h, or a date like 2006-01-02", s)
		}
		since = t
	}
	if floor := now.Add(-Retention); since.Before(floor) {
		since = floor
	}
	return since, nil
}
