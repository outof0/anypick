// Package hub implements one local endpoint that serves many sources, with
// token-scoped routes and model-based source selection.
//
// Security: loopback-only bind, per-route secrets (constant-time compare,
// fail-closed), tokens never appear in status output.
package hub

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/refs"
)

// Source names one upstream account. Rows persist sources as
// {ref:{kind:'account'|'account-pool', provider, name?}, enabled}; the store
// maps to the flat essential form on the boundary (decodeHubConfig).
// Account "pool:<provider>" is the serialization of an account-pool ref.
type Source struct {
	ProviderID string `json:"providerId"`
	Account    string `json:"account"`
	// Enabled controls whether the source participates in routing. Absent
	// reads as enabled, so nil — the zero value — must mean on; a plain
	// bool would flip every existing constructor to disabled.
	Enabled *bool `json:"-"`
}

// IsEnabled reports whether the source participates in routing.
func (s Source) IsEnabled() bool { return s.Enabled == nil || *s.Enabled }

// Hub-wide request modes (Config.Strategy).
const (
	StrategyFailover   = "failover"
	StrategyRoundRobin = "round-robin"
	// StrategySoonestReset starts each request at the account whose unused
	// quota resets soonest (ADR-0035).
	StrategySoonestReset = "soonest-reset"
)

// SpreadsRequests reports whether this hub spreads requests across the
// accounts that can serve them. (Not "Rotates": that verb reads as a persisted
// mutation to the ctx-first gate, and this is a pure predicate.)
func (c Config) SpreadsRequests() bool { return c.Strategy == StrategyRoundRobin }

const defaultHubHost = "127.0.0.1"

// Config is the persisted hub configuration.
type Config struct {
	Name    string   `json:"name"`
	Enabled bool     `json:"enabled"`
	Host    string   `json:"host,omitempty"` // default 127.0.0.1
	Port    int      `json:"port,omitempty"` // 0 → kernel-assigned
	Sources []Source `json:"sources"`
	// Strategy is the hub-wide request mode: "" / "failover" pins each request
	// to the source the model resolves to, "round-robin" spreads it across the
	// enabled sources that can serve that model (the resolved source's
	// provider — one provider's accounts are interchangeable for its models,
	// which is the same assumption the pool ring is built on). It is an
	// extension: persisted configs written before the mode existed carry none.
	Strategy string `json:"strategy,omitempty"`
	// Combos are the hub's own model ids, each an ordered fallback chain
	// (ADR-0036).
	Combos []Combo `json:"combos,omitempty"`
	// Token is the hub listener bearer. The row is written through
	// tsHubConfig, which keeps the field. Marshaling Config itself is the
	// status path, and that path must not carry the bearer (ADR 0006 §6,
	// ADR 0013 decision 2).
	Token     string `json:"-"`
	Revision  int    `json:"revision"` // positive integer
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	// modelOwners carries the unmodeled field verbatim across
	// read-modify-write cycles so a save never drops data it does not model.
	modelOwners json.RawMessage
}

// ModelRoute pins a model id to a source.
// Owner names the source by value ("provider/account", pools as
// "provider/pool:provider") instead of by position: positions shift on
// removal and silently re-pointed pins at the wrong account (ADR-0029).
// SourceIndex survives for rows the relational migration never saw and
// resolves bounds-checked as a fallback.
type ModelRoute struct {
	Model         string `json:"model"`
	SourceIndex   int    `json:"sourceIndex"`
	Owner         string `json:"owner,omitempty"`
	UpstreamModel string `json:"upstreamModel,omitempty"`
}

// sourceOwnerKey is the canonical value-pin identity for one hub source.
// The relational migration (internal/db) freezes the same format; the two
// must never drift.
func sourceOwnerKey(providerID, account string) string { return providerID + "/" + account }

// ownerOf resolves a source to its pin identity.
func ownerOf(src Source) string { return sourceOwnerKey(src.ProviderID, src.Account) }

// Route is one client-facing attachment: its secret authenticates requests;
// its manifest routes requested models onto sources.
type Route struct {
	RouteID  string       `json:"routeId"`
	HubName  string       `json:"hubName"`
	ClientID string       `json:"clientId"`
	Protocol string       `json:"protocol,omitempty"`
	Models   []ModelRoute `json:"models,omitempty"`
	Token    string       `json:"-"` // never serialized to output boundaries
	// proven is set only after the stored secret matched the presented token.
	// Echoing the token onto Token and comparing those two copies does not
	// authenticate anything (ADR 0006).
	proven bool
}

func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00") }

// Store owns the proxy_hubs / proxy_hub_routes tables. token_secret is
// owner-only material and is never decoded into status types.
//
// Root is the AnyPick data directory: mutating methods take the coordinator
// lock under it themselves (invariant #5), so callers must not depend on an
// ambient lock. A Store without Root cannot take the lock and its mutating
// methods fail closed instead of writing uncoordinated.
type Store struct {
	DB   *sql.DB
	Root string
}

func (s *Store) withHubLock(ctx context.Context, name string, fn func(context.Context) error) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return anyerr.Newf("hub name is required", "INVALID_REFERENCE")
	}
	if s.Root == "" {
		// The comment on Store is the contract: a missing root cannot take the
		// coordinator lock, so the write does not run at all (invariant #5).
		return anyerr.Newf("hub store has no data root; refusing uncoordinated write", "STATE_CONFLICT")
	}
	return lock.WithMutationLock(ctx, s.Root, refs.MutationScopeForRef(refs.ProxyHubRef(name)), fn)
}

// UpsertConfig inserts or updates the hub configuration row.
func (s *Store) UpsertConfigContext(ctx context.Context, cfg Config) (Config, error) {
	var out Config
	err := s.withHubLock(ctx, cfg.Name, func(c context.Context) error {
		got, err := s.upsertConfigLocked(c, cfg)
		out = got
		return err
	})
	return out, err
}

func (s *Store) upsertConfigLocked(ctx context.Context, cfg Config) (Config, error) {
	now := nowISO()
	existing, err := s.GetConfigContext(ctx, cfg.Name)
	if err != nil {
		return Config{}, err
	}
	created := now
	if existing != nil {
		created = existing.CreatedAt
	}
	cfg.CreatedAt = created
	cfg.UpdatedAt = now
	cfg.Revision = 1
	owners := cfg.modelOwners
	if existing != nil {
		created = existing.CreatedAt
		cfg.CreatedAt = created
		// Every write bumps revision.
		if existing.Revision > 0 {
			cfg.Revision = existing.Revision + 1
		}
		if owners == nil {
			owners = existing.modelOwners
		}
	}
	data, err := marshalTSConfig(cfg, owners)
	if err != nil {
		return Config{}, err
	}
	_, err = s.DB.ExecContext(ctx,
		`INSERT INTO proxy_hubs (name, config_json, created_at, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(name) DO UPDATE SET
		   config_json = excluded.config_json,
		   updated_at = excluded.updated_at`,
		cfg.Name, string(data), created, now)
	if err != nil {
		return Config{}, err
	}
	// Membership rows mirror the persisted sources atomically: a ghost
	// fails the foreign key here, and the previous document is restored so
	// a refused upsert leaves no partial state behind.
	if err := s.syncSourcesLocked(ctx, cfg); err != nil {
		if existing != nil {
			_, _ = s.DB.ExecContext(ctx,
				`UPDATE proxy_hubs SET config_json = ?, updated_at = ? WHERE name = ?`,
				string(marshalConfigJSON(existing)), now, cfg.Name)
		} else {
			_, _ = s.DB.ExecContext(ctx, `DELETE FROM proxy_hubs WHERE name = ?`, cfg.Name)
		}
		// The row sync already restored its own partial inserts; report the
		// refusal, not the cleanup.
		return Config{}, err
	}
	return cfg, nil
}

// marshalConfigJSON re-encodes a stored config without touching membership.
// It exists only for upsert rollback above; normal writes go through
// marshalTSConfig so the wire shape never drifts.
func marshalConfigJSON(cfg *Config) []byte {
	data, err := marshalTSConfig(*cfg, cfg.modelOwners)
	if err != nil {
		return []byte("{}")
	}
	return data
}

func (s *Store) GetConfig(name string) (*Config, error) {
	return s.GetConfigContext(context.Background(), name)
}

// ListConfigsContext returns every hub configuration by name. A corrupt row
// fails the whole list: like decodeHubConfig, a half-loaded hub set would
// serve requests against the wrong sources.
func (s *Store) ListConfigsContext(ctx context.Context) ([]Config, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT name, config_json FROM proxy_hubs ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Config{}
	for rows.Next() {
		var name, data string
		if err := rows.Scan(&name, &data); err != nil {
			return nil, err
		}
		cfg, err := decodeHubConfig([]byte(data), name)
		if err != nil {
			return nil, err
		}
		out = append(out, *cfg)
	}
	return out, rows.Err()
}

// RouteModelsContext returns the pinned models of a hub's default route
// (model → owning source index). Nil route (never attached) yields no pins,
// not an error: an unconfigured hub simply publishes nothing yet.
func (s *Store) RouteModelsContext(ctx context.Context, hubName string) ([]ModelRoute, error) {
	route, err := s.routeByID(ctx, DefaultRouteID(hubName))
	if err != nil {
		return nil, err
	}
	if route == nil {
		return nil, nil
	}
	return route.Models, nil
}

func (s *Store) GetConfigContext(ctx context.Context, name string) (*Config, error) {
	var data string
	err := s.DB.QueryRowContext(ctx,
		`SELECT config_json FROM proxy_hubs WHERE name = ?`, name).Scan(&data)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	cfg, err := decodeHubConfig([]byte(data), name)
	if err != nil {
		return nil, err
	}
	// Membership is relational (ADR-0029): the document shape stays
	// wire-compatible, but rows win. A hub whose rows are absent while
	// the document names sources is pre-migration or foreign-written; reading
	// the document then is the only way not to lose members.
	rows, rerr := s.loadSources(ctx, name)
	if rerr != nil {
		return nil, rerr
	}
	// Rows win once this hub has been written with relational membership,
	// including an empty row set: the last account delete cascades the rows
	// and must not fall back to the stale document. A document that has never
	// carried that marker is pre-migration or foreign-written; reading it is
	// the only way not to lose members.
	if len(rows) > 0 || !hasDocSources([]byte(data)) || sourcesRelational([]byte(data)) {
		cfg.Sources = rows
	}
	return cfg, nil
}

// sourcesRelational reports a hub whose membership rows are the authority,
// even when a cascade has left the row set empty.
func sourcesRelational(data []byte) bool {
	var doc struct {
		SourcesRelational bool `json:"sourcesRelational"`
	}
	return json.Unmarshal(data, &doc) == nil && doc.SourcesRelational
}

// hasDocSources reports whether the persisted document names any sources.
func hasDocSources(data []byte) bool {
	var doc struct {
		Sources []json.RawMessage `json:"sources"`
	}
	if json.Unmarshal(data, &doc) != nil {
		return false
	}
	return len(doc.Sources) > 0
}

// loadSources reads one hub's membership in stable position order.
func (s *Store) loadSources(ctx context.Context, hubName string) ([]Source, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT kind, provider, account, pool, enabled FROM proxy_hub_sources
		  WHERE hub_name = ? ORDER BY position`, hubName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Source{}
	for rows.Next() {
		var kind string
		var provider, account, pool sql.NullString
		var enabled int
		if err := rows.Scan(&kind, &provider, &account, &pool, &enabled); err != nil {
			return nil, err
		}
		src := Source{}
		if kind == "pool" && pool.Valid {
			src.ProviderID = provider.String
			src.Account = "pool:" + pool.String
		} else {
			src.ProviderID = provider.String
			src.Account = account.String
		}
		if enabled == 0 {
			disabled := false
			src.Enabled = &disabled
		}
		out = append(out, src)
	}
	return out, rows.Err()
}

// syncSourcesLocked replaces one hub's membership rows from the config the
// caller is persisting. A ghost source fails the foreign key here, before
// the document is touched; on any failure the previous rows are restored so
// a refused upsert leaves no partial state behind.
func (s *Store) syncSourcesLocked(ctx context.Context, cfg Config) error {
	prev, err := s.loadSources(ctx, cfg.Name)
	if err != nil {
		return err
	}
	restore := func() {
		_, _ = s.DB.ExecContext(ctx, `DELETE FROM proxy_hub_sources WHERE hub_name = ?`, cfg.Name)
		for i, src := range prev {
			_ = s.insertSourceRow(ctx, cfg.Name, i, src)
		}
	}
	if _, err := s.DB.ExecContext(ctx,
		`DELETE FROM proxy_hub_sources WHERE hub_name = ?`, cfg.Name); err != nil {
		return err
	}
	for i, src := range cfg.Sources {
		if err := s.insertSourceRow(ctx, cfg.Name, i, src); err != nil {
			restore()
			return err
		}
	}
	return nil
}

func (s *Store) insertSourceRow(ctx context.Context, hubName string, position int, src Source) error {
	kind, provider, account, pool := "account", src.ProviderID, src.Account, ""
	if p, ok := PoolSourceProvider(src); ok {
		// The provider rides along for an exact round-trip; the NULL
		// account opts the row out of the accounts foreign key, which only
		// governs account membership.
		kind, provider, account, pool = "pool", src.ProviderID, "", p
	}
	enabled := 1
	if src.Enabled != nil && !*src.Enabled {
		enabled = 0
	}
	var accountArg, poolArg any
	if account != "" {
		accountArg = account
	}
	if pool != "" {
		poolArg = pool
	}
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO proxy_hub_sources (hub_name, position, kind, provider, account, pool, enabled)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		hubName, position, kind, provider, accountArg, poolArg, enabled)
	return err
}

// wireRef / wireSource are the persisted wire shape. wireSource also accepts
// the legacy flat shape so older rows still load; anything else fails closed
// instead of zero-decoding into an empty config that would 502 every request.
type wireRef struct {
	Kind     string `json:"kind"`
	Provider string `json:"provider"`
	Name     string `json:"name"`
}

type wireSource struct {
	Ref     *wireRef `json:"ref"`
	Enabled *bool    `json:"enabled"`
	// Legacy flat shape (older rows written by this package).
	ProviderID string `json:"providerId"`
	Account    string `json:"account"`
}

func (w wireSource) toSource(where string) (Source, error) {
	if w.Ref != nil {
		switch w.Ref.Kind {
		case "account":
			if w.Ref.Provider == "" || w.Ref.Name == "" {
				return Source{}, anyerr.Newf(where+": account ref needs provider and name", "STATE_CONFLICT")
			}
			return Source{ProviderID: w.Ref.Provider, Account: w.Ref.Name, Enabled: w.Enabled}, nil
		case "account-pool":
			if w.Ref.Provider == "" {
				return Source{}, anyerr.Newf(where+": account-pool ref needs provider", "STATE_CONFLICT")
			}
			return Source{ProviderID: w.Ref.Provider, Account: "pool:" + w.Ref.Provider, Enabled: w.Enabled}, nil
		default:
			return Source{}, anyerr.Newf(where+": unsupported ref kind \""+w.Ref.Kind+"\"", "STATE_CONFLICT")
		}
	}
	if w.ProviderID != "" && w.Account != "" {
		return Source{ProviderID: w.ProviderID, Account: w.Account, Enabled: w.Enabled}, nil
	}
	return Source{}, anyerr.Newf(where+": unrecognized source shape", "STATE_CONFLICT")
}

// decodeHubConfig parses one proxy_hubs.config_json row. Unparseable or
// wrong-shaped rows return STATE_CONFLICT — never a silent empty config.
func decodeHubConfig(data []byte, name string) (*Config, error) {
	fail := func(why string) (*Config, error) {
		return nil, anyerr.Newf("corrupt hub config for "+name+": "+why, "STATE_CONFLICT")
	}
	var probe interface{}
	if err := json.Unmarshal(data, &probe); err != nil || probe == nil {
		return fail("not JSON")
	}
	if _, ok := probe.(map[string]interface{}); !ok {
		return fail("expected object")
	}
	var w struct {
		Name        string          `json:"name"`
		Enabled     bool            `json:"enabled"`
		Host        string          `json:"host"`
		Port        int             `json:"port"`
		Sources     []wireSource    `json:"sources"`
		ModelOwners json.RawMessage `json:"modelOwners"`
		Strategy    string          `json:"strategy"`
		Token       string          `json:"token"`
		Combos      []Combo         `json:"combos"`
		Revision    int             `json:"revision"`
		CreatedAt   string          `json:"createdAt"`
		UpdatedAt   string          `json:"updatedAt"`
	}
	if err := json.Unmarshal(data, &w); err != nil {
		return fail(err.Error())
	}
	if w.Strategy != "" && w.Strategy != StrategyFailover && w.Strategy != StrategyRoundRobin &&
		w.Strategy != StrategySoonestReset {
		return fail("unknown strategy " + w.Strategy)
	}
	cfg := &Config{
		Name: w.Name, Enabled: w.Enabled, Host: w.Host, Port: w.Port,
		Sources: make([]Source, 0, len(w.Sources)), Revision: w.Revision,
		Strategy: w.Strategy, Token: w.Token, CreatedAt: w.CreatedAt, UpdatedAt: w.UpdatedAt,
		Combos: w.Combos,
	}
	if len(w.ModelOwners) > 0 {
		cfg.modelOwners = json.RawMessage(string(w.ModelOwners))
	}
	for i, ws := range w.Sources {
		src, err := ws.toSource(fmt.Sprintf("sources[%d] of %s", i, name))
		if err != nil {
			return nil, err
		}
		cfg.Sources = append(cfg.Sources, src)
	}
	return cfg, nil
}

// tsSource/tsHubConfig are the write-side wire shape: every key
// decodeHubConfig requires is present, so a written row decodes natively
// (round-trip without protocol drift).
//
// Strategy is an extension the original wire shape does not model. An absent port is
// treated as kernel-assigned (the 0 value). Host defaults to 127.0.0.1; when
// given an explicit port the row is fully TS-readable.
type tsSource struct {
	Ref     wireRef `json:"ref"`
	Enabled bool    `json:"enabled"`
}

type tsHubConfig struct {
	Name        string          `json:"name"`
	Enabled     bool            `json:"enabled"`
	Host        string          `json:"host"`
	Port        int             `json:"port,omitempty"` // absent = kernel-assigned (gap note above)
	Strategy    string          `json:"strategy,omitempty"`
	Token       string          `json:"token,omitempty"`
	Sources     []tsSource      `json:"sources"`
	Combos      []Combo         `json:"combos,omitempty"`
	ModelOwners json.RawMessage `json:"modelOwners"`
	Revision    int             `json:"revision"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
	// SourcesRelational marks a document whose proxy_hub_sources rows are
	// rows are authoritative. Foreign and pre-migration documents omit it.
	SourcesRelational bool `json:"sourcesRelational,omitempty"`
}

func marshalTSConfig(cfg Config, modelOwners json.RawMessage) ([]byte, error) {
	host := cfg.Host
	if host == "" {
		host = defaultHubHost
	}
	owners := modelOwners
	if len(owners) == 0 {
		owners = json.RawMessage("[]")
	}
	wire := tsHubConfig{
		Name: cfg.Name, Enabled: cfg.Enabled,
		Host: host, Port: cfg.Port, Strategy: cfg.Strategy,
		Token:       cfg.Token,
		Combos:      cfg.Combos,
		Sources:     make([]tsSource, 0, len(cfg.Sources)),
		ModelOwners: owners, Revision: cfg.Revision,
		CreatedAt: cfg.CreatedAt, UpdatedAt: cfg.UpdatedAt,
		SourcesRelational: true,
	}
	for _, s := range cfg.Sources {
		ref := wireRef{Kind: "account", Provider: s.ProviderID, Name: s.Account}
		if pool, ok := poolSourceProvider(s); ok {
			ref = wireRef{Kind: "account-pool", Provider: pool}
		}
		wire.Sources = append(wire.Sources, tsSource{Ref: ref, Enabled: s.IsEnabled()})
	}
	return json.Marshal(wire)
}

// AttachRoute stores a route with its generated token secret. The secret is
// stored as HMAC-SHA256 hex derived from a per-install key so a DB dump does
// not expose bearer tokens (P1). The key lives in config.hub_token_hmac_key
// and is generated lazily on first use; deleting that row rotates the key
// and invalidates all existing HMAC tokens (re-attach required).
func (s *Store) AttachRouteContext(ctx context.Context, r Route) error {
	return s.withHubLock(ctx, r.HubName, func(c context.Context) error {
		return s.attachRouteLocked(c, r)
	})
}

func (s *Store) attachRouteLocked(ctx context.Context, r Route) error {
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	now := nowISO()
	if strings.TrimSpace(r.Token) != "" {
		hashed, err := s.hashToken(ctx, r.Token)
		if err != nil {
			return err
		}
		_, err = s.DB.ExecContext(ctx,
			`INSERT INTO proxy_hub_routes
			   (route_id, hub_name, manifest_json, token_secret, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(route_id) DO UPDATE SET
			   manifest_json = excluded.manifest_json,
			   token_secret = excluded.token_secret,
			   updated_at = excluded.updated_at`,
			r.RouteID, r.HubName, string(data), hashed, now, now)
		return err
	}
	// A manifest-only write (a model pin before any bearer exists) must not
	// store HMAC(""). That digest is the authenticator for an empty presented
	// token. A fresh row gets an unusable unique placeholder; an update leaves
	// the existing secret alone.
	placeholder, err := unusableRouteSecret()
	if err != nil {
		return err
	}
	_, err = s.DB.ExecContext(ctx,
		`INSERT INTO proxy_hub_routes
		   (route_id, hub_name, manifest_json, token_secret, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(route_id) DO UPDATE SET
		   manifest_json = excluded.manifest_json,
		   updated_at = excluded.updated_at`,
		r.RouteID, r.HubName, string(data), placeholder, now, now)
	return err
}

// unusableRouteSecret is stored for a route that has no bearer yet. It is not
// a hash of any token a client can present, and the "unset:" prefix keeps it
// out of the hex digest space RouteByToken queries.
func unusableRouteSecret() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "unset:" + hex.EncodeToString(raw), nil
}

const hubHMACKeyName = "hub_token_hmac_key"

func (s *Store) hmacKeyExisting(ctx context.Context) ([]byte, bool, error) {
	var hexKey string
	err := s.DB.QueryRowContext(ctx, `SELECT value FROM config WHERE key = ?`, hubHMACKeyName).Scan(&hexKey)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	b, derr := hex.DecodeString(hexKey)
	if derr != nil {
		return nil, false, anyerr.Newf("corrupt hub hmac key", "STATE_CONFLICT")
	}
	return b, true, nil
}

func (s *Store) ensureHMACKey(ctx context.Context) ([]byte, error) {
	if b, ok, err := s.hmacKeyExisting(ctx); err != nil {
		return nil, err
	} else if ok {
		return b, nil
	}
	raw := make([]byte, 32)
	if _, rerr := rand.Read(raw); rerr != nil {
		return nil, rerr
	}
	hexKey := hex.EncodeToString(raw)
	if _, ierr := s.DB.ExecContext(ctx,
		`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`,
		hubHMACKeyName, hexKey); ierr != nil {
		return nil, ierr
	}
	// Re-read the winner under race.
	if err := s.DB.QueryRowContext(ctx, `SELECT value FROM config WHERE key = ?`, hubHMACKeyName).Scan(&hexKey); err != nil {
		return nil, err
	}
	b, derr := hex.DecodeString(hexKey)
	if derr != nil {
		return nil, anyerr.Newf("corrupt hub hmac key", "STATE_CONFLICT")
	}
	return b, nil
}

func (s *Store) hashToken(ctx context.Context, token string) (string, error) {
	key, err := s.ensureHMACKey(ctx)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, key)
	if _, err := mac.Write([]byte(token)); err != nil {
		return "", err
	}
	return hex.EncodeToString(mac.Sum(nil)), nil
}

func legacySHA256(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// defaultRouteIDSuffix is the CLI-facing attachment used by `proxy hub owner`.
const defaultRouteIDSuffix = "/default"

// DefaultRouteID returns the implicit route id for a hub name.
func DefaultRouteID(hubName string) string { return hubName + defaultRouteIDSuffix }

// ClientRouteID returns the stable route used by a client's default config.
// Named profiles and one-shot runs use separate ids so rotating one token
// cannot invalidate another config that points at this hub.
func ClientRouteID(hubName, clientID string) string {
	return hubName + "/route-" + clientID
}

// ClientProfileRouteID returns the stable route for one native client profile.
func ClientProfileRouteID(hubName, clientID, profileName string) string {
	return ClientRouteID(hubName, clientID) + "/profile-" + profileName
}

// ClientRunRouteID returns an isolated route for one ephemeral activation.
func ClientRunRouteID(hubName, clientID, operationID string) string {
	return ClientRouteID(hubName, clientID) + "/run-" + operationID
}

// RouteRowSnapshot captures one persisted route row verbatim (manifest,
// token hash, timestamps) so activation compensation can restore EXACTLY what
// existed before an AttachRoute overwrite.
type RouteRowSnapshot struct {
	RouteID      string
	ManifestJSON string
	TokenSecret  string
	CreatedAt    string
	UpdatedAt    string
}

// SnapshotRouteContext reads the raw stored row for routeID; returns nil when
// the route does not exist.
func (s *Store) SnapshotRouteContext(ctx context.Context, routeID string) (*RouteRowSnapshot, error) {
	var snap RouteRowSnapshot
	err := s.DB.QueryRowContext(ctx,
		`SELECT route_id, manifest_json, token_secret, created_at, updated_at
		   FROM proxy_hub_routes WHERE route_id = ?`, routeID).
		Scan(&snap.RouteID, &snap.ManifestJSON, &snap.TokenSecret, &snap.CreatedAt, &snap.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &snap, nil
}

// RestoreRouteRowContext reinstates a snapshotted row byte-for-byte.
func (s *Store) RestoreRouteRowContext(ctx context.Context, snap *RouteRowSnapshot) error {
	return s.withHubLock(ctx, routeHubName(snap.ManifestJSON), func(c context.Context) error {
		return s.restoreRouteRowLocked(c, snap)
	})
}

func (s *Store) restoreRouteRowLocked(ctx context.Context, snap *RouteRowSnapshot) error {
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO proxy_hub_routes
		   (route_id, hub_name, manifest_json, token_secret, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(route_id) DO UPDATE SET
		   hub_name = excluded.hub_name,
		   manifest_json = excluded.manifest_json,
		   token_secret = excluded.token_secret,
		   created_at = excluded.created_at,
		   updated_at = excluded.updated_at`,
		snap.RouteID, routeHubName(snap.ManifestJSON), snap.ManifestJSON, snap.TokenSecret,
		snap.CreatedAt, snap.UpdatedAt)
	return err
}

// routeHubName extracts hub_name from a stored route manifest.
func routeHubName(manifestJSON string) string {
	var r Route
	if json.Unmarshal([]byte(manifestJSON), &r) != nil {
		return ""
	}
	return r.HubName
}

func (s *Store) routeByID(ctx context.Context, routeID string) (*Route, error) {
	var manifest string
	err := s.DB.QueryRowContext(ctx,
		`SELECT manifest_json FROM proxy_hub_routes WHERE route_id = ?`, routeID).Scan(&manifest)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var r Route
	if json.Unmarshal([]byte(manifest), &r) != nil {
		return nil, anyerr.Newf("corrupt hub route "+routeID, "STATE_CONFLICT")
	}
	return &r, nil
}

// RemoveSourceContext detaches one source. Pins name their owner by value,
// so removal only ever drops pins that named the removed member — there is
// no index to shift and nothing to re-point. It returns whether anything
// was removed and which model pins were dropped.
func (s *Store) RemoveSourceContext(ctx context.Context, hubName, providerID, account string) (bool, []string, error) {
	var removed bool
	var dropped []string
	err := s.withHubLock(ctx, hubName, func(c context.Context) error {
		cfg, err := s.GetConfigContext(c, hubName)
		if err != nil {
			return err
		}
		if cfg == nil {
			return anyerr.Newf("Proxy Hub not found: "+hubName, "HUB_NOT_FOUND")
		}
		owner := sourceOwnerKey(providerID, account)
		removedIdx := -1
		kept := make([]Source, 0, len(cfg.Sources))
		for i, src := range cfg.Sources {
			if ownerOf(src) == owner {
				removedIdx = i
				continue
			}
			kept = append(kept, src)
		}
		if removedIdx < 0 {
			return nil
		}
		cfg.Sources = kept
		if _, err := s.upsertConfigLocked(c, *cfg); err != nil {
			return err
		}
		dropped, err = s.dropPinsLocked(c, hubName, owner, removedIdx)
		if err != nil {
			return err
		}
		removed = true
		return nil
	})
	return removed, dropped, err
}

// PruneAccountContext drops every route pin that named one deleted account,
// across all hubs, and rewrites config_json so a cascade-deleted member
// cannot be read back from the stale document. Source rows themselves need
// no pruning: the foreign key on proxy_hub_sources cascades the account
// delete. Pins live inside route manifests (JSON takes no foreign keys), so
// they are swept here by value. It returns "hub: model, ..." entries
// describing what was dropped so callers can report it.
func (s *Store) PruneAccountContext(ctx context.Context, providerID, account string) ([]string, error) {
	configs, err := s.ListConfigsContext(ctx)
	if err != nil {
		return nil, err
	}
	owner := sourceOwnerKey(providerID, account)
	var pruned []string
	for _, cfg := range configs {
		var dropped []string
		derr := s.withHubLock(ctx, cfg.Name, func(c context.Context) error {
			var err error
			dropped, err = s.dropPinsLocked(c, cfg.Name, owner, -1)
			if err != nil {
				return err
			}
			rewritten, err := s.rewriteHubDocAfterAccountDelete(c, cfg.Name, providerID, account)
			if err != nil {
				return err
			}
			// Pins live in route JSON, which has no revision of its own.
			// A pin-only prune still has to move the hub revision or a
			// child that loaded the old routes stays in sync (ADR-0030).
			if len(dropped) > 0 && !rewritten {
				return s.bumpRevisionLocked(c, cfg.Name)
			}
			return nil
		})
		if derr != nil {
			return pruned, derr
		}
		for _, model := range dropped {
			pruned = append(pruned, cfg.Name+": "+model)
		}
	}
	return pruned, nil
}

// rewriteHubDocAfterAccountDelete persists membership rows back into
// config_json when the document still names the deleted account. An empty
// row set is authoritative for that removal: filtering only the deleted
// member keeps any pre-migration sibling that was never given a row.
func (s *Store) rewriteHubDocAfterAccountDelete(ctx context.Context, hubName, providerID, account string) (bool, error) {
	var data string
	err := s.DB.QueryRowContext(ctx,
		`SELECT config_json FROM proxy_hubs WHERE name = ?`, hubName).Scan(&data)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	cfg, err := decodeHubConfig([]byte(data), hubName)
	if err != nil {
		return false, err
	}
	mentioned := false
	for _, src := range cfg.Sources {
		if sourceIsAccount(src, providerID, account) {
			mentioned = true
			break
		}
	}
	if !mentioned {
		return false, nil
	}
	rows, err := s.loadSources(ctx, hubName)
	if err != nil {
		return false, err
	}
	if len(rows) > 0 {
		cfg.Sources = rows
	} else {
		kept := make([]Source, 0, len(cfg.Sources))
		for _, src := range cfg.Sources {
			if sourceIsAccount(src, providerID, account) {
				continue
			}
			kept = append(kept, src)
		}
		cfg.Sources = kept
	}
	// Same bump as upsertConfigLocked. Copying the old revision left a
	// running child looking synced while it still served the deleted account.
	if cfg.Revision > 0 {
		cfg.Revision++
	} else {
		cfg.Revision = 1
	}
	cfg.UpdatedAt = nowISO()
	encoded, err := marshalTSConfig(*cfg, cfg.modelOwners)
	if err != nil {
		return false, err
	}
	_, err = s.DB.ExecContext(ctx,
		`UPDATE proxy_hubs SET config_json = ?, updated_at = ? WHERE name = ?`,
		string(encoded), cfg.UpdatedAt, hubName)
	return err == nil, err
}

// bumpRevisionLocked moves one hub's revision without rewriting membership.
// The caller holds the hub lock. It re-reads the row so a rewrite that just
// landed is what gets the new number, and a concurrent document is not
// replaced by a stale copy.
func (s *Store) bumpRevisionLocked(ctx context.Context, hubName string) error {
	cfg, err := s.GetConfigContext(ctx, hubName)
	if err != nil || cfg == nil {
		return err
	}
	if cfg.Revision > 0 {
		cfg.Revision++
	} else {
		cfg.Revision = 1
	}
	cfg.UpdatedAt = nowISO()
	encoded, err := marshalTSConfig(*cfg, cfg.modelOwners)
	if err != nil {
		return err
	}
	_, err = s.DB.ExecContext(ctx,
		`UPDATE proxy_hubs SET config_json = ?, updated_at = ? WHERE name = ?`,
		string(encoded), cfg.UpdatedAt, hubName)
	return err
}

// NoteBoundPort records the port a hub child actually bound, without
// bumping revision. The child loads config once (ADR-0030). Writing the
// port back with a new revision would make that child look stale and the
// next start would restart it. A matching port is a no-op. The write
// re-reads under the hub lock so it cannot put a stale source list back.
func (s *Store) NoteBoundPort(ctx context.Context, hubName string, port int) error {
	if port <= 0 {
		return nil
	}
	return s.withHubLock(ctx, hubName, func(c context.Context) error {
		cfg, err := s.GetConfigContext(c, hubName)
		if err != nil || cfg == nil || cfg.Port == port {
			return err
		}
		cfg.Port = port
		cfg.UpdatedAt = nowISO()
		encoded, err := marshalTSConfig(*cfg, cfg.modelOwners)
		if err != nil {
			return err
		}
		_, err = s.DB.ExecContext(c,
			`UPDATE proxy_hubs SET config_json = ?, updated_at = ? WHERE name = ?`,
			string(encoded), cfg.UpdatedAt, hubName)
		return err
	})
}

func sourceIsAccount(src Source, providerID, account string) bool {
	if _, isPool := PoolSourceProvider(src); isPool {
		return false
	}
	return src.ProviderID == providerID && src.Account == account
}

// dropPinsLocked removes every pin naming owner across all routes of one
// hub and reports the dropped model ids. Legacy positional pins to the
// removed index drop with it; later legacy pins are unreachable after the
// relational migration rewrote them, so there is nothing to shift.
// Callers hold the hub lock.
func (s *Store) dropPinsLocked(ctx context.Context, hubName, owner string, removedIdx int) ([]string, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT route_id, manifest_json FROM proxy_hub_routes WHERE hub_name = ?`, hubName)
	if err != nil {
		return nil, err
	}
	type row struct{ id, manifest string }
	var list []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.manifest); err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, r)
	}
	rows.Close()
	var dropped []string
	for _, r := range list {
		var route Route
		if json.Unmarshal([]byte(r.manifest), &route) != nil || len(route.Models) == 0 {
			continue
		}
		kept := route.Models[:0]
		changed := false
		for _, m := range route.Models {
			if m.Owner != "" && m.Owner == owner {
				dropped = append(dropped, m.Model)
				changed = true
				continue
			}
			if m.Owner == "" && m.SourceIndex == removedIdx {
				dropped = append(dropped, m.Model)
				changed = true
				continue
			}
			kept = append(kept, m)
		}
		if !changed {
			continue
		}
		route.Models = kept
		encoded, merr := json.Marshal(route)
		if merr != nil {
			return dropped, merr
		}
		if _, merr := s.DB.ExecContext(ctx,
			`UPDATE proxy_hub_routes SET manifest_json = ?, updated_at = ? WHERE route_id = ?`,
			string(encoded), nowISO(), r.id); merr != nil {
			return dropped, merr
		}
	}
	return dropped, nil
}

// SetModelOwnerContext pins a model id to the source whose provider/account
// matches owner on the hub's default route (explicit model owner).
func (s *Store) SetModelOwnerContext(ctx context.Context, hubName, model, owner string) error {
	cfg, err := s.GetConfigContext(ctx, hubName)
	if err != nil {
		return err
	}
	if cfg == nil {
		return anyerr.Newf("Proxy Hub not found: "+hubName, "HUB_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound))
	}
	ownerKey := ""
	for _, src := range cfg.Sources {
		if src.ProviderID+"/"+src.Account == owner || src.Account == owner || src.ProviderID == owner {
			ownerKey = ownerOf(src)
			break
		}
	}
	if ownerKey == "" {
		return anyerr.Newf("source not attached to this hub: "+owner, "HUB_SOURCE_MISSING")
	}
	routeID := DefaultRouteID(hubName)
	route, err := s.routeByID(ctx, routeID)
	if err != nil {
		return err
	}
	if route == nil {
		route = &Route{RouteID: routeID, HubName: hubName, ClientID: "cli"}
	}
	replaced := false
	for i := range route.Models {
		if route.Models[i].Model == model {
			route.Models[i].Owner = ownerKey
			route.Models[i].SourceIndex = -1
			replaced = true
		}
	}
	if !replaced {
		route.Models = append(route.Models, ModelRoute{Model: model, Owner: ownerKey, SourceIndex: -1})
	}
	return s.AttachRouteContext(ctx, *route)
}

// PreviewManifest returns the deterministic route lines a client would see:
// one line per source plus explicit model-owner pins.
func (s *Store) PreviewManifest(ctx context.Context, hubName string) (*ManifestPreview, error) {
	cfg, err := s.GetConfigContext(ctx, hubName)
	if err != nil {
		return nil, err
	}
	if cfg == nil {
		return nil, anyerr.Newf("Proxy Hub not found: "+hubName, "HUB_NOT_FOUND",
			anyerr.WithExitCode(anyerr.NotFound))
	}
	out := &ManifestPreview{Name: hubName}
	for _, src := range cfg.Sources {
		out.Lines = append(out.Lines,
			fmt.Sprintf("source %d: %s/%s", out.SourceCount, src.ProviderID, src.Account))
		out.SourceCount++
	}
	route, err := s.routeByID(ctx, DefaultRouteID(hubName))
	if err != nil {
		return nil, err
	}
	if route != nil {
		for _, m := range route.Models {
			target := "default"
			if idx := ResolveOwnerIndex(cfg.Sources, m); idx >= 0 {
				s := cfg.Sources[idx]
				target = s.ProviderID + "/" + s.Account
			} else if m.Owner != "" {
				target = m.Owner + " (missing)"
			}
			line := fmt.Sprintf("model %s → %s", m.Model, target)
			if m.UpstreamModel != "" && m.UpstreamModel != m.Model {
				line += fmt.Sprintf(" (%s)", m.UpstreamModel)
			}
			out.Lines = append(out.Lines, line)
		}
	}
	return out, nil
}

// ManifestPreview is what `proxy hub preview` prints; never includes secrets.
type ManifestPreview struct {
	Name        string   `json:"name"`
	SourceCount int      `json:"-"`
	Lines       []string `json:"lines"`
}

func (s *Store) DetachRouteContext(ctx context.Context, routeID string) error {
	route, err := s.routeByID(ctx, routeID)
	if err != nil {
		return err
	}
	if route == nil {
		return nil
	}
	return s.withHubLock(ctx, route.HubName, func(c context.Context) error {
		_, err := s.DB.ExecContext(c, `DELETE FROM proxy_hub_routes WHERE route_id = ?`, routeID)
		return err
	})
}

// RouteByToken resolves the route owning a presented credential. Token secrets
// are stored as HMAC-SHA256 hex (AttachRoute hashes them with a per-install
// key); lookup tries HMAC, then SHA-256, then plaintext for legacy rows. The
// returned Route echoes the presented token on match and sets proven only
// after the stored secret matched the computed digest. Callers must check
// proven: comparing Token with the presented bearer compares a value to itself.
//
// This is a pure read: it never migrates rows and never provisions the HMAC
// key. Legacy-row migration is an explicit write via MigrateRouteTokenContext,
// invoked by the request path only after authentication has succeeded.
func (s *Store) RouteByToken(token string) (*Route, error) {
	return s.RouteByTokenContext(context.Background(), token)
}

func (s *Store) RouteByTokenContext(ctx context.Context, token string) (*Route, error) {
	// An empty presented token is not a credential. Returning before the
	// lookup means a stored digest of "" cannot authenticate one (ADR 0006).
	if token == "" {
		return nil, nil
	}
	// HMAC path — only if a key has been provisioned (RouteByToken must not
	// auto-create the key; AttachRoute is the writer that provisions it).
	if key, ok, err := s.hmacKeyExisting(ctx); err != nil {
		return nil, err
	} else if ok {
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte(token))
		hashed := hex.EncodeToString(mac.Sum(nil))
		route, err := s.routeByStoredSecret(ctx, hashed)
		if route != nil || err != nil {
			return provenRoute(route, token, hashed), err
		}
	}
	// Legacy SHA-256 rows (pre-HMAC) — returned as-is; the caller migrates
	// explicitly via MigrateRouteTokenContext after authenticating.
	sha := legacySHA256(token)
	if route, err := s.routeByStoredSecret(ctx, sha); route != nil || err != nil {
		return provenRoute(route, token, sha), err
	}
	// Earliest plaintext rows — returned as-is; see above.
	route, err := s.routeByStoredSecret(ctx, token)
	if route == nil || err != nil {
		return nil, err
	}
	return provenRoute(route, token, token), nil
}

// routeByStoredSecret reads the row whose token_secret equals probe and
// accepts it only when the stored bytes match probe in constant time. A SQL
// hit alone is not the authentication (ADR 0006).
func (s *Store) routeByStoredSecret(ctx context.Context, probe string) (*Route, error) {
	var data, secret string
	err := s.DB.QueryRowContext(ctx,
		`SELECT manifest_json, token_secret FROM proxy_hub_routes WHERE token_secret = ?`, probe).
		Scan(&data, &secret)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !proxy.SafeEqual(secret, probe) {
		return nil, nil
	}
	var r Route
	if json.Unmarshal([]byte(data), &r) != nil {
		return nil, anyerr.Newf("corrupt route manifest", "STATE_CONFLICT")
	}
	return &r, nil
}

// provenRoute publishes the presented token only after routeByStoredSecret
// has matched probe. The echo is not itself a credential check.
func provenRoute(route *Route, token, probe string) *Route {
	if route == nil || token == "" || probe == "" {
		return nil
	}
	route.Token = token
	route.proven = true
	return route
}

// MigrateRouteTokenContext moves one route's stored secret to the current HMAC
// form. It is the only writer on the legacy-migration path: RouteByTokenContext
// is a pure read, so the UPDATE cannot hide inside per-request authentication.
// Call it after a successful authentication; the legacy row keeps
// authenticating until a migration succeeds, so callers log (never swallow)
// a failure. Already-migrated rows short-circuit on a read: the UPDATE runs
// only when the stored secret differs, keeping the per-request cost to one
// indexed SELECT plus an HMAC.
//
// The write takes the coordinator lock itself (invariant #5) under the hub
// routes scope, re-entrant when the caller already holds it.
func (s *Store) MigrateRouteTokenContext(ctx context.Context, routeID, token string) error {
	if s.Root == "" {
		return anyerr.Newf("hub store has no data root; refusing uncoordinated write", "STATE_CONFLICT")
	}
	// Fast path without the lock: an already-migrated row short-circuits on
	// one indexed SELECT plus an HMAC, keeping the per-request cost off the
	// coordinator. Only a differing row takes the lock and re-checks inside
	// it, so two racing migrations converge on the same idempotent UPDATE.
	var current string
	if err := s.DB.QueryRowContext(ctx,
		`SELECT token_secret FROM proxy_hub_routes WHERE route_id = ?`, routeID).Scan(&current); err != nil {
		return err
	}
	migrated, merr := s.hashToken(ctx, token)
	if merr != nil {
		return merr
	}
	if subtle.ConstantTimeCompare([]byte(current), []byte(migrated)) == 1 {
		return nil
	}
	route, rerr := s.routeByID(ctx, routeID)
	if rerr != nil {
		return rerr
	}
	if route == nil {
		return nil
	}
	return s.withHubLock(ctx, route.HubName, func(c context.Context) error {
		var rechecked string
		if err := s.DB.QueryRowContext(c,
			`SELECT token_secret FROM proxy_hub_routes WHERE route_id = ?`, routeID).Scan(&rechecked); err != nil {
			return err
		}
		if subtle.ConstantTimeCompare([]byte(rechecked), []byte(migrated)) == 1 {
			return nil
		}
		_, err := s.DB.ExecContext(c,
			`UPDATE proxy_hub_routes SET token_secret = ?, updated_at = ? WHERE route_id = ?`,
			migrated, nowISO(), routeID)
		return err
	})
}

// NewRouteToken generates a fresh per-route bearer secret (32 random bytes,
// hex). The plaintext lives only long enough to be handed to the client that
// will present it; the store persists the HMAC only.
func NewRouteToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// NewHubApiKey generates a fresh user-facing API key for the hub (aph_ prefix + 32-char hex).
func NewHubApiKey() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "aph_" + hex.EncodeToString(b), nil
}

// EnsureHubTokenContext ensures the named hub has an API key configured.
// If not yet set, it generates a fresh key, saves it in the hub's config,
// and attaches the default route.
func (s *Store) EnsureHubTokenContext(ctx context.Context, hubName string) (string, error) {
	var token string
	err := s.withHubLock(ctx, hubName, func(c context.Context) error {
		cfg, err := s.GetConfigContext(c, hubName)
		if err != nil {
			return err
		}
		if cfg == nil {
			return anyerr.Newf("Proxy Hub not found: "+hubName, "HUB_NOT_FOUND",
				anyerr.WithExitCode(anyerr.NotFound))
		}
		if cfg.Token != "" {
			token = cfg.Token
			routeID := DefaultRouteID(hubName)
			route, rerr := s.routeByID(c, routeID)
			if rerr == nil && route == nil {
				_ = s.attachRouteLocked(c, Route{
					RouteID:  routeID,
					HubName:  hubName,
					ClientID: "default",
					Token:    token,
				})
			}
			return nil
		}
		fresh, ferr := NewHubApiKey()
		if ferr != nil {
			return ferr
		}
		cfg.Token = fresh
		if _, uerr := s.upsertConfigLocked(c, *cfg); uerr != nil {
			return uerr
		}
		routeID := DefaultRouteID(hubName)
		route, _ := s.routeByID(c, routeID)
		var models []ModelRoute
		if route != nil {
			models = route.Models
		}
		if aerr := s.attachRouteLocked(c, Route{
			RouteID:  routeID,
			HubName:  hubName,
			ClientID: "default",
			Models:   models,
			Token:    fresh,
		}); aerr != nil {
			return aerr
		}
		token = fresh
		return nil
	})
	return token, err
}

// RotateHubTokenContext replaces the hub's API key with a freshly generated one.
func (s *Store) RotateHubTokenContext(ctx context.Context, hubName string) (string, error) {
	var token string
	err := s.withHubLock(ctx, hubName, func(c context.Context) error {
		cfg, err := s.GetConfigContext(c, hubName)
		if err != nil {
			return err
		}
		if cfg == nil {
			return anyerr.Newf("Proxy Hub not found: "+hubName, "HUB_NOT_FOUND",
				anyerr.WithExitCode(anyerr.NotFound))
		}
		fresh, ferr := NewHubApiKey()
		if ferr != nil {
			return ferr
		}
		cfg.Token = fresh
		if _, uerr := s.upsertConfigLocked(c, *cfg); uerr != nil {
			return uerr
		}
		routeID := DefaultRouteID(hubName)
		route, _ := s.routeByID(c, routeID)
		var models []ModelRoute
		if route != nil {
			models = route.Models
		}
		if aerr := s.attachRouteLocked(c, Route{
			RouteID:  routeID,
			HubName:  hubName,
			ClientID: "default",
			Models:   models,
			Token:    fresh,
		}); aerr != nil {
			return aerr
		}
		token = fresh
		return nil
	})
	return token, err
}
