package hub

import "testing"

// soonest-reset leads with the source whose quota resets first; sources with
// no reading keep failover order after it, so an empty cache is failover.
func TestHubSoonestResetOrdersSourcesByReset(t *testing.T) {
	cfg := &Config{Strategy: StrategySoonestReset, Sources: []Source{
		{ProviderID: "codex", Account: "a"},
		{ProviderID: "codex", Account: "b"},
		{ProviderID: "codex", Account: "c"},
	}}
	resets := map[string]int64{"b": 500, "c": 100}
	srv := &Server{NextReset: func(_, account string) int64 { return resets[account] }}
	got := srv.candidateChain(cfg, 0, "gpt-test")
	if len(got) != 3 || got[0] != 2 || got[1] != 1 || got[2] != 0 {
		t.Fatalf("chain = %v, want [2 1 0] (c, b, then a with no reading)", got)
	}
	srv.NextReset = func(string, string) int64 { return 0 }
	if got := srv.candidateChain(cfg, 0, "gpt-test"); got[0] != 0 {
		t.Fatalf("with no readings the chain = %v, want failover order", got)
	}
}

func TestHubAcceptsTheSoonestResetStrategy(t *testing.T) {
	st := newHubStore(t)
	cfg, err := st.UpsertConfigContext(t.Context(), Config{Name: "default", Enabled: true, Strategy: StrategySoonestReset, Sources: []Source{}})
	if err != nil {
		t.Fatal(err)
	}
	got, err := st.GetConfigContext(t.Context(), "default")
	if err != nil || got == nil || got.Strategy != StrategySoonestReset {
		t.Fatalf("stored strategy = %+v, %v (upserted %q)", got, err, cfg.Strategy)
	}
}
