package hub

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/usagelog"
)

// stubVendor records the model each request named and answers with status.
type stubVendor struct {
	mu     sync.Mutex
	models []string
	srv    *httptest.Server
}

func newStubVendor(t *testing.T, status int, body string) *stubVendor {
	t.Helper()
	v := &stubVendor{}
	v.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var probe struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(raw, &probe)
		v.mu.Lock()
		v.models = append(v.models, probe.Model)
		v.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(v.srv.Close)
	return v
}

func (v *stubVendor) seen() []string {
	v.mu.Lock()
	defer v.mu.Unlock()
	return append([]string(nil), v.models...)
}

type stubResolver map[string]*stubVendor

func (r stubResolver) ResolveUpstream(_ context.Context, providerID, account string) (*proxy.Upstream, error) {
	v := r[providerID+"/"+account]
	base, _ := url.Parse(v.srv.URL + "/v1")
	return &proxy.Upstream{BaseURL: base, Auth: "upstream-key"}, nil
}

func startComboHub(t *testing.T, resolver stubResolver, combos []Combo, models map[string][]string) (*Server, string) {
	t.Helper()
	st := newHubStore(t)
	seedHubAccounts(t, st, "glm/cn", "deepseek/work")
	ctx := context.Background()
	cfg, err := st.UpsertConfigContext(ctx, Config{
		Name: "default", Enabled: true, Combos: combos,
		Sources: []Source{{ProviderID: "glm", Account: "cn"}, {ProviderID: "deepseek", Account: "work"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := NewService(st).EnsureHubTokenContext(ctx, "default")
	if err != nil {
		t.Fatal(err)
	}
	srv := &Server{Config: cfg, Store: NewService(st), Resolver: resolver}
	if models != nil {
		srv.ModelsForProvider = func(p string) []string { return models[p] }
	}
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Stop() })
	return srv, token
}

func hubPost(t *testing.T, srv *Server, token, model string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, srv.Endpoint()+"/v1/chat/completions",
		strings.NewReader(`{"model":"`+model+`","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(raw)
}

// A combo walks its steps under each step's own model id, and moves on when a
// step is out of quota.
func TestComboWalksStepsWithEachStepsModel(t *testing.T) {
	glm := newStubVendor(t, 402, `{"error":{"message":"insufficient balance"}}`)
	deepseek := newStubVendor(t, 200, `{"id":"x","object":"chat.completion","choices":[]}`)
	srv, token := startComboHub(t, stubResolver{"glm/cn": glm, "deepseek/work": deepseek}, []Combo{{
		Name: "smart", Steps: []ComboStep{
			{Provider: "glm", Account: "cn", Model: "glm-4.7"},
			{Provider: "deepseek", Account: "work", Model: "deepseek-chat"},
		},
	}}, nil)

	status, body := hubPost(t, srv, token, "smart")
	if status != http.StatusOK {
		t.Fatalf("combo request = %d %s", status, body)
	}
	if got := glm.seen(); len(got) != 1 || got[0] != "glm-4.7" {
		t.Fatalf("first step saw %v, want [glm-4.7]", got)
	}
	if got := deepseek.seen(); len(got) != 1 || got[0] != "deepseek-chat" {
		t.Fatalf("second step saw %v, want [deepseek-chat]", got)
	}
}

// Only a quota refusal moves the walk on: a request the vendor rejects as
// malformed is the client's answer, not a reason to try the next step.
func TestComboStopsOnANonQuotaRefusal(t *testing.T) {
	glm := newStubVendor(t, 400, `{"error":{"message":"bad request"}}`)
	deepseek := newStubVendor(t, 200, `{}`)
	srv, token := startComboHub(t, stubResolver{"glm/cn": glm, "deepseek/work": deepseek}, []Combo{{
		Name: "smart", Steps: []ComboStep{
			{Provider: "glm", Account: "cn", Model: "glm-4.7"},
			{Provider: "deepseek", Account: "work", Model: "deepseek-chat"},
		},
	}}, nil)
	if status, _ := hubPost(t, srv, token, "smart"); status != http.StatusBadRequest {
		t.Fatalf("status = %d, want the first step's 400", status)
	}
	if len(deepseek.seen()) != 0 {
		t.Fatal("a non-quota refusal moved on to the next step")
	}
}

// The hub lists what it can route: combos, and ids exactly one provider
// publishes. An id two providers publish stays out until it is pinned.
func TestHubAnswersModelsWithCombosAndSingleOwnerIDs(t *testing.T) {
	glm := newStubVendor(t, 200, `{}`)
	deepseek := newStubVendor(t, 200, `{}`)
	srv, token := startComboHub(t, stubResolver{"glm/cn": glm, "deepseek/work": deepseek},
		[]Combo{{Name: "smart", Steps: []ComboStep{{Provider: "glm", Account: "cn", Model: "glm-4.7"}}}},
		map[string][]string{"glm": {"glm-4.7", "shared"}, "deepseek": {"deepseek-chat", "shared"}})

	req, _ := http.NewRequest(http.MethodGet, srv.Endpoint()+"/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var list struct {
		Data []struct {
			ID      string `json:"id"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	ids := map[string]string{}
	for _, m := range list.Data {
		ids[m.ID] = m.OwnedBy
	}
	if ids["smart"] != "anypick-combo" || ids["glm-4.7"] != "glm" || ids["deepseek-chat"] != "deepseek" {
		t.Fatalf("models = %v", ids)
	}
	if _, ok := ids["shared"]; ok {
		t.Fatal("an id two providers publish was listed without a pin")
	}
	if len(glm.seen())+len(deepseek.seen()) != 0 {
		t.Fatal("the model list was forwarded upstream instead of answered by the hub")
	}
}

// With no catalog known, the hub forwards the listing as it did before it had
// one, rather than answering with its combos alone and hiding every vendor
// model.
func TestHubForwardsTheModelListWhenItKnowsNoCatalog(t *testing.T) {
	glm := newStubVendor(t, 200, `{"object":"list","data":[{"id":"glm-4.7"}]}`)
	deepseek := newStubVendor(t, 200, `{}`)
	srv, token := startComboHub(t, stubResolver{"glm/cn": glm, "deepseek/work": deepseek},
		[]Combo{{Name: "smart", Steps: []ComboStep{{Provider: "glm", Account: "cn", Model: "glm-4.7"}}}}, nil)
	req, _ := http.NewRequest(http.MethodGet, srv.Endpoint()+"/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(raw), "glm-4.7") || len(glm.seen()) != 1 {
		t.Fatalf("listing = %s (upstream saw %d), want it forwarded to the default source", raw, len(glm.seen()))
	}
}

func TestValidateCombo(t *testing.T) {
	cfg := Config{Name: "default", Sources: []Source{{ProviderID: "glm", Account: "cn"}}}
	good := Combo{Name: "smart", Steps: []ComboStep{{Provider: "glm", Account: "cn", Model: "glm-4.7"}}}
	if err := ValidateCombo(cfg, good, nil); err != nil {
		t.Fatalf("a valid combo was refused: %v", err)
	}
	for name, combo := range map[string]Combo{
		"index-looking name": {Name: "#1", Steps: good.Steps},
		"empty name":         {Name: "", Steps: good.Steps},
		"no steps":           {Name: "smart"},
		"unknown source":     {Name: "smart", Steps: []ComboStep{{Provider: "glm", Account: "other", Model: "x"}}},
		"no model":           {Name: "smart", Steps: []ComboStep{{Provider: "glm", Account: "cn"}}},
	} {
		if err := ValidateCombo(cfg, combo, nil); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if err := ValidateCombo(cfg, good, []string{"smart"}); err == nil {
		t.Error("a combo shadowing a pinned model was accepted")
	}
}

func TestCombosPersistAndBumpTheRevision(t *testing.T) {
	st := newHubStore(t)
	seedHubAccounts(t, st, "glm/cn")
	ctx := context.Background()
	first, err := st.UpsertConfigContext(ctx, Config{Name: "default", Enabled: true,
		Sources: []Source{{ProviderID: "glm", Account: "cn"}}})
	if err != nil {
		t.Fatal(err)
	}
	first.Combos = []Combo{{Name: "smart", Steps: []ComboStep{{Provider: "glm", Account: "cn", Model: "glm-4.7"}}}}
	saved, err := st.UpsertConfigContext(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Revision <= first.Revision {
		t.Fatalf("revision %d did not move past %d: a running hub would not restart onto the combo", saved.Revision, first.Revision)
	}
	got, err := st.GetConfigContext(ctx, "default")
	if err != nil || got == nil || got.ComboNamed("smart") == nil || got.ComboNamed("smart").Steps[0].Model != "glm-4.7" {
		t.Fatalf("stored combos = %+v, %v", got, err)
	}
}

// Usage is recorded once, against the step that served: a step refused for
// quota never reached the client and spent nothing worth counting.
func TestComboRecordsUsageForTheServingStepOnly(t *testing.T) {
	var got []usagelog.Event
	proxy.SetUsageRecorder(func(e usagelog.Event) { got = append(got, e) })
	t.Cleanup(func() { proxy.SetUsageRecorder(nil) })

	glm := newStubVendor(t, 402, `{"error":{"message":"insufficient balance"}}`)
	deepseek := newStubVendor(t, 200, `{"model":"deepseek-chat","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4}}`)
	srv, token := startComboHub(t, stubResolver{"glm/cn": glm, "deepseek/work": deepseek}, []Combo{{
		Name: "smart", Steps: []ComboStep{
			{Provider: "glm", Account: "cn", Model: "glm-4.7"},
			{Provider: "deepseek", Account: "work", Model: "deepseek-chat"},
		},
	}}, nil)
	if status, body := hubPost(t, srv, token, "smart"); status != http.StatusOK {
		t.Fatalf("combo request = %d %s", status, body)
	}
	if len(got) != 1 {
		t.Fatalf("recorded %d events, want 1: %+v", len(got), got)
	}
	e := got[0]
	if e.Provider != "deepseek" || e.Account != "work" || e.Model != "deepseek-chat" || e.InputTokens != 11 || e.OutputTokens != 4 {
		t.Fatalf("event = %+v", e)
	}
}
