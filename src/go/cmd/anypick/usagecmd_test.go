package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/usagelog"
)

func runUsage(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var code int
	restore := resetGlobals()
	defer restore()
	out, errOut := captureBoth(t, func() { code = run(append([]string{"usage"}, args...)) })
	return code, out, errOut
}

func TestUsageCommandSummarisesAndPricesRecordedEvents(t *testing.T) {
	isolateEnv(t)
	// First run migrates the isolated data directory and finds nothing.
	if code, out, errOut := runUsage(t); code != 0 || !strings.Contains(out, "No requests recorded") {
		t.Fatalf("empty usage = %d %q %q", code, out, errOut)
	}

	a, closeApp, err := appReadyForTest()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	if err := usagelog.Insert(context.Background(), a.DB, []usagelog.Event{
		{At: now, Route: "hub", Provider: "claude", Account: "work", Model: "claude-opus-5-5", Status: 200,
			InputTokens: 1_000_000, OutputTokens: 100_000, Reported: true},
		{At: now, Route: "hub", Provider: "glm", Account: "cn", Model: "glm-4.7", Status: 200,
			InputTokens: 10, OutputTokens: 5, Reported: true},
	}); err != nil {
		t.Fatal(err)
	}
	closeApp()

	code, out, errOut := runUsage(t, "--by", "account", "--json")
	if code != 0 {
		t.Fatalf("usage --json = %d %q", code, errOut)
	}
	var summary usagelog.Summary
	if err := json.Unmarshal([]byte(out), &summary); err != nil {
		t.Fatalf("usage --json is not JSON: %v\n%s", err, out)
	}
	if !summary.Estimate || summary.PricesAsOf == "" {
		t.Fatalf("summary does not carry its estimate label and date: %+v", summary)
	}
	if summary.Total.Requests != 2 || summary.Total.UnpricedRequests != 1 {
		t.Fatalf("total = %+v", summary.Total)
	}
	// 1M input at $4 + 100k output at $20/M = $6; glm has no listed price.
	if summary.Total.CostUSD == nil || *summary.Total.CostUSD < 5.999 || *summary.Total.CostUSD > 6.001 {
		t.Fatalf("total cost = %v, want 6 for the priced model only", summary.Total.CostUSD)
	}
	keys := map[string]bool{}
	for _, line := range summary.Lines {
		keys[line.Key] = true
	}
	if !keys["claude/work"] || !keys["glm/cn"] {
		t.Fatalf("lines = %+v", summary.Lines)
	}

	if code, _, _ := runUsage(t, "--by", "nonsense"); code == 0 {
		t.Fatal("an unknown --by was accepted")
	}
}
