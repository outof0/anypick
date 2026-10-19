// Package client holds adapters that point AI client apps at
// accounts/gateways by writing their native configuration.
package client

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/outof0/anypick/go/internal/pubgate"
	"github.com/outof0/anypick/go/internal/transport"
)

type Capabilities struct {
	ID                         string
	AcceptedProtocols          []transport.Protocol
	SupportsEnvironmentOverlay bool
	SupportsIsolatedHome       bool
	SupportsPersistentConfig   bool
	// RequiresDefaultModel marks clients whose native config is invalid until
	// a default model is selected. Catalog-backed clients with a native model
	// registry still need one active default; their other models are published
	// alongside it. Env-only clients may defer to their own native defaults.
	RequiresDefaultModel bool
	ProtocolPreference   transport.Protocol // empty = none declared
}

// ApplyContext carries everything an adapter needs to write config. The
// profile store is resolved by callers before Apply.
type ApplyContext struct {
	Endpoint     string
	APIKey       string
	DefaultModel string
	ModelRoles   map[string]string // role id → model id
	// ModelCatalog is the source-scoped list published by the selected
	// account, gateway, or hub. It is intentionally opaque: each proxy owns
	// its model ids, and adapters must pass those ids through unchanged.
	ModelCatalog  []string
	ExtraEnv      map[string]string // overlay env filtered per adapter
	DryRun        bool
	Verbose       bool
	AnyPickRoot   string
	Home          string // live client home (~)
	IsolatedHome  string // non-empty for ephemeral runtimes
	ProxyEndpoint string
	// Resolved source/transport fields let an optional ApplyPersistent adapter
	// receive the same plan identity. Built-ins ignore
	// them and continue through Apply.
	SourceKind          string
	SourceProvider      string
	SourceName          string
	TransportCapability transport.Capability
	Mode                string
	// ProfileName selects a native named route. It is currently used by the
	// Codex adapter; other adapters leave their existing single-route behavior
	// unchanged.
	ProfileName string
	// NativeAuthSnapshotDir is the AnyPick account snapshot to materialize into
	// a named Codex home. It is a directory rather than a raw credential value
	// so auth material never travels through plans or command output.
	NativeAuthSnapshotDir string
	// AllowForeignConfig records explicit user consent to replace client
	// settings AnyPick does not own (CLIENT_CONFIG_FOREIGN). It is request-
	// scoped: callers set it from a CLI flag or a confirmed app action and it
	// is never inferred or persisted. Adapters must consult it via Preflight
	// before their first foreign overwrite.
	AllowForeignConfig bool
}

type ApplyResult struct {
	ManagedPaths   []string
	ManagedEnvKeys []string
}

// PersistentAdapter is an optional adapter interface. Runtime code prefers it
// only for durable/project writes; isolated runs always use their dedicated
// capability.
type PersistentAdapter interface {
	ApplyPersistent(ctx context.Context, input *ApplyContext) (*ApplyResult, error)
}

// IsolatablePath is an explicit live-path allowlist a client may copy
// into an isolated runtime.
type IsolatablePath struct {
	SourcePath      string `json:"sourcePath"`
	DestinationPath string `json:"destinationPath"`
	Kind            string `json:"kind"`
	Required        bool   `json:"required"`
}

// EphemeralContext is the JSON-safe subset of ResolvedClientPlan needed by an
// arbitrary plugin client to construct its isolated home or env overlay.
type EphemeralContext struct {
	ClientID              string
	Endpoint              string
	APIKey                string
	DefaultModel          string
	ModelRoles            map[string]string
	ModelCatalog          []string
	AnyPickRoot           string
	Home                  string
	SourceKind            string
	SourceProvider        string
	SourceName            string
	TransportCapability   transport.Capability
	ProfileName           string
	NativeAuthSnapshotDir string
}

// IsolatedRuntime is an owner-only runtime handle. Cleanup is guarded here so
// a plugin's retained cleanup hook is invoked at most once even when both a
// failed activation and the caller attempt rollback.
type IsolatedRuntime struct {
	Directory   string
	Home        string
	Environment map[string]string
	Args        []string

	cleanupOnce sync.Once
	cleanup     func() error
	cleanupErr  error
}

func NewIsolatedRuntime(
	directory, home string,
	environment map[string]string,
	args []string,
	cleanup func() error,
) *IsolatedRuntime {
	return &IsolatedRuntime{
		Directory: directory, Home: home, Environment: environment,
		Args: args, cleanup: cleanup,
	}
}

func (r *IsolatedRuntime) Cleanup() error {
	if r == nil {
		return nil
	}
	r.cleanupOnce.Do(func() {
		if r.cleanup != nil {
			r.cleanupErr = r.cleanup()
		}
	})
	return r.cleanupErr
}

// EphemeralAdapter owns an arbitrary client's isolated-home or environment
// overlay construction. Its implementation must not mutate live client state.
type EphemeralAdapter interface {
	CreateEphemeralRuntime(ctx context.Context, input *EphemeralContext) (*IsolatedRuntime, error)
}

type InspectResult struct {
	Present bool
	// Native is positive evidence that the live client configuration uses its
	// own login. A saved managed binding can outlive an external config change;
	// display callers must not present that binding as the effective route.
	Native bool
	// RoutingChanged reports an explicit live selection outside AnyPick's
	// managed route. It does not identify that connection or imply a login.
	RoutingChanged bool
	Summary        string
	Issues         []string
	// ConfigPaths lists which files the client manages, so plugin
	// clients can report them.
	ConfigPaths []string
}

// Adapter is implemented by every client.
type Adapter interface {
	ID() string
	Name() string
	Capabilities() *Capabilities
	Apply(ctx *ApplyContext) (*ApplyResult, error)
	// Reset removes AnyPick-managed configuration, restoring backups where kept.
	Reset() error
	Inspect() (*InspectResult, error)
}

// NativeRestorer is implemented by client adapters that can drop AnyPick
// managed config so the client returns to its native login. The persistent
// direct-account path calls it instead of Apply: without it a native switch
// would leave a stale proxy endpoint behind.
type NativeRestorer interface {
	RestoreNative() error
}

// ProfileInspector lets activation verify a named native profile without
// confusing it with the client's one global config file.
type ProfileInspector interface {
	InspectProfile(name string) (*InspectResult, error)
}

// ProfileResetter removes one named native profile while leaving the client's
// global config and native authentication untouched.
type ProfileResetter interface {
	ResetProfile(name string) error
}

// ProfilePurger removes one named native profile AND the credential material
// stored inside it. An adapter implements this only when its profile owns a
// private credential home; ResetProfile keeps that home on purpose (a later
// activation of the same name reuses it), which is unsafe once the account the
// profile pointed at has been deleted.
type ProfilePurger interface {
	RemoveProfileFiles(name string) error
}

// ExecutableAdapter overrides the client id when launching an ephemeral run.
// Most clients use the same name for their binary; clients whose published
// product name differs (Command Code ships the `cmd` binary) opt in here.
type ExecutableAdapter interface {
	Executable() string
}

// ConfigInspection reports foreign regions an apply would overwrite.
type ConfigInspection struct {
	Conflicts []ConfigConflict
}

// ConfigPreflighter is implemented by adapters that can detect settings they
// do not own before writing. Preflight reads the live files and returns the
// conflicts Apply would cause; with AllowForeignConfig consent it may return
// them anyway for journaled reporting, but Apply itself must still refuse
// when consent is absent. Malformed config keeps failing closed with
// CLIENT_CONFIG_INVALID regardless of consent.
type ConfigPreflighter interface {
	Preflight(ctx *ApplyContext) (*ConfigInspection, error)
}

// Registry holds the registered clients. Registration happens only during
// composition; the list of clients says what exists — never what pairings are
// allowed (that is transport.Adapter.transportFor).
type Registry struct {
	gate   *pubgate.Gate
	mu     sync.RWMutex
	items  map[string]Adapter
	order  []string
	sealed bool
}

func NewRegistry() *Registry { return &Registry{items: map[string]Adapter{}} }

// SetGate installs the shared publication lock used by Get/Has/IDs. See
// provider.Registry.SetGate.
func (r *Registry) SetGate(gate *pubgate.Gate) { r.gate = gate }

func (r *Registry) Register(a Adapter) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sealed {
		return fmt.Errorf("client registry sealed")
	}
	if _, exists := r.items[a.ID()]; !exists {
		r.order = append(r.order, a.ID())
	}
	r.items[a.ID()] = a
	return nil
}

func (r *Registry) Seal() { r.mu.Lock(); r.sealed = true; r.mu.Unlock() }

func (r *Registry) Get(id string) (Adapter, error) {
	r.gate.RLock()
	defer r.gate.RUnlock()
	r.mu.RLock()
	defer r.mu.RUnlock()
	a, ok := r.items[id]
	if !ok {
		return nil, fmt.Errorf("unknown client %q", id)
	}
	return a, nil
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

func RegisterBuiltin(r *Registry, home string, anyPickRoots ...string) error {
	anyPickRoot := ""
	if len(anyPickRoots) > 0 {
		anyPickRoot = anyPickRoots[0]
	}
	for _, a := range []Adapter{
		newClaude(home),
		newCodex(home, anyPickRoot),
		newGemini(home),
		newKiro(home),
		newOpenCode(home),
		newWorkBuddy(home),
		newZCode(home),
		newDsh(home),
		newCommandCode(home),
		newPi(home),
		newOmp(home),
	} {
		if err := r.Register(a); err != nil {
			return err
		}
	}
	return nil
}
