package quotacache

import (
	"strings"
	"testing"
)

func at(ms int64) *float64 { v := float64(ms); return &v }

func TestNextResetIgnoresWhatCannotBeSpent(t *testing.T) {
	now := int64(1_000_000_000)
	entry := Entry{FetchedAtMs: now - 1000, Windows: []Window{
		{RemainingPercent: 0, ResetsAtMs: at(now + 10)},    // exhausted: the guard's job
		{RemainingPercent: 50, ResetsAtMs: at(now - 5)},    // already reset
		{RemainingPercent: 30, ResetsAtMs: at(now + 9000)}, // the one that counts
		{RemainingPercent: 80, ResetsAtMs: at(now + 50000)},
		{RemainingPercent: 80}, // no reset time
	}}
	if got := NextReset(entry, now); got != now+9000 {
		t.Fatalf("NextReset = %d, want %d", got, now+9000)
	}
	stale := entry
	stale.FetchedAtMs = now - MaxAgeMs - 1
	if got := NextReset(stale, now); got != 0 {
		t.Fatalf("a stale reading steered routing: %d", got)
	}
	if got := NextReset(Entry{}, now); got != 0 {
		t.Fatalf("an empty reading = %d, want 0", got)
	}
}

func TestOrderBySoonestResetKeepsUnknownsInFailoverOrder(t *testing.T) {
	now := int64(1_000_000_000)
	f := File{Accounts: map[string]Entry{
		"late":  {FetchedAtMs: now, Windows: []Window{{RemainingPercent: 10, ResetsAtMs: at(now + 900)}}},
		"early": {FetchedAtMs: now, Windows: []Window{{RemainingPercent: 10, ResetsAtMs: at(now + 100)}}},
	}}
	got := OrderBySoonestReset([]string{"x", "late", "y", "early"}, f, now)
	if strings.Join(got, ",") != "early,late,x,y" {
		t.Fatalf("order = %v, want early,late,x,y", got)
	}
	// Nothing known is plain failover order.
	if got := OrderBySoonestReset([]string{"b", "a"}, File{}, now); strings.Join(got, ",") != "b,a" {
		t.Fatalf("empty cache reordered: %v", got)
	}
}

func TestPutLoadForgetRoundTrip(t *testing.T) {
	root := t.TempDir()
	if f := Load(root, "codex"); len(f.Accounts) != 0 {
		t.Fatalf("missing file loaded %v", f.Accounts)
	}
	if err := Put(root, "codex", "work", Entry{FetchedAtMs: 7, Windows: []Window{{RemainingPercent: 40}}}); err != nil {
		t.Fatal(err)
	}
	if err := Put(root, "codex", "home", Entry{FetchedAtMs: 8}); err != nil {
		t.Fatal(err)
	}
	f := Load(root, "codex")
	if f.Accounts["work"].FetchedAtMs != 7 || f.Accounts["home"].FetchedAtMs != 8 {
		t.Fatalf("loaded %+v", f.Accounts)
	}
	if err := Forget(root, "codex", "work"); err != nil {
		t.Fatal(err)
	}
	if _, ok := Load(root, "codex").Accounts["work"]; ok {
		t.Fatal("forgotten account still loaded")
	}
}
