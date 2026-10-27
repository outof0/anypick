// Package provider implements account-auth providers: where credentials live
// and how they move.
package provider

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/outof0/anypick/go/internal/browserlogin"
	"github.com/outof0/anypick/go/internal/pubgate"
	"github.com/outof0/anypick/go/internal/transport"
)

type LiveAuthStatus struct {
	Present   bool
	Identity  string
	Details   string
	AccountID string
	// Source identifies the provider-owned live store when a provider has
	// more than one. It is empty for providers whose LoginMethod source is
	// presentation metadata rather than a scoped snapshot store.
	Source string
}

// AccountScopedIdentity distinguishes login identifiers from display labels.
// A key-only Codex snapshot reports "API key", which cannot identify its owner.
func AccountScopedIdentity(identity string) bool {
	normalized := strings.ToLower(strings.TrimSpace(identity))
	return normalized != "" && normalized != "api key"
}

// SnapshotInfo is the partial meta a Backup may contribute (identity, label…).
type SnapshotInfo struct {
	Identity        string
	Label           string
	Notes           string
	CredentialKind  string // 'native' | 'proxy-only'
	CredentialClass string // provider_api_key | coding_plan_key | external_oauth (raw)
}

// Provider is the provider surface core needs. Optional capabilities are
// separate interfaces asserted at runtime (PreflightRestorer, LiveClearer,
// LiveMatcher).
type Provider interface {
	ID() string
	Name() string
	Description() string
	// CanProxy reports whether this provider implements StartProxy — the input
	// to transport.ProviderInfo.CanProxy. Never inferred from the client list.
	CanProxy() bool
	// AccountAdapter returns this provider's source adapter. Providers own
	// their transport policy; core never branches on id.
	AccountAdapter(accountName string, proxyEnabled bool) transport.Adapter
	DetectLive() (LiveAuthStatus, error)
	// Backup copies live auth into destDir and returns display metadata.
	Backup(destDir string) (SnapshotInfo, error)
	Restore(srcDir string) error
	DescribeSnapshot(srcDir string) (SnapshotInfo, error)
}

// CredentialDefinitionsProvider publishes the non-secret credential products
// a provider can accept through account-save-input. Keeping this capability
// separate from CompatibleDefinition lets native providers (Gemini is one)
// offer an API-key account without pretending to be an OpenAI-compatible
// vendor.
type CredentialDefinitionsProvider interface {
	CredentialDefinitions() []CredentialDefinition
}

// CredentialInputProvider accepts an explicit credential and writes it into
// a staged account snapshot. The account service owns the atomic commit; the
// provider owns the on-disk shape and validation.
type CredentialInputProvider interface {
	BackupInput(kind, secret, profile, destDir string) (SnapshotInfo, error)
}

// MaxAuthPasteBytes is the largest auth document a paste may stage.
// MaxAuthPasteAccounts bounds one JSON list so a pasted file cannot fan out
// into an unbounded batch.
const (
	MaxAuthPasteBytes    = 256 * 1024
	MaxAuthPasteAccounts = 32
)

// AuthPaster plans saved-account snapshots from a pasted provider auth
// document. PlanAuthPaste is pure: it does not read or write the live
// credential store, so saving a paste cannot replace the CLI the user is
// signed into. Applying the account later is the existing Use flow.
type AuthPaster interface {
	PlanAuthPaste(raw []byte) ([]PastedSnapshot, error)
}

// PastedSnapshot is one account a paste will create. File bytes stay
// unexported so the service cannot invent filenames or re-marshal a document
// the provider chose to store verbatim.
type PastedSnapshot struct {
	SuggestedName string
	Info          SnapshotInfo
	files         map[string][]byte
}

// SourceScopedProvider lets a provider select one of several live sign-in
// stores when saving an account. A caller that supplies a source must not be
// silently redirected to whichever store happens to win automatic probing.
type SourceScopedProvider interface {
	DetectLiveSource(source string) (LiveAuthStatus, error)
	BackupSource(source, destDir string) (SnapshotInfo, error)
}

// GatewayInfo describes a provider-owned gateway capability without making
// the desktop layer know the provider's id. Providers that can create a
// gateway from a profile or a live session expose this optional capability;
// providers that only support account snapshots simply omit it.
type GatewayInfo struct {
	ProvidesEndpoint    bool
	RequiresAPIKey      bool
	DefaultEndpoint     string
	FirstPartyClientIDs []string
	Kind                string
	// RequiresGatewayID marks providers that address multiple gateways per
	// endpoint (Cloudflare AI Gateway: one account id, many gateway ids).
	// Pickers collect the gateway id separately; the engine persists it and
	// the provider maps it onto the wire. Providers with a single gateway
	// per endpoint leave it false and never see the field.
	RequiresGatewayID bool
	// RequiresAccountID marks providers whose endpoint is derived per
	// account (Cloudflare: the base URL embeds the account id). The picker
	// collects the account id instead of a URL — showing a URL field would
	// ask the user to type what the engine already knows how to build —
	// and the engine derives and stores the endpoint at create time.
	RequiresAccountID bool
}

// GatewayInfoProvider exposes the non-secret metadata needed by gateway
// pickers. The actual upstream remains provider-owned and is resolved through
// GatewayUpstreamWithKey, GatewayUpstreamWithEndpoint, or GatewayUpstream.
type GatewayInfoProvider interface {
	GatewayInfo() GatewayInfo
}

// GatewayIDNormalizer validates a user-supplied gateway id for providers
// that set GatewayInfo.RequiresGatewayID. Empty means the provider default;
// anything else must satisfy the provider's own shape. Implemented next to
// GatewayInfo so the rule stays provider-owned instead of branching on the
// provider id at the call site.
type GatewayIDNormalizer interface {
	NormalizeGatewayID(id string) (string, error)
}

// GatewayEndpointDeriver builds the endpoint for providers that set
// GatewayInfo.RequiresAccountID (the base URL embeds an account id the user
// supplies separately). The profile carries the raw account id; pairs belong
// in their own fields, so a profile containing "/" fails closed with a hint
// instead of silently picking a side.
type GatewayEndpointDeriver interface {
	DeriveGatewayEndpoint(profile string) (string, error)
}

// ShortNamer optionally exposes a compact display name (provider.shortName).
type ShortNamer interface {
	ShortName() string
}

// NativeClientProvider identifies the first-party client that owns a
// provider's live login. Most providers use the same id for both values, but
// a provider can be hosted by a distinct client (Z.ai's subscription login is
// owned by ZCode). The desktop snapshot uses this only for presentation and
// route discovery; transport policy still comes from AccountAdapter.
type NativeClientProvider interface {
	NativeClientID() string
}

// ShortNameOf returns the compact name for a provider.
func ShortNameOf(p Provider) string {
	if sn, ok := p.(ShortNamer); ok && sn.ShortName() != "" {
		return sn.ShortName()
	}
	return p.Name()
}

// PreflightRestorer optionally refuses a restore that would corrupt state
// (e.g. owner app still running).
type PreflightRestorer interface {
	PreflightRestore(srcDir string) error
}

// LiveClearer optionally removes local live auth without server logout.
type LiveClearer interface {
	ClearLive() error
}

// LiveClearPolicy optionally narrows the clear action for providers that can
// detect a login in an external app-owned store. The desktop host uses this
// only for presentation and boundary validation; the provider remains the
// authority on whether clearing is safe.
type LiveClearPolicy interface {
	CanClearLive(source string) bool
}

// LiveMatcher optionally compares snapshot material against live login.
// known=false means comparison would require a secret prompt (never guess).
type LiveMatcher interface {
	SnapshotMatchesLive(srcDir string) (match bool, known bool, err error)
}

// SnapshotValidator optionally rejects a saved snapshot whose credential is
// detectably stale. It runs in activation's ValidateCredential step, before
// anything mutates, so a dead login fails fast instead of serving 401s.
// Local-only checks are preferred; a bounded network probe must fail open on
// transport errors and fail closed only on a definitive server rejection.
type SnapshotValidator interface {
	ValidateSnapshot(snapshotDir string) error
}

// Provenance is presentation data ('official' | 'community'), not policy.
// It aliases browserlogin.Method so availability resolution stays in one
// package without duplicating the shape.
type LoginMethod = browserlogin.Method

// LoginMethodsProvider optionally exposes browser sign-in methods currently
// available on this machine. Providers own both the method list and the
// implementation so core never hardcodes OAuth endpoints or commands.
type LoginMethodsProvider interface {
	LoginMethods() []LoginMethod
}

// Loginer completes a provider-declared browser login and writes its native
// credential store. Core verifies and snapshots the live credential after this
// returns. ctx cancellation must abort the flow.
type Loginer interface {
	Login(ctx context.Context, methodID, source string) error
}

type Registry struct {
	gate   *pubgate.Gate
	mu     sync.RWMutex
	items  map[string]Provider
	order  []string
	sealed bool
}

func NewRegistry() *Registry { return &Registry{items: map[string]Provider{}} }

// SetGate installs the shared publication lock used by Get/Has/IDs. Recovery
// commit holds the write side; these readers take the read side. Recover*
// methods do not take the gate — the caller already holds it.
func (r *Registry) SetGate(gate *pubgate.Gate) { r.gate = gate }

func (r *Registry) Register(p Provider) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sealed {
		return fmt.Errorf("provider registry sealed")
	}
	if _, exists := r.items[p.ID()]; !exists {
		r.order = append(r.order, p.ID())
	}
	r.items[p.ID()] = p
	return nil
}

func (r *Registry) Seal() { r.mu.Lock(); r.sealed = true; r.mu.Unlock() }

func (r *Registry) Get(id string) (Provider, error) {
	r.gate.RLock()
	defer r.gate.RUnlock()
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.items[id]
	if !ok {
		return nil, fmt.Errorf("unknown provider %q", id)
	}
	return p, nil
}

func (r *Registry) Has(id string) bool {
	r.gate.RLock()
	defer r.gate.RUnlock()
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.items[id]
	return ok
}

func (r *Registry) IDs() []string {
	r.gate.RLock()
	defer r.gate.RUnlock()
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := append([]string(nil), r.order...)
	sort.Strings(out)
	return out
}

// RegisterBuiltin wires the file-snapshot providers shipped with AnyPick.
// kiro (sqlite secret store + SSO cache) remains host-composition territory.
func RegisterBuiltin(r *Registry, home string) error {
	for _, p := range []Provider{
		newCodex(home),
		newClaude(home),
		newGemini(home),
		newGrok(home),
		newOpenCode(home),
		newKiro(home),
		newWorkBuddy(home),
		newCline(home),
		newCloudflareAIGateway(),
		newOllama(),
		newLMStudio(),
	} {
		if err := r.Register(p); err != nil {
			return err
		}
	}
	return nil
}

func errSnapshotMissing(label string) error {
	return &snapshotMissingError{label: label}
}

type snapshotMissingError struct{ label string }

func (e *snapshotMissingError) Error() string {
	return "Snapshot is missing " + e.label
}
