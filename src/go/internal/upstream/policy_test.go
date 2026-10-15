package upstream

// Contract tests for the quota-guard and failure classification.
// State-file shapes are contractual: the file persists across restarts, so
// field names and the version literal must not drift.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func headerOf(headers map[string]string) func(string) string {
	return func(name string) string { return headers[name] }
}

func TestIsInsufficientBalanceFailureNarrowness(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   bool
	}{
		{402, `{"error":{"message":"insufficient_account_balance"}}`, true},
		{403, "Account balance is insufficient for this request.", true},
		{403, "Your account has insufficient balance. Top up to continue", true},
		{403, "balance depleted for this billing cycle", true},
		{403, "policy violation: disallowed model", false},
		{402, "some other payment error", false},
		{429, "insufficient balance", false},
	}
	for _, tc := range cases {
		if got := IsInsufficientBalanceFailure(tc.status, tc.body); got != tc.want {
			t.Fatalf("IsInsufficientBalance(%d,%q)=%v want %v", tc.status, tc.body, got, tc.want)
		}
	}
}

func TestIsCredentialQuotaFailureAttribution(t *testing.T) {
	cases := []struct {
		status  int
		headers map[string]string
		body    string
		want    bool
	}{
		{429, nil, `{"error":"Resource exhausted: quota exceeded for API key"}`, true},
		{429, nil, "billing quota exhausted for this project", true},
		{402, nil, "account balance exhausted", true},
		{429, map[string]string{"x-goog-api-client": "freeusagelimit"}, "", false},
		{429, nil, "rate limit per minute reached from this ip address", false},
		{429, nil, "generic rate limit hit", false},
	}
	for _, tc := range cases {
		if got := IsCredentialQuotaFailure(tc.status, headerOf(tc.headers), tc.body); got != tc.want {
			t.Fatalf("IsCredentialQuotaFailure(%d,%q)=%v want %v", tc.status, tc.body, got, tc.want)
		}
	}
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	if v := ParseRetryAfter("", now); v != nil {
		t.Fatalf("empty: %v", v)
	}
	if v := ParseRetryAfter("30", now); v == nil || *v != 30000 {
		t.Fatalf("delta seconds: %v", v)
	}
	if v := ParseRetryAfter("-5", now); v != nil {
		t.Fatalf("negative must be undefined: %v", v)
	}
	future := now.Add(2 * time.Minute).UTC().Format("Mon, 02 Jan 2006 15:04:05 GMT")
	if v := ParseRetryAfter(future, now); v == nil || *v < 119000 || *v > 121000 {
		t.Fatalf("http date: %v", v)
	}
	past := now.Add(-time.Minute).UTC().Format("Mon, 02 Jan 2006 15:04:05 GMT")
	if v := ParseRetryAfter(past, now); v != nil {
		t.Fatalf("past date must be undefined: %v", v)
	}
}

func TestClassifyUpstreamFailure(t *testing.T) {
	now := time.Now()
	got := ClassifyUpstreamFailure(503, headerOf(nil), "", now)
	if got.Kind != KindTransient || got.Scope != ScopeUnknown {
		t.Fatalf("503 = %+v", got)
	}
	got = ClassifyUpstreamFailure(500, headerOf(nil), "", now)
	if got.Kind != KindServer {
		t.Fatalf("500 = %+v", got)
	}
	got = ClassifyUpstreamFailure(403, headerOf(nil), "", now)
	if got.Kind != KindAuth || got.Scope != ScopeCredential {
		t.Fatalf("403 = %+v", got)
	}
	got = ClassifyUpstreamFailure(418, headerOf(nil), "", now)
	if got.Kind != KindPermanent {
		t.Fatalf("418 = %+v", got)
	}
}

func TestCooldownRegistry(t *testing.T) {
	base := time.UnixMilli(1000)
	clock := base
	c := NewCooldownRegistry(func() time.Time { return clock })
	c.Set("a", 500*time.Millisecond)
	if c.Remaining("a") <= 0 || c.Size() != 1 {
		t.Fatalf("remaining=%v size=%d", c.Remaining("a"), c.Size())
	}
	clock = base.Add(600 * time.Millisecond)
	if c.Remaining("a") != 0 || c.Size() != 0 {
		t.Fatalf("expired entry not pruned: %v %d", c.Remaining("a"), c.Size())
	}
	c.Set("b", -1*time.Second) // non-positive delays are ignored
	if c.Size() != 0 {
		t.Fatal("non-positive delay stored")
	}
}

type namedCandidate struct{ name string }

func (n namedCandidate) GetAccountName() string { return n.name }

func TestGuardOrderingAndPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	now := int64(1_000_000)
	g := NewGuard(GuardOptions{Enabled: true, CooldownMs: 60_000, StatePath: path, ProviderID: "zai"})
	g.SetClock(func() int64 { return now })

	ring := []Candidate{
		namedCandidate{"alpha"},
		namedCandidate{"beta"},
		namedCandidate{"gamma"},
	}

	// Disabled or singleton rings never reorder.
	if got, err := g.Ordered(ring[:1]); err != nil || len(got) != 1 {
		t.Fatalf("singleton ring: %v %v", got, err)
	}

	ordered, err := g.Ordered(ring)
	if err != nil || len(ordered) != 3 || ordered[0].GetAccountName() != "alpha" {
		t.Fatalf("initial order: %v %v", ordered, err)
	}

	// alpha exhausts; beta takes over; alpha cools down.
	if err := g.Exhausted("alpha", "beta", nil); err != nil {
		t.Fatal(err)
	}
	ordered, err = g.Ordered(ring)
	if err != nil || len(ordered) != 2 || ordered[0].GetAccountName() != "beta" ||
		ordered[1].GetAccountName() != "gamma" {
		t.Fatalf("after exhaustion (cooling skipped): %v %v", ordered, err)
	}

	// A new guard over the same state file keeps the cooldown across restarts.
	g2 := NewGuard(GuardOptions{Enabled: true, CooldownMs: 60_000, StatePath: path})
	g2.SetClock(func() int64 { return now })
	ordered2, oerr := g2.Ordered(ring)
	if oerr != nil || len(ordered2) != 2 || ordered2[0].GetAccountName() != "beta" {
		t.Fatalf("state not durable across restarts: %v %v", ordered2, oerr)
	}

	// After the cooldown lapses the full ring returns, active head kept.
	g2.SetClock(func() int64 { return now + 61_000 })
	ordered3, oerr := g2.Ordered(ring)
	if oerr != nil || len(ordered3) != 3 || ordered3[0].GetAccountName() != "beta" {
		t.Fatalf("post-cooldown order: %v %v", ordered3, oerr)
	}

	// Audit events are capped and shaped like QuotaGuardEvent.
	state, rerr := ReadState(path)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if state.Version != 1 || len(state.Events) != 1 || state.ActiveAccount != "beta" {
		t.Fatalf("state = %+v", state)
	}
	ev := state.Events[0]
	if ev.From != "alpha" || ev.To != "beta" || ev.ProviderID != "zai" || ev.CooldownUntil <= now {
		t.Fatalf("event = %+v", ev)
	}
	raw, _ := json.Marshal(state)
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	if _, ok := doc["cooling"]; !ok || doc["version"] != float64(1) {
		t.Fatalf("TS shape drift: %s", raw)
	}
}

func TestGuardAllCoolingReturnsNil(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	now := int64(1_000_000)
	g := NewGuard(GuardOptions{Enabled: true, CooldownMs: 60_000, StatePath: path})
	g.SetClock(func() int64 { return now })
	ring := []Candidate{namedCandidate{"a"}, namedCandidate{"b"}}
	if err := g.Exhausted("a", "b", nil); err != nil {
		t.Fatal(err)
	}
	if err := g.Exhausted("b", "", nil); err != nil {
		t.Fatal(err)
	}
	got, err := g.Ordered(ring)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("all cooling must yield empty ordering: %+v", got)
	}
}

func TestNormalizeStateFiltersGarbage(t *testing.T) {
	if s := NormalizeState([]byte(`not json`)); s.Version != 1 || len(s.Cooling) != 0 {
		t.Fatalf("corrupt document must degrade: %+v", s)
	}
	long := make([]byte, 200)
	for i := range long {
		long[i] = 'x'
	}
	raw := []byte(`{"activeAccount":"acct","cooling":{"` + string(long) + `":5,"ok":10,"neg":-3},"events":[
		{"id":"e1","createdAt":"2026-01-01T00:00:00Z","from":"a","cooldownUntil":123},
		{"id":"","createdAt":"","from":""},
		"junk"]}`)
	s := NormalizeState(raw)
	if _, present := s.Cooling[string(long)]; present {
		t.Fatal("over-long account name accepted")
	}
	if s.Cooling["ok"] != 10 {
		if _, present := s.Cooling["ok"]; !present {
			t.Fatalf("valid cooling entry dropped: %+v", s.Cooling)
		}
	}
	if _, present := s.Cooling["neg"]; present {
		t.Fatal("non-positive deadline accepted")
	}
	if len(s.Events) != 1 || s.Events[0].ID != "e1" {
		t.Fatalf("event filtering failed: %+v", s.Events)
	}
}

func TestWriteStateAtomicOwnerOnly(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "state.json")
	state := EmptyState()
	state.ActiveAccount = "me"
	if err := WriteState(path, state); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		perm := info.Mode().Perm()
		t.Fatalf("permissions = %o, want 600", perm)
	}
	back, rerr := ReadState(path)
	if rerr != nil || back.ActiveAccount != "me" {
		t.Fatalf("round trip: %+v %v", back, rerr)
	}
}

func TestGuardRetryAfterClampSemantics(t *testing.T) {
	base := int64(1_000_000)
	mk := func() (*Guard, string) {
		path := filepath.Join(t.TempDir(), "state.json")
		g := NewGuard(GuardOptions{Enabled: true, CooldownMs: 3_600_000, StatePath: path})
		g.SetClock(func() int64 { return base })
		return g, path
	}
	cases := []struct {
		name         string
		retryAfter   *int64
		wantCooldown int64 // ms, relative to base
	}{
		{"absent falls back to configured", nil, 3_600_000},
		{"zero present clamps to 1s", int64Ptr(0), 1000},
		{"500ms clamps to 1s", int64Ptr(500), 1000},
		{"exactly 1s stays", int64Ptr(1000), 1000},
		{"larger honoured", int64Ptr(45_000), 45_000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g, path := mk()
			if err := g.Exhausted("acct", "", tc.retryAfter); err != nil {
				t.Fatal(err)
			}
			state, err := ReadState(path)
			if err != nil {
				t.Fatal(err)
			}
			until := state.Cooling["acct"]
			if got := until - base; got != tc.wantCooldown {
				t.Fatalf("cooldown = %dms, want %dms", got, tc.wantCooldown)
			}
		})
	}
}

func int64Ptr(v int64) *int64 { return &v }

// TestWorkbuddyCreditExhaustionPattern pins the 14018 classification end to
// end: the exact 429 body WorkBuddy's edge returns for an exhausted
// subscription must match the provider's declared patterns, so the pool ring
// rotates to another account instead of replaying the failure. The patterns
// are anchored to the JSON "code" field: a bare 14018 also matched
// "140182 tokens" in an unrelated error body and rotated a healthy account
// into cooldown (release-review Major).
func TestWorkbuddyCreditExhaustionPattern(t *testing.T) {
	body := `{"error":{"data":{"code":14018,"msg":"Credits exhausted, please upgrade your plan"}}}`
	patterns := []string{
		"quota", "balance", "insufficient", "billing",
		"frequency limit", "usage exceeds frequency limit",
		`"code":\s*"?6004"?`, `"code":\s*"?14018"?`,
	}
	if !MatchesQuotaErrorPattern(patterns, body) {
		t.Fatal("the workbuddy 429 credit-exhaustion body did not classify as a quota failure; the ring would replay it instead of rotating")
	}

	// The false positive the bare number caused: a token count containing the
	// digits 14018 must NOT read as credit exhaustion.
	if MatchesQuotaErrorPattern(patterns, `{"error":{"message":"140182 tokens remaining in this window"}}`) {
		t.Fatal("an unrelated body containing 140182 classified as credit exhaustion; the pattern is not anchored")
	}
	// The phrase shape must not be relied on: the case-sensitive matcher
	// misses the capitalised phrase, which is why the code carries the match.
	if MatchesQuotaErrorPattern([]string{"credits exhausted"}, body) {
		t.Fatal("case-sensitive match on a capitalised phrase succeeded; this test's premise is wrong")
	}
}
