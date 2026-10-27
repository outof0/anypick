package proxy

import (
	"path/filepath"
	"testing"
)

// The ring starts at the member the reset order names first, and still fails
// over inside one request when that member is out of quota.
func TestPoolSoonestResetStartsAtTheSoonestReset(t *testing.T) {
	upA := newStubUpstream(t, 200)
	upB := newStubUpstream(t, 200)
	upC := newStubUpstream(t, 200)
	server, token := newTestPool(t, mustNewInstanceID(t), []string{"a", "b", "c"},
		mapResolver{
			"a": {BaseURL: upA.url, Auth: "upstream-secret-a"},
			"b": {BaseURL: upB.url, Auth: "upstream-secret-b"},
			"c": {BaseURL: upC.url, Auth: "upstream-secret-c"},
		}, filepath.Join(t.TempDir(), "quota-guard.json"), "soonest-reset")
	server.ResetOrder = func([]string) []string { return []string{"c", "a", "b"} }

	for i := 0; i < 2; i++ {
		if resp := poolGet(t, server.Endpoint(), token, "/v1/chat/completions"); resp.StatusCode != 200 {
			t.Fatalf("request %d status = %d", i, resp.StatusCode)
		}
	}
	if got := []int{upA.hitCount(), upB.hitCount(), upC.hitCount()}; got[2] != 2 || got[0]+got[1] != 0 {
		t.Fatalf("hits [a b c] = %v, want every request on c", got)
	}
}

func TestPoolSoonestResetStillFailsOver(t *testing.T) {
	upA := newStubUpstream(t, 200)
	upC := newStubUpstream(t, 402)
	server, token := newTestPool(t, mustNewInstanceID(t), []string{"a", "c"},
		mapResolver{
			"a": {BaseURL: upA.url, Auth: "upstream-secret-a"},
			"c": {BaseURL: upC.url, Auth: "upstream-secret-c"},
		}, filepath.Join(t.TempDir(), "quota-guard.json"), "soonest-reset")
	server.ResetOrder = func([]string) []string { return []string{"c", "a"} }
	if resp := poolGet(t, server.Endpoint(), token, "/v1/chat/completions"); resp.StatusCode != 200 {
		t.Fatalf("a quota failure on the first member did not fail over: %d", resp.StatusCode)
	}
	if upC.hitCount() != 1 || upA.hitCount() != 1 {
		t.Fatalf("hits c=%d a=%d, want c then a", upC.hitCount(), upA.hitCount())
	}
}

// With no ordering (an empty cache), soonest-reset is failover order.
func TestPoolSoonestResetWithoutReadingsIsFailover(t *testing.T) {
	upA := newStubUpstream(t, 200)
	upB := newStubUpstream(t, 200)
	server, token := newTestPool(t, mustNewInstanceID(t), []string{"a", "b"},
		mapResolver{
			"a": {BaseURL: upA.url, Auth: "upstream-secret-a"},
			"b": {BaseURL: upB.url, Auth: "upstream-secret-b"},
		}, filepath.Join(t.TempDir(), "quota-guard.json"), "soonest-reset")
	if resp := poolGet(t, server.Endpoint(), token, "/v1/chat/completions"); resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if upA.hitCount() != 1 || upB.hitCount() != 0 {
		t.Fatalf("hits a=%d b=%d, want the first member", upA.hitCount(), upB.hitCount())
	}
}
