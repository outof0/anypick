package mgmtapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/accounts"
	"github.com/outof0/anypick/go/internal/agentbridge"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/app"
	"github.com/outof0/anypick/go/internal/desktop"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/usagelog"
)

// APIVersion is the response schema version. Adding a field keeps it; changing
// or removing one means a /v2 (ADR-0034).
const APIVersion = 1

// maxBodyBytes bounds an action's JSON body; the largest is a few flags.
const maxBodyBytes = 64 << 10

// Server is one running management API.
type Server struct {
	App        *app.App
	InstanceID string
	// Port is the bound port. Every request must name it in Host; a request
	// for any other authority is a DNS-rebinding attempt.
	Port int
	// StartHub and StopHub are the CLI's own hub lifecycle, passed in so the
	// two surfaces cannot disagree about when a running child is stale.
	StartHub func(ctx context.Context, name string) (state string, pid int, err error)
	StopHub  func(ctx context.Context, name string) error
}

// Handler is the API with every guard applied. /health is the only route that
// answers without the bearer, and it carries no secret.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	authed := http.NewServeMux()
	authed.HandleFunc("GET /v1/status", s.status)
	authed.HandleFunc("GET /v1/accounts", s.accounts)
	authed.HandleFunc("GET /v1/proxies", s.proxies)
	authed.HandleFunc("GET /v1/hubs", s.hubs)
	authed.HandleFunc("GET /v1/agents", s.agents)
	authed.HandleFunc("GET /v1/usage/history", s.usageHistory)
	authed.HandleFunc("POST /v1/accounts/{provider}/{name}/activate", s.activate)
	authed.HandleFunc("POST /v1/proxies/{provider}/{name}/start", s.startProxy)
	authed.HandleFunc("POST /v1/proxies/{provider}/{name}/stop", s.stopProxy)
	authed.HandleFunc("POST /v1/hubs/{name}/start", s.startHub)
	authed.HandleFunc("POST /v1/hubs/{name}/stop", s.stopHub)
	mux.Handle("/v1/", s.requireToken(authed))
	return s.guard(mux)
}

// guard refuses what no legitimate local tool sends: a foreign Host (DNS
// rebinding), an Origin (a web page), and a POST that is not JSON (the only
// body a cross-origin page could send without a preflight).
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.loopbackHost(r.Host) {
			writeError(w, http.StatusMisdirectedRequest, "HOST_REFUSED",
				"This API answers only on its loopback address.")
			return
		}
		if r.Header.Get("Origin") != "" {
			writeError(w, http.StatusForbidden, "ORIGIN_REFUSED",
				"Browsers cannot call the management API.")
			return
		}
		if r.Method == http.MethodPost {
			mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil || mediaType != "application/json" {
				writeError(w, http.StatusUnsupportedMediaType, "JSON_REQUIRED",
					"Send actions with Content-Type: application/json.")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) loopbackHost(hostport string) bool {
	host, port, err := net.SplitHostPort(hostport)
	if err != nil || port != strconv.Itoa(s.Port) {
		return false
	}
	switch strings.ToLower(host) {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	return false
}

// requireToken checks the bearer against the token file on every request, so
// `anypick serve token --rotate` takes effect without a restart. A missing or
// unreadable file fails closed.
func (s *Server) requireToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expected, err := readToken(s.App.Root)
		presented := ""
		if auth := r.Header.Get("Authorization"); strings.HasPrefix(strings.ToLower(auth), "bearer ") {
			presented = strings.TrimSpace(auth[len("bearer "):])
		}
		if err != nil || !proxy.SafeEqual(expected, presented) {
			writeError(w, http.StatusUnauthorized, "AUTH_REQUIRED",
				"Present the management API token as Authorization: Bearer <token>.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok": true, "pid": os.Getpid(), "instanceId": s.InstanceID, "apiVersion": APIVersion,
	})
}

// AccountRow is one saved account. Identity has passed the same display
// filter as the desktop snapshot; a value that looks like a credential is
// dropped rather than shown.
type AccountRow struct {
	Provider     string `json:"provider"`
	Name         string `json:"name"`
	Label        string `json:"label,omitempty"`
	Identity     string `json:"identity,omitempty"`
	Active       bool   `json:"active"`
	ProxyEnabled bool   `json:"proxyEnabled"`
}

// ProxyRow is one account proxy. The endpoint is a loopback address, not a
// secret; the key that unlocks it never appears here.
type ProxyRow struct {
	Provider string `json:"provider"`
	Account  string `json:"account"`
	Enabled  bool   `json:"enabled"`
	Running  bool   `json:"running"`
	Endpoint string `json:"endpoint,omitempty"`
}

// HubRow is one Proxy Hub. Built field by field: hub.Config carries the hub's
// bearer and must never be marshaled here.
type HubRow struct {
	Name     string      `json:"name"`
	Enabled  bool        `json:"enabled"`
	Port     int         `json:"port,omitempty"`
	Strategy string      `json:"strategy"`
	Sources  []HubSource `json:"sources"`
	// Combos are the hub's own model ids (ADR-0036). They name sources and
	// models only; nothing in them is a secret.
	Combos []hub.Combo `json:"combos"`
}

// HubSource is one account behind a hub.
type HubSource struct {
	Provider string `json:"provider"`
	Account  string `json:"account"`
}

func (s *Server) accountRows(ctx context.Context) []AccountRow {
	rows := []AccountRow{}
	for _, providerID := range s.App.Providers.IDs() {
		list, err := s.App.Accounts.List(ctx, providerID)
		if err != nil {
			continue
		}
		active, _ := s.App.Accounts.Active(ctx, providerID)
		for _, acc := range list {
			rows = append(rows, AccountRow{
				Provider:     providerID,
				Name:         acc.Meta.Name,
				Label:        desktop.DisplaySafeIdentity(acc.Meta.Label),
				Identity:     desktop.DisplaySafeIdentity(acc.Meta.Identity),
				Active:       active == acc.Meta.Name,
				ProxyEnabled: acc.Proxy.Enabled,
			})
		}
	}
	return rows
}

func (s *Server) proxyRows(ctx context.Context) []ProxyRow {
	rows := []ProxyRow{}
	for _, acc := range s.accountRows(ctx) {
		st, err := s.App.Proxy.StatusContext(ctx, acc.Provider, acc.Name)
		if err != nil || st == nil || (!st.Enabled && !st.Running) {
			continue
		}
		row := ProxyRow{Provider: acc.Provider, Account: acc.Name, Enabled: st.Enabled, Running: st.Running}
		if st.Running {
			row.Endpoint = st.Endpoint
		}
		rows = append(rows, row)
	}
	return rows
}

func (s *Server) hubRows(ctx context.Context) []HubRow {
	rows := []HubRow{}
	if s.App.ProxyHub == nil {
		return rows
	}
	configs, err := s.App.ProxyHub.ListConfigsContext(ctx)
	if err != nil {
		return rows
	}
	for _, cfg := range configs {
		strategy := cfg.Strategy
		if strategy == "" {
			strategy = "failover"
		}
		row := HubRow{Name: cfg.Name, Enabled: cfg.Enabled, Port: cfg.Port, Strategy: strategy,
			Sources: []HubSource{}, Combos: cfg.Combos}
		if row.Combos == nil {
			row.Combos = []hub.Combo{}
		}
		for _, src := range cfg.Sources {
			row.Sources = append(row.Sources, HubSource{Provider: src.ProviderID, Account: src.Account})
		}
		rows = append(rows, row)
	}
	return rows
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"apiVersion": APIVersion,
		"accounts":   s.accountRows(r.Context()),
		"proxies":    s.proxyRows(r.Context()),
		"hubs":       s.hubRows(r.Context()),
	})
}

func (s *Server) accounts(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{"apiVersion": APIVersion, "accounts": s.accountRows(r.Context())})
}

func (s *Server) proxies(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{"apiVersion": APIVersion, "proxies": s.proxyRows(r.Context())})
}

func (s *Server) hubs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{"apiVersion": APIVersion, "hubs": s.hubRows(r.Context())})
}

func (s *Server) agents(w http.ResponseWriter, r *http.Request) {
	manifest, err := agentbridge.Build(r.Context(), agentbridge.Deps{
		Activation: s.App.Deps,
		Clients:    s.App.Clients,
		Bindings:   s.App.BindingSvc,
		Proxy:      s.App.Proxy,
	})
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"apiVersion": APIVersion, "agents": manifest})
}

// usageHistory answers usage since ?since= (7d, 24h or a date; default 7d),
// grouped by ?by= (model, account, provider or day; default model), with the
// dated estimate (ADR-0037). Token counts and model ids only: no request
// content was ever stored to return.
func (s *Server) usageHistory(w http.ResponseWriter, r *http.Request) {
	by := r.URL.Query().Get("by")
	if by == "" {
		by = "model"
	}
	if !usagelog.ValidGroupBy(by) {
		writeError(w, http.StatusBadRequest, "INVALID_USAGE", "by must be one of "+strings.Join(usagelog.GroupBy, ", "))
		return
	}
	now := time.Now()
	since, err := usagelog.ParseSince(r.URL.Query().Get("since"), now)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_USAGE", err.Error())
		return
	}
	summary, err := s.App.UsageSummary(r.Context(), since, by, now)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"apiVersion": APIVersion, "usage": summary})
}

// activateRequest is the optional body of an activate action.
type activateRequest struct {
	// AllowForeignConfig is consent to replace client settings AnyPick does
	// not own, as `anypick use --allow-foreign-config` gives it.
	AllowForeignConfig bool `json:"allowForeignConfig"`
}

// activate switches the provider's live account and moves every client bound
// to the new account onto it, inside the switch transaction: a failure puts
// the previous account back, exactly as the TUI's switch does.
func (s *Server) activate(w http.ResponseWriter, r *http.Request) {
	var req activateRequest
	if err := readBody(r, &req); err != nil {
		writeFailure(w, err)
		return
	}
	providerID, name := r.PathValue("provider"), r.PathValue("name")
	reapplied := 0
	result, err := s.App.Accounts.Use(r.Context(), providerID, name, accounts.UseOptions{
		PostSwitch: func(pc context.Context) error {
			n, rerr := s.App.ReapplyClientsBoundTo(pc, refs.AccountRef(providerID, name),
				app.ReapplyOptions{AllowForeign: req.AllowForeignConfig})
			reapplied = n
			return rerr
		},
	})
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"apiVersion": APIVersion, "ok": true,
		"provider": result.Provider, "from": result.From, "to": result.To,
		"reappliedClients": reapplied,
	})
}

func (s *Server) startProxy(w http.ResponseWriter, r *http.Request) {
	if err := readBody(r, nil); err != nil {
		writeFailure(w, err)
		return
	}
	providerID, name := r.PathValue("provider"), r.PathValue("name")
	started, err := s.App.Proxy.StartProxy(r.Context(), providerID, name)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// StartResult carries the key; only the endpoint crosses (ADR-0006).
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"apiVersion": APIVersion, "ok": true,
		"provider": providerID, "account": name,
		"endpoint": started.Endpoint, "startedNow": started.StartedNow,
	})
}

func (s *Server) stopProxy(w http.ResponseWriter, r *http.Request) {
	if err := readBody(r, nil); err != nil {
		writeFailure(w, err)
		return
	}
	providerID, name := r.PathValue("provider"), r.PathValue("name")
	if err := s.App.Proxy.Stop(r.Context(), providerID, name); err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"apiVersion": APIVersion, "ok": true, "provider": providerID, "account": name,
	})
}

func (s *Server) startHub(w http.ResponseWriter, r *http.Request) {
	if err := readBody(r, nil); err != nil {
		writeFailure(w, err)
		return
	}
	if s.StartHub == nil {
		writeError(w, http.StatusNotImplemented, "UNSUPPORTED", "Hub control is not available here.")
		return
	}
	name := r.PathValue("name")
	state, pid, err := s.StartHub(r.Context(), name)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"apiVersion": APIVersion, "ok": true, "hub": name, "state": state, "pid": pid,
	})
}

func (s *Server) stopHub(w http.ResponseWriter, r *http.Request) {
	if err := readBody(r, nil); err != nil {
		writeFailure(w, err)
		return
	}
	if s.StopHub == nil {
		writeError(w, http.StatusNotImplemented, "UNSUPPORTED", "Hub control is not available here.")
		return
	}
	name := r.PathValue("name")
	if err := s.StopHub(r.Context(), name); err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"apiVersion": APIVersion, "ok": true, "hub": name})
}

// readBody decodes an optional JSON body into into, refusing unknown fields
// and anything larger than an action needs. into may be nil for actions that
// take no options; a body is then still bounded and must be an object.
func readBody(r *http.Request, into interface{}) error {
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		return anyerr.Newf("The request body could not be read.", "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	if len(raw) > maxBodyBytes {
		return anyerr.Newf("The request body is too large.", "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	if into == nil {
		into = &struct{}{}
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return anyerr.Newf("The request body is not a valid options object: "+err.Error(), "INVALID_USAGE",
			anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	return nil
}

// writeFailure answers an error with its anyerr code, a display-safe message
// and its suggestions, mapped onto an HTTP status a client can branch on.
func writeFailure(w http.ResponseWriter, err error) {
	var ae *anyerr.Error
	code, message, suggestions := "INTERNAL", err.Error(), []string(nil)
	if errors.As(err, &ae) {
		code, message, suggestions = ae.Code, ae.Message, ae.Suggestions
	}
	status := http.StatusInternalServerError
	switch exit := anyerr.ExitCodeOf(err); {
	case exit == anyerr.InvalidUsage:
		status = http.StatusBadRequest
	// Not every not-found error carries the NotFound exit code
	// (ACCOUNT_NOT_FOUND does not), but every one is named that way.
	case exit == anyerr.NotFound || strings.HasSuffix(code, "_NOT_FOUND"):
		status = http.StatusNotFound
	case ae != nil:
		// A coded refusal from AnyPick, whatever its exit code.
		status = http.StatusConflict
	}
	body := map[string]interface{}{
		"apiVersion": APIVersion, "ok": false, "code": code,
		"message": desktop.DisplaySafeMessage(message),
	}
	if len(suggestions) > 0 {
		safe := make([]string, 0, len(suggestions))
		for _, s := range suggestions {
			safe = append(safe, desktop.DisplaySafeMessage(s))
		}
		body["suggestions"] = safe
	}
	writeJSON(w, status, body)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]interface{}{
		"apiVersion": APIVersion, "ok": false, "code": code, "message": message,
	})
}

func writeJSON(w http.ResponseWriter, status int, body interface{}) {
	raw, err := json.Marshal(body)
	if err != nil {
		raw = []byte(fmt.Sprintf(`{"apiVersion":%d,"ok":false,"code":"ENCODE_FAILED"}`, APIVersion))
		status = http.StatusInternalServerError
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(append(raw, '\n'))
}
