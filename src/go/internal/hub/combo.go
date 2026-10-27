package hub

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/observe"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/upstream"
)

// Combo is a model id the hub defines: an ordered fallback chain of steps
// (ADR-0036). A client requests it by name like any model.
type Combo struct {
	Name  string      `json:"name"`
	Steps []ComboStep `json:"steps"`
}

// ComboStep is one hop: a source already in the hub, and the model id it is
// sent. Account is "pool:<provider>" for a pool source.
type ComboStep struct {
	Provider string `json:"provider"`
	Account  string `json:"account"`
	Model    string `json:"model"`
}

// MaxComboSteps bounds a chain. Each step can cost a full upstream attempt
// inside one request's budget, so a long chain mostly measures timeouts.
const MaxComboSteps = 8

// comboNameRe admits the characters model ids use. "#" is excluded because
// "#N" already selects a source by index.
var comboNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$`)

// ComboNamed returns the combo called name, or nil.
func (c Config) ComboNamed(name string) *Combo {
	for i := range c.Combos {
		if c.Combos[i].Name == name {
			return &c.Combos[i]
		}
	}
	return nil
}

// ValidateCombo checks a combo against the hub it is saved into: a usable
// name, 1..MaxComboSteps steps, and every step naming a source in this hub
// with a model. pinned lists the route's pinned model ids, which a combo name
// must not shadow.
func ValidateCombo(cfg Config, combo Combo, pinned []string) error {
	invalid := func(msg string) error {
		return anyerr.Newf(msg, "INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	if !comboNameRe.MatchString(combo.Name) {
		return invalid("A combo name is 1-64 letters, digits or . _ : / @ + -, starting with a letter or digit.")
	}
	for _, model := range pinned {
		if model == combo.Name {
			return invalid("\"" + combo.Name + "\" is already a pinned model in this hub; pick a name no vendor uses.")
		}
	}
	if len(combo.Steps) == 0 || len(combo.Steps) > MaxComboSteps {
		return invalid(fmt.Sprintf("A combo needs between 1 and %d steps.", MaxComboSteps))
	}
	for i, step := range combo.Steps {
		if strings.TrimSpace(step.Model) == "" {
			return invalid(fmt.Sprintf("Step %d has no model.", i+1))
		}
		if comboStepSource(cfg, step) < 0 {
			return invalid(fmt.Sprintf("Step %d names %s/%s, which is not a source in hub %s.",
				i+1, step.Provider, step.Account, cfg.Name))
		}
	}
	return nil
}

// comboStepSource is the index of the hub source a step names, or -1.
func comboStepSource(cfg Config, step ComboStep) int {
	for i, src := range cfg.Sources {
		if src.ProviderID == step.Provider && src.Account == step.Account {
			return i
		}
	}
	return -1
}

// serveCombo walks a combo's steps (ADR-0036): each step sends the request to
// its source under its own model id, and the walk moves on only on a quota
// refusal or an unresolvable source.
func (s *Server) serveCombo(w http.ResponseWriter, r *http.Request, cfg *Config, combo *Combo, body []byte) {
	hops, refusal := s.comboHops(cfg, combo)
	if refusal != "" {
		status, code := http.StatusBadGateway, "upstream_error"
		if len(hops) == 0 && s.Quotas != nil && comboHasEnabledStep(cfg, combo) {
			status, code = http.StatusTooManyRequests, "quota_exhausted"
		}
		writeErr(w, status, code, refusal)
		return
	}

	deadline := time.Now().Add(s.chainBudget())
	var dead []string
	for i, h := range hops {
		last := i == len(hops)-1
		if last && time.Now().After(deadline) {
			writeErr(w, http.StatusGatewayTimeout, "upstream_timeout",
				"hub tried every step of combo "+combo.Name)
			return
		}
		attemptBody := body
		if rewritten, ok := rewriteModelField(body, h.step.Model); ok {
			attemptBody = rewritten
		}
		attempt := r.Clone(r.Context())
		attempt.Body = io.NopCloser(bytes.NewReader(attemptBody))
		attempt.ContentLength = int64(len(attemptBody))
		writer, patterns, skip := s.attemptComboStep(w, attempt, cfg, combo, h)
		if skip != "" {
			dead = append(dead, skip)
			continue
		}
		if writer.committedResponse() {
			if s.Quotas != nil {
				s.Quotas.clear(keyOf(*cfg, h.index))
			}
			return
		}
		if last || !isQuotaRefusal(writer.statusCode(), writer.headerValue, writer.bodyPreview(), patterns) {
			writer.replay()
			return
		}
		if s.Quotas != nil {
			retryAfter := upstream.ParseRetryAfter(writer.headerValue("Retry-After"), time.Now())
			s.Quotas.exhaust(keyOf(*cfg, h.index), retryAfter)
		}
	}
	writeErr(w, http.StatusBadGateway, "upstream_error",
		fmt.Sprintf("no step of combo %s could serve this request (%s)", combo.Name, strings.Join(dead, "; ")))
}

// attemptComboStep sends one step's request to its source through an attempt
// writer. A non-empty skip names a source that could not be reached, and the
// walk moves on without an attempt.
func (s *Server) attemptComboStep(w http.ResponseWriter, attempt *http.Request, cfg *Config, combo *Combo, h comboHop) (
	writer *attemptWriter, patterns []string, skip string,
) {
	src := cfg.Sources[h.index]
	if providerID, ok := poolSourceProvider(src); ok {
		if s.PoolRings == nil {
			return nil, nil, src.Account + ": pool sources are not served by this hub instance"
		}
		ring, rerr := s.PoolRings.ResolvePoolRing(attempt.Context(), providerID)
		if rerr != nil {
			return nil, nil, src.Account + ": " + rerr.Error()
		}
		// Through the same recorder as an account, so a ring that is out of
		// quota hands the request on instead of ending the walk. The ring
		// meters its own members' usage.
		writer = newAttemptWriter(w)
		ring.ServeAuthorized(writer, attempt)
		return writer, nil, ""
	}
	up, uerr := s.Resolver.ResolveUpstream(attempt.Context(), src.ProviderID, src.Account)
	if uerr != nil || up == nil {
		msg := "no upstream"
		if uerr != nil {
			msg = uerr.Error()
		}
		log.Printf("hub %s: combo %s skipping unresolvable source %s/%s: %s",
			cfg.Name, combo.Name, src.ProviderID, src.Account, msg)
		return nil, nil, src.ProviderID + "/" + src.Account + ": " + msg
	}
	if strings.TrimSpace(up.CatalogScope) == "" {
		up.CatalogScope = proxy.AccountCatalogScope(src.ProviderID, src.Account)
	}
	metered, finish := proxy.MeterUsage(w, observe.RouteHub, src.ProviderID, src.Account, h.step.Model)
	writer = newAttemptWriter(metered)
	proxy.Serve(writer, attempt, up)
	finish()
	return writer, up.QuotaErrorPatterns, ""
}

// comboHop is one step of a combo resolved to its hub source index.
type comboHop struct {
	step  ComboStep
	index int
}

// comboHops resolves a combo to the steps worth trying, in order. Cooling
// accounts are skipped while another step is eligible; when every step is
// cooling, the first one is attempted so its vendor's verdict reaches the
// client, as the plain chain does. A non-empty refusal means nothing is tried.
func (s *Server) comboHops(cfg *Config, combo *Combo) ([]comboHop, string) {
	var hops []comboHop
	var indices []int
	for _, step := range combo.Steps {
		index := comboStepSource(*cfg, step)
		if index < 0 || !cfg.Sources[index].IsEnabled() {
			continue
		}
		hops = append(hops, comboHop{step, index})
		indices = append(indices, index)
	}
	if len(hops) == 0 {
		return nil, "no step of combo " + combo.Name + " names an enabled source in this hub"
	}
	if s.Quotas == nil {
		return hops, ""
	}
	eligible, _ := s.Quotas.partition(cfg, indices)
	keep := map[int]bool{}
	for _, index := range eligible {
		keep[index] = true
	}
	var live []comboHop
	for _, h := range hops {
		if keep[h.index] {
			live = append(live, h)
		}
	}
	switch {
	case len(live) > 0:
		return live, ""
	case s.Quotas.servesWhenAllCooling():
		return hops[:1], ""
	}
	return nil, "every step of combo " + combo.Name + " is cooling down"
}

// comboHasEnabledStep reports whether any step names an enabled source, which
// separates "all cooling" from "misconfigured" when no hop survives.
func comboHasEnabledStep(cfg *Config, combo *Combo) bool {
	for _, step := range combo.Steps {
		if index := comboStepSource(*cfg, step); index >= 0 && cfg.Sources[index].IsEnabled() {
			return true
		}
	}
	return false
}

// modelEntry is one row of GET /v1/models. It carries both the OpenAI
// ("object") and Anthropic ("type") discriminators, so either kind of client
// reads it.
type modelEntry struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Type    string `json:"type"`
	OwnedBy string `json:"owned_by"`
}

// hubModels is what the hub can route for this route (ADR-0036): pinned ids,
// ids exactly one enabled source's provider publishes, and the combos. The
// second result is false when the hub knows no catalog at all.
func (s *Server) hubModels(cfg *Config, route *Route) ([]modelEntry, bool) {
	owners := map[string]map[string]bool{}
	known := false
	if s.ModelsForProvider != nil {
		providers := map[string]bool{}
		for _, src := range cfg.Sources {
			if src.IsEnabled() {
				providers[src.ProviderID] = true
			}
		}
		for providerID := range providers {
			for _, id := range s.ModelsForProvider(providerID) {
				known = true
				if owners[id] == nil {
					owners[id] = map[string]bool{}
				}
				owners[id][providerID] = true
			}
		}
	}
	seen := map[string]bool{}
	var out []modelEntry
	add := func(id, owner string) {
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		out = append(out, modelEntry{ID: id, Object: "model", Type: "model", OwnedBy: owner})
	}
	for _, combo := range cfg.Combos {
		add(combo.Name, "anypick-combo")
	}
	if route != nil {
		for _, pin := range route.Models {
			add(pin.Model, "anypick")
			known = true
		}
	}
	ids := make([]string, 0, len(owners))
	for id := range owners {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		// An id two providers publish is a collision until the user pins an
		// owner (ADR-0013); listing it would promise a route the hub may not
		// take.
		if len(owners[id]) != 1 {
			continue
		}
		for providerID := range owners[id] {
			add(id, providerID)
		}
	}
	// Combos alone do not count as knowing the catalog: answering with only
	// them would hide every vendor model from a client that lists through the
	// hub. Activation still writes combos into client configs either way.
	return out, known
}

// serveModels answers GET /v1/models from the hub's own catalog. It reports
// false when the hub knows nothing to list, so the caller can forward the
// request as it did before the hub had a list of its own.
func (s *Server) serveModels(w http.ResponseWriter, cfg *Config, route *Route) bool {
	models, known := s.hubModels(cfg, route)
	if !known {
		return false
	}
	if models == nil {
		models = []modelEntry{}
	}
	raw, err := json.Marshal(map[string]interface{}{"object": "list", "data": models, "has_more": false})
	if err != nil {
		return false
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
	return true
}
