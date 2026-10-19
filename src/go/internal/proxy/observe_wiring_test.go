// Every loopback request path must report the same three numbers — in-flight,
// latency, failovers — and must share one set of listener limits. These tests
// exist because each path had its own shape before, and "which paths are
// instrumented" was a question nobody could answer without reading four files.
package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/observe"
)

// healthCounters decodes the one field /health added for observability. It is
// unauthenticated, so it must never carry anything but counts and durations.
type healthCounters struct {
	OK       bool                     `json:"ok"`
	Counters map[string]observe.Stats `json:"counters"`
}

func fetchHealth(t *testing.T, endpoint string) healthCounters {
	t.Helper()
	resp, err := http.Get(endpoint + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body healthCounters
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("/health did not decode: %v", err)
	}
	return body
}

// The recorder is what turns "a request happened" into "a request happened
// with this status". Defaulting to 200 is not cosmetic: a handler that writes
// a body without calling WriteHeader did commit 200, and a recorder that
// reports 0 files every one of those as an error.
func TestStatusRecorderDefaultsToTheCommittedOK(t *testing.T) {
	rec := NewStatusRecorder(httptest.NewRecorder())
	if got := rec.Status(); got != http.StatusOK {
		t.Errorf("initial status = %d, want 200", got)
	}
	rec.WriteHeader(http.StatusServiceUnavailable)
	if got := rec.Status(); got != http.StatusServiceUnavailable {
		t.Errorf("recorded status = %d, want 503", got)
	}
}

// ---- shared listener limits ----

func TestApplyServingLimitsInstallsEveryLoopbackDefault(t *testing.T) {
	srv := ApplyServingLimits(&http.Server{})
	if srv.ReadHeaderTimeout != DefaultReadHeaderTimeout {
		t.Errorf("ReadHeaderTimeout = %s, want %s", srv.ReadHeaderTimeout, DefaultReadHeaderTimeout)
	}
	if srv.IdleTimeout != DefaultIdleTimeout {
		t.Errorf("IdleTimeout = %s, want %s", srv.IdleTimeout, DefaultIdleTimeout)
	}
	if srv.MaxHeaderBytes != DefaultMaxHeaderBytes {
		t.Errorf("MaxHeaderBytes = %d, want %d", srv.MaxHeaderBytes, DefaultMaxHeaderBytes)
	}
	// No WriteTimeout: these servers exist to stream, and a write deadline
	// would truncate a valid long stream.
	if srv.WriteTimeout != 0 {
		t.Errorf("WriteTimeout = %s, want 0 (streams are bounded by the request context)", srv.WriteTimeout)
	}
}

func TestApplyServingLimitsKeepsAnExplicitChoice(t *testing.T) {
	srv := ApplyServingLimits(&http.Server{IdleTimeout: 30 * time.Second})
	if srv.IdleTimeout != 30*time.Second {
		t.Errorf("IdleTimeout = %s, want the caller's 30s", srv.IdleTimeout)
	}
	if ApplyServingLimits(nil) != nil {
		t.Error("nil server should stay nil, not panic")
	}
}

// ---- path 1: single-account proxy ----

func TestSingleProxyCountsItsServedRequests(t *testing.T) {
	up := newUpstreamProbe(t)
	s := newTestServer(t, up.url)

	before := observe.Default.Snapshot()[observe.RouteSingle]
	resp := poolGet(t, s.Endpoint, s.Token, "/v1/chat/completions")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("served request = %d, want 200", resp.StatusCode)
	}
	after := observe.Default.Snapshot()[observe.RouteSingle]
	// Streaming headers can reach the client before the handler's deferred
	// counter update runs. Wait for that completion before asserting its delta.
	deadline := time.Now().Add(2 * time.Second)
	for after.Completed == before.Completed && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
		after = observe.Default.Snapshot()[observe.RouteSingle]
	}

	if delta := after.Started - before.Started; delta != 1 {
		t.Errorf("started delta = %d, want 1: the single-account path is not counted", delta)
	}
	if delta := after.Completed - before.Completed; delta != 1 {
		t.Errorf("completed delta = %d, want 1: a request that never ends leaks the in-flight gauge", delta)
	}
	if after.InFlight < 0 {
		t.Errorf("inFlight = %d, want >= 0", after.InFlight)
	}
	if after.ByStatus["200"] <= before.ByStatus["200"] {
		t.Errorf("byStatus = %v, want a 200 recorded", after.ByStatus)
	}
}

func TestSingleProxyHealthReportsCounters(t *testing.T) {
	up := newUpstreamProbe(t)
	s := newTestServer(t, up.url)
	_ = poolGet(t, s.Endpoint, s.Token, "/v1/chat/completions")

	body := fetchHealth(t, s.Endpoint)
	if !body.OK {
		t.Error("/health stopped saying ok")
	}
	st, ok := body.Counters[observe.RouteSingle]
	if !ok {
		t.Fatalf("/health counters = %v, want a %q row", body.Counters, observe.RouteSingle)
	}
	if st.Started == 0 || st.Completed == 0 {
		t.Errorf("counters[%q] = %+v, want a served request", observe.RouteSingle, st)
	}
}

// ---- path 2: standalone pool ring ----

func TestPoolRingCountsFailovers(t *testing.T) {
	upA := newStubUpstream(t, 200)
	upB := newStubUpstream(t, 200)
	upA.status.Store(429)
	upA.body = `{"error":{"message":"Your account has run out of quota"}}`

	server, token := newTestPool(t, mustNewInstanceID(t), []string{"a", "b"},
		mapResolver{
			"a": {BaseURL: upA.url, Auth: "upstream-secret-a"},
			"b": {BaseURL: upB.url, Auth: "upstream-secret-b"},
		}, filepath.Join(t.TempDir(), "quota-guard.json"), "failover")

	before := observe.Default.Snapshot()
	resp := poolGet(t, server.Endpoint(), token, "/v1/chat/completions")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("failover did not reach a healthy member: %d", resp.StatusCode)
	}
	after := observe.Default.Snapshot()

	if delta := after[observe.RoutePool].Failovers - before[observe.RoutePool].Failovers; delta != 1 {
		t.Errorf("failovers delta = %d, want exactly 1 — the number that tells you a member is burning", delta)
	}
	// The hub-delegated row must stay separate: a directly served request is
	// not a hub request, and mixing them makes both numbers unreadable.
	if delta := after[observe.RoutePoolHub].Started - before[observe.RoutePoolHub].Started; delta != 0 {
		t.Errorf("hub-delegated route moved by %d on a direct pool request, want 0", delta)
	}
}

func TestPoolHealthReportsCounters(t *testing.T) {
	upA := newStubUpstream(t, 200)
	server, token := newTestPool(t, mustNewInstanceID(t), []string{"a"},
		mapResolver{"a": {BaseURL: upA.url, Auth: "upstream-secret-a"}},
		filepath.Join(t.TempDir(), "quota-guard.json"), "failover")
	_ = poolGet(t, server.Endpoint(), token, "/v1/chat/completions")

	body := fetchHealth(t, server.Endpoint())
	st, ok := body.Counters[observe.RoutePool]
	if !ok {
		t.Fatalf("/health counters = %v, want a %q row", body.Counters, observe.RoutePool)
	}
	if st.Completed == 0 {
		t.Errorf("counters[%q] = %+v, want a served request", observe.RoutePool, st)
	}
}

// ---- path 4: the same ring reached through the hub ----

func TestServeAuthorizedCountsOnItsOwnRoute(t *testing.T) {
	upA := newStubUpstream(t, 200)
	server, _ := newTestPool(t, mustNewInstanceID(t), []string{"a"},
		mapResolver{"a": {BaseURL: upA.url, Auth: "upstream-secret-a"}},
		filepath.Join(t.TempDir(), "quota-guard.json"), "failover")

	before := observe.Default.Snapshot()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"m"}`))
	server.ServeAuthorized(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("ServeAuthorized = %d, want 200", rec.Code)
	}
	after := observe.Default.Snapshot()

	if delta := after[observe.RoutePoolHub].Completed - before[observe.RoutePoolHub].Completed; delta != 1 {
		t.Errorf("hub-delegated completed delta = %d, want 1", delta)
	}
	if delta := after[observe.RoutePool].Completed - before[observe.RoutePool].Completed; delta != 0 {
		t.Errorf("standalone pool row moved by %d on a hub-delegated request, want 0", delta)
	}
}
