// Server lifecycle and transport: pipes, handshake, dispatch, shutdown and snapshots.
package desktop

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/outof0/anypick/go/internal/accounts"
	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/catalog"
	"github.com/outof0/anypick/go/internal/client"
	"github.com/outof0/anypick/go/internal/config"
	"github.com/outof0/anypick/go/internal/discovery"
	"github.com/outof0/anypick/go/internal/doctor"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/journal"
	"github.com/outof0/anypick/go/internal/modelcache"
	"github.com/outof0/anypick/go/internal/plugins"
	"github.com/outof0/anypick/go/internal/pools"
	"github.com/outof0/anypick/go/internal/profile"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/proxy"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/runtime"
	"github.com/outof0/anypick/go/internal/store"
)

// RefreshInterval is the snapshot cadence: 2.5s.
const RefreshInterval = 2500 * time.Millisecond

// maxAnsweredRequests bounds the requestIds a server remembers as answered. A
// duplicate only matters while a host could still retry the same command, so a
// small window is enough and the map cannot grow for the life of a session.
const maxAnsweredRequests = 256

// loginTimeout is the engine's own backstop for a sign-in. The browser launcher
// already bounds itself (10 minutes by default), so this sits just past it: a
// cooperative adapter reports its own reason first, and an adapter that never
// returns is answered instead of holding the host's slot forever.
const loginTimeout = 12 * time.Minute

// inflightShutdownWait bounds how long a graceful exit waits for work that is
// still running. The native host owns the outer kill timeout, so an adapter that
// ignores cancellation must not pin the process.
const inflightShutdownWait = 10 * time.Second

// maxCancelLedger bounds the cancels with no target yet. A burst of unique ids
// (only reachable from a misbehaving host on a local pipe) must not grow the
// map without limit.
const maxCancelLedger = 128

// cancelLedgerTTL bounds how long a cancel with no target is remembered. Long
// enough for a handler to start, short enough that a re-used request id cannot
// be cancelled by history.
const cancelLedgerTTL = 2 * time.Minute

// DesktopActionTimeout bounds mutations initiated from the native app. The
// app has no useful way to distinguish a slow activation from a dead proxy
// child, so an unbounded handler leaves its sheet in Applying… forever. The
// activation executor still owns rollback; this deadline only makes the
// terminal result reach the host when a dependency never settles.
const DesktopActionTimeout = 60 * time.Second

// UsageRefreshInterval is intentionally much slower than the legacy full
// snapshot loop. App-service mode emits only a bounded usage event on this
// cadence; state snapshots are initial, explicit, or mutation-driven.
const UsageRefreshInterval = 30 * time.Second

// Deps wires the desktop core to engine services.
type Deps struct {
	Root      string
	Store     *store.AccountStore
	Accounts  *accounts.Service
	Proxy     *proxy.Service
	Providers *provider.Registry
	Clients   *client.Registry
	Profiles  *profile.Service
	Bindings  *bindings.Service
	// Inspections owns staged backup inspection for the backup-import flow. It
	// holds the account store, so the desktop protocol asks the manager rather
	// than reaching the raw store through this Deps struct.
	Inspections *InspectionManager
	// Journal is the operation history backing the Activity snapshot section.
	// Read-only here: the snapshot maps recent entries to display rows and
	// never writes. Nil (legacy tests) yields an honest empty list.
	Journal *journal.OperationJournal
	// Activation drives model-role re-activation and other planned mutations.
	Activation *activation.Deps
	Hub        *hub.Service
	// Pools is the pools table's service boundary. Rotation is a pool config
	// change plus a hub config change, and both belong behind a service.
	Pools *pools.Service
	// Config owns global-config mutations; nil in legacy compositions only.
	Config *config.ConfigService
	// Discovery owns model-cache reads and writes for snapshot/catalog paths.
	// Keeping it injected prevents the desktop protocol from reaching through
	// the account store's database handle.
	Discovery *discovery.Service
	// ModelCache is the model-cache store backing gateway-test and snapshot
	// catalog paths. Injected (built in the composition root) so the desktop
	// protocol never reaches through the account store's database handle.
	ModelCache *modelcache.Store
	// HostState is the native host's report channel for platform truth such
	// as login-item registration (ADR 0020 §7); optional until handshake.
	HostState HostStateProvider
	// ShutdownOwned stops every credential-bearing service owned by the app
	// (Hub, account proxies, then pools). Production supplies this from the
	// composition root because Hub child identity is a process-shell concern.
	// Legacy/tests without it retain the account-proxy cleanup below.
	ShutdownOwned func(context.Context) error
	// PluginDiagnostics supplies redacted dynamic host health. It is a callback
	// so the desktop package does not own or restart the private Node process.
	PluginDiagnostics func(context.Context) plugins.Diagnostics
	Environment       doctor.EnvironmentReport
}

// HostStateProvider exposes platform state only the native host can know.
type HostStateProvider interface {
	LaunchAtLoginEnabled() bool
}

// Server is the desktop-app core: it pushes snapshots on an interval and
// executes commands from the app serially.
type Server struct {
	Deps Deps
	In   io.Reader
	Out  io.Writer

	// revision is the snapshot counter embedded in action ids. It is written by
	// buildSnapshot (which can run in a mutation's own goroutine) and read by
	// currentRevision, so both hold actionsMu: a plain ++ there was a real data
	// race, found by -race once a test stopped draining the handler goroutine.
	revision    int
	actionRows  map[string]ActionRow
	prevActions map[string]actionHandler
	actions     map[string]actionHandler
	actionOrder []string
	actionsMu   sync.Mutex
	inspections *InspectionManager
	// modelRoleTargets is the current revision's model-option registry,
	// published by buildSnapshot and read by applyModelRoles. Guarded by
	// actionsMu: it is swapped with `actions` so a resolution can never mix
	// two revisions.
	modelRoleTargets map[string]modelRoleTarget

	// In-flight cancellable mutations (account-login) keyed by requestId, and
	// cancels that arrived before their target registered.
	cancelMu     sync.Mutex
	cancellables map[string]context.CancelFunc
	cancelLedger map[string]time.Time

	// actionTimeout is DesktopActionTimeout unless a test narrows it.
	actionTimeout time.Duration
	// loginBudget is loginTimeout unless a test narrows it.
	loginBudget time.Duration
	// loginAttempt runs one sign-in; nil uses the accounts service. A test
	// supplies one that ignores cancellation to exercise the deadline.
	loginAttempt func(ctx context.Context, providerID string, opts accounts.LoginOptions) (accounts.LoginResult, error)

	writeMu   sync.Mutex
	refreshMu sync.Mutex
	inFlight  sync.WaitGroup
	// snapshotDirty marks a failed state snapshot that the ticker must retry.
	snapshotDirty atomic.Bool
	// stopCh closes when a graceful shutdown starts, so background helpers can
	// stop waiting without being part of inFlight.
	stopCh   chan struct{}
	stopOnce sync.Once

	// answered remembers the requestIds that already received a terminal frame,
	// and reserved remembers the ones a dispatch has claimed. They are separate
	// on purpose: a dispatch reservation must not look like an answer, or the
	// watchdog and the panic recovery would stay silent for the very requests
	// that need them.
	answeredMu    sync.Mutex
	answered      map[string]struct{}
	answeredOrder []string
	reserved      map[string]struct{}
	reservedOrder []string

	serviceMode  bool
	snapshotSent bool
	hello        EngineHello

	hostStateMu          sync.Mutex
	hostStateReported    bool
	launchAtLoginEnabled bool
	hostEffectMu         sync.Mutex
	pendingHostEffects   map[string]config.HostEffectRequest

	// clientConfigIssues records the clients whose live config could not be
	// brought back to their saved route. Startup used to log these into the
	// void: the app went on showing the route as active while Claude Code or
	// Codex actually read something else. They ride the snapshot as degraded
	// conditions so the user is told, and they clear when a later activation
	// of that client succeeds.
	clientConfigMu     sync.Mutex
	clientConfigIssues map[string]DegradedCondition
}

// New builds a server. In/Out are the pipes to the native app; when the host
// has no app binary they may be os.Stdin/os.Stdout so any client can attach.
func New(deps Deps, in io.Reader, out io.Writer) *Server {
	return &Server{Deps: deps, In: in, Out: out, inspections: deps.Inspections,
		cancellables:       map[string]context.CancelFunc{},
		pendingHostEffects: map[string]config.HostEffectRequest{},
		clientConfigIssues: map[string]DegradedCondition{},
		stopCh:             make(chan struct{})}
}

// recordClientConfigIssue publishes one client whose config AnyPick could not
// restore or take over. The engine's refusal text is filtered before it
// crosses the desktop boundary; a path that resembles a credential gets a
// stable summary instead of hiding the useful warning behind the safety text.
func (s *Server) recordClientConfigIssue(clientID string, err error) {
	if clientID == "" || err == nil {
		return
	}
	detail := displaySafeMessage(
		err.Error() + " AnyPick did not change it; confirm the takeover to manage it.")
	if detail == unsafeDisplayFallback && isForeignConfigRefusal(err) {
		detail = fmt.Sprintf(
			"%s config contains settings not managed by AnyPick. AnyPick did not change it; confirm the takeover to manage it.",
			clientID,
		)
	}
	condition := DegradedCondition{
		ID:     "client-config:" + clientID,
		Kind:   "client-config",
		Title:  "AnyPick left " + clientID + " config untouched",
		Detail: detail,
	}
	s.clientConfigMu.Lock()
	defer s.clientConfigMu.Unlock()
	s.clientConfigIssues[clientID] = condition
}

// clearClientConfigIssue drops the condition once an activation of that client
// succeeds, so a stale warning cannot outlive the state it described.
func (s *Server) clearClientConfigIssue(clientID string) {
	s.clientConfigMu.Lock()
	defer s.clientConfigMu.Unlock()
	delete(s.clientConfigIssues, clientID)
}

func (s *Server) clientConfigConditions() []DegradedCondition {
	s.clientConfigMu.Lock()
	defer s.clientConfigMu.Unlock()
	if len(s.clientConfigIssues) == 0 {
		return nil
	}
	ids := make([]string, 0, len(s.clientConfigIssues))
	for id := range s.clientConfigIssues {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]DegradedCondition, 0, len(ids))
	for _, id := range ids {
		out = append(out, s.clientConfigIssues[id])
	}
	return out
}

// NewService builds the app-owned protocol-v2 service. Unlike New (the legacy
// supervisor bridge), it requires a handshake, has no startup sleep, and never
// polls full snapshots.
func NewService(deps Deps, in io.Reader, out io.Writer) *Server {
	s := New(deps, in, out)
	s.serviceMode = true
	s.hello = newEngineHello()
	return s
}

// errShutdown unwinds Run cleanly.
var errShutdown = fmt.Errorf("desktop core shutting down")

func (s *Server) Run(ctx context.Context) error {
	lines := s.scanLines()
	if s.serviceMode {
		if err := s.handshake(ctx, lines); err != nil {
			return err
		}
		// A desktop restart intentionally stops child proxies during shutdown.
		// Rehydrate persisted managed routes before publishing the first
		// snapshot, otherwise clients keep a stale loopback URL and their first
		// request fails even though the binding still points at a valid account.
		if err := s.rehydrateManagedBindings(ctx); err != nil {
			s.logErr(err)
		}
	} else {
		// Compatibility bridge only. App-owned desktop-service has a real
		// handshake and therefore needs no arbitrary startup delay.
		time.Sleep(1 * time.Second)
	}
	if err := s.refresh(ctx); err != nil && err != errShutdown {
		s.logErr(err)
	}

	interval := RefreshInterval
	if s.serviceMode {
		interval = UsageRefreshInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return s.shutdown(ctx)
		case <-ticker.C:
			var err error
			if s.serviceMode {
				err = s.refreshUsage(ctx)
				// A failed state snapshot leaves the host waiting for a change
				// it never receives (a switch that never confirms). Usage ticks
				// keep it fresh; this retries the snapshot itself.
				if s.snapshotRetryNeeded() {
					if rerr := s.refresh(ctx); rerr != nil {
						s.logErr(rerr)
					}
				}
			} else {
				err = s.refresh(ctx)
			}
			if err != nil {
				if err == errShutdown {
					return s.shutdown(ctx)
				}
				s.logErr(err)
			}
		case scanned, ok := <-lines:
			if !ok {
				return s.shutdown(ctx)
			}
			if scanned.Err != nil {
				if s.serviceMode {
					// bufio.ErrTooLong means the line was never completed, so
					// there is no payload to attribute this to.
					s.write(FrameProtocolError(ProtocolError{ProtocolVersion: ServiceProtocolVersion,
						Code: "FRAME_TOO_LARGE", Message: "input frame exceeded the configured bound"}))
				}
				return s.shutdown(ctx)
			}
			line := strings.TrimRight(scanned.Line, "\r\n")
			if s.serviceMode && strings.HasPrefix(line, "host-effect-result\t") {
				result, derr := decodeHostEffectResult(line)
				if derr != nil {
					s.write(FrameProtocolError(ProtocolError{ProtocolVersion: ServiceProtocolVersion,
						Code:      "MALFORMED_HOST_EFFECT_RESULT",
						Message:   "host-effect result was rejected",
						RequestID: RequestIDFromLine(line),
					}))
					continue
				}
				s.handleHostEffectResult(ctx, result)
				continue
			}
			cmd, derr := DecodeLine(line)
			if derr != nil {
				if s.serviceMode {
					// A rejected frame still names the command it answered
					// when the payload is readable: the app can then settle
					// that row instead of waiting out its confirm timeout.
					s.write(FrameProtocolError(ProtocolError{ProtocolVersion: ServiceProtocolVersion,
						Code:      "MALFORMED_FRAME",
						Message:   "command frame was rejected",
						RequestID: RequestIDFromLine(line),
					}))
				}
				continue // malformed input is ignored, never fatal
			}
			// Commands that can take seconds run off the loop so a slow one
			// cannot delay the user's next command or their cancel, and so the
			// host is answered by a deadline even if the handler blocks.
			switch cmd.Kind {
			case "mutate", "model-roles", "backup-inspect", "logs", "doctor":
				s.dispatchBounded(ctx, cmd)
			default:
				if err := s.handleSafely(ctx, cmd); err != nil {
					if err == errShutdown {
						return s.shutdown(ctx)
					}
					s.logErr(err)
					s.answerFailedCommand(err, cmd.RequestID())
				}
			}
		}
	}
}

// handleSafely runs one command with panic containment.
//
// The invoke path already recovers, but the synchronous commands (mutate,
// model-roles, backup-inspect, logs) did not: a panic in a provider adapter
// reached from one of them killed the engine process with no frame for the
// in-flight requestId, so the host held its mutation slot and the proxies died
// with the engine. A panicking provider must cost one attributed failure, not
// the process.
// snapshotRetryNeeded reports whether the last state snapshot failed. The
// service ticker sends usage only, so without this a failed buildSnapshot left
// the host without the state change it was waiting for.
func (s *Server) snapshotRetryNeeded() bool { return s.snapshotDirty.Load() }

// waitForInFlight waits for running work and reports whether it finished inside
// the limit.
func (s *Server) waitForInFlight(limit time.Duration) bool {
	done := make(chan struct{})
	go func() {
		s.inFlight.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(limit):
		return false
	}
}

// actionBudget is DesktopActionTimeout, or the narrowed test budget.
func (s *Server) actionBudget() time.Duration {
	if s.actionTimeout > 0 {
		return s.actionTimeout
	}
	return DesktopActionTimeout
}

// budgetFor is the budget of one command. `logs` is deliberately shorter than
// the host's own log timeout, so the host gets an attributed engine failure
// instead of its generic "the log request timed out".
func (s *Server) budgetFor(kind string) time.Duration {
	if kind == "logs" {
		return 8 * time.Second
	}
	if kind == "doctor" {
		return 20 * time.Second
	}
	return s.actionBudget()
}

// loginDeadline is loginTimeout, or the narrowed test budget.
func (s *Server) loginDeadline() time.Duration {
	if s.loginBudget > 0 {
		return s.loginBudget
	}
	return loginTimeout
}

// dispatchBounded runs a potentially slow command with panic containment and a
// budget, naming the operation for the failure message.
func (s *Server) dispatchBounded(ctx context.Context, cmd *Command) {
	operation := cmd.Kind
	mutated := cmd.Kind == "mutate" || cmd.Kind == "model-roles"
	if cmd.Kind == "mutate" && len(cmd.Payload) > 0 {
		var m Mutate
		if json.Unmarshal(cmd.Payload, &m) == nil && m.Operation != "" {
			operation = m.Operation
		}
	}
	s.runBoundedWithBudget(ctx, cmd.RequestID(), operation, mutated, s.budgetFor(cmd.Kind),
		func(c context.Context) error {
			return s.handleSafely(c, cmd)
		})
}

// runBounded runs one command off the select loop with an absolute budget and a
// watchdog that answers the request even when the handler never returns.
//
// Two problems made this necessary. The loop is serial, so a long mutation
// delayed every later command — including the user's cancel. And a handler that
// blocks past its deadline published nothing at all, which left the host's
// single mutation slot held with no way out. The handler still runs to
// completion (cancelling it mid-write is what ADR 0024's pre-commit rule
// forbids); what changes is that the host is answered on time.
func (s *Server) runBounded(
	ctx context.Context, requestID, operation string, mutated bool, run func(context.Context) error,
) {
	s.runBoundedWithBudget(ctx, requestID, operation, mutated, s.actionBudget(), run)
}

func (s *Server) runBoundedWithBudget(
	ctx context.Context, requestID, operation string, mutated bool, budget time.Duration,
	run func(context.Context) error,
) {
	s.inFlight.Add(1)
	go func() {
		defer s.inFlight.Done()
		handlerCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), budget)
		defer cancel()
		if err := run(handlerCtx); err != nil && err != errShutdown {
			s.logErr(err)
			s.answerFailedCommand(err, requestID)
		}
	}()
	if requestID == "" {
		return
	}
	// Deliberately not counted in inFlight: a graceful quit must not wait for a
	// watchdog that only exists to answer a request, and a late write into a
	// closed pipe is harmless.
	go func() {
		timer := time.NewTimer(budget + time.Second)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-s.stopCh:
			return
		case <-timer.C:
		}
		// Mutated=true is honest here: for a write action the handler may have
		// written before it stopped answering. `write` drops this if the handler
		// answered in the meantime.
		s.write(FrameResult(errorResult(requestID, actionTimeoutErr(operation, mutated))))
	}()
}

func (s *Server) handleSafely(ctx context.Context, cmd *Command) (err error) {
	requestID := cmd.RequestID()
	defer func() {
		panicked := recover()
		if panicked == nil {
			return
		}
		s.logErr(fmt.Errorf("command %s panicked: %v\n%s", cmd.Kind, panicked, debug.Stack()))
		if !s.serviceMode {
			return
		}
		if requestID != "" {
			// `write` drops a second terminal frame for the same request, so this
			// never doubles up; it must not pre-mark, or the frame it is about to
			// send would look like the duplicate.
			s.write(FrameResult(errorResult(requestID, panicErr(panicked))))
			return
		}
		s.write(FrameProtocolError(ProtocolError{
			ProtocolVersion: ServiceProtocolVersion,
			Code:            "INTERNAL_PANIC",
			Message:         "the engine hit an internal error running that command",
		}))
	}()
	return s.handle(ctx, cmd)
}

// answerFailedCommand tells the app that a command died before it could publish
// a result. The native client holds the mutation slot until a terminal frame
// names its requestId, so a logged error alone left its sheet disabled with no
// way out but a relaunch.
func (s *Server) answerFailedCommand(err error, requestID string) {
	if !s.serviceMode {
		return
	}
	s.write(FrameProtocolError(ProtocolError{
		ProtocolVersion: ServiceProtocolVersion,
		Code:            "COMMAND_FAILED",
		Message:         displaySafeMessage(err.Error()),
		RequestID:       requestID,
	}))
}

// rehydrateManagedBindings restores managed global routes after the app-owned
// service stops its children at shutdown. Direct account routes are left
// alone so startup cannot switch a user's shared native login.
func (s *Server) rehydrateManagedBindings(ctx context.Context) error {
	if s.Deps.Accounts == nil || s.Deps.Bindings == nil || s.Deps.Clients == nil || s.Deps.Providers == nil {
		return nil
	}
	var errs []error
	codexGlobalFailed := false
	for _, clientID := range s.Deps.Clients.IDs() {
		binding, err := s.Deps.Bindings.GetGlobalContext(ctx, clientID)
		if err != nil {
			errs = append(errs, fmt.Errorf("read %s binding: %w", clientID, err))
			continue
		}
		if binding == nil {
			continue
		}
		source := binding.Spec.Source
		switch source.Kind {
		case refs.KindAccount:
			pv, err := s.Deps.Providers.Get(source.Provider)
			if err != nil || pv == nil {
				continue
			}
			// CachedAccount, not Get: this reads Proxy.Enabled and nothing
			// else, and Get takes the provider lock to re-materialize the
			// snapshot cache. Startup runs while another process may hold that
			// scope for a browser sign-in, and a ticker-style read that queues
			// behind it burns the 5s budget and fails. The commit that fixed
			// the display reads left this one on Get and described it as
			// needing real files, which was not true of this call site.
			account, err := s.Deps.Accounts.CachedAccount(ctx, source.Provider, source.Name)
			if err != nil || account == nil {
				continue
			}
			if routeKindForAccount(pv, clientID, source.Name, account.Proxy.Enabled) != "managed-account" {
				continue
			}
		case refs.KindProxyHub:
			// Hub children are stopped with the desktop service. Replaying the
			// saved binding reattaches its stable default route and fresh token.
		default:
			continue
		}
		if err := s.reapplyBinding(ctx, clientID, binding, false); err != nil {
			// One client's refusal must not hide the others: record it for the
			// snapshot and keep restoring.
			s.recordClientConfigIssue(clientID, err)
			if clientID == "codex" {
				codexGlobalFailed = true
			}
			errs = append(errs, fmt.Errorf("restore %s from %s: %w",
				clientID, refs.DisplayRef(source), err))
			continue
		}
		s.clearClientConfigIssue(clientID)
	}
	if err := s.rehydrateCodexProfiles(ctx); err != nil {
		s.recordClientConfigIssue("codex", err)
		errs = append(errs, err)
	} else if !codexGlobalFailed {
		s.clearClientConfigIssue("codex")
	}
	return errors.Join(errs...)
}

// rehydrateCodexProfiles restores profile-specific proxy and Hub credentials.
// Native direct profiles need no service process and remain isolated from the
// desktop login, so only routes that own a managed child are replayed.
//
// Profiles whose account is gone are dropped from the route list first, and
// their credential homes stay on disk. The desktop service starts with
// SkipMaintenance (a detached helper may hold the parent's mutation locks),
// so this is the only sweep that runs here. It must not delete the home.
func (s *Server) rehydrateCodexProfiles(ctx context.Context) error {
	if s.Deps.Activation == nil || s.Deps.Activation.ClientProfiles == nil {
		return nil
	}
	if removed, err := activation.CleanOrphanedProfiles(ctx, s.Deps.Activation); err != nil {
		s.logErr(fmt.Errorf("orphaned Codex profile cleanup: %w", err))
	} else if len(removed) > 0 {
		s.logErr(fmt.Errorf("removed %d Codex profile(s) whose account no longer exists: %s",
			len(removed), strings.Join(activation.ProfileRemovalLabels(removed), ", ")))
	}
	profiles, err := s.Deps.Activation.ClientProfiles.ListContext(ctx, "codex")
	if err != nil {
		return fmt.Errorf("read Codex profiles: %w", err)
	}
	var errs []error
	for _, named := range profiles {
		source := named.Spec.Source
		managed := source.Kind == refs.KindProxyHub || source.Kind == refs.KindAccountPool
		if source.Kind == refs.KindAccount {
			// Codex's own account is direct by default. Other account providers
			// route through a managed proxy when paired with the Codex client.
			managed = source.Provider != "codex" || named.Spec.TransportPolicy == "proxy"
		}
		if !managed {
			continue
		}
		spec := named.Spec
		plan, err := activation.PlanActivation(ctx, activation.Request{
			Mode:         activation.ModeProfile,
			Client:       "codex",
			ProfileName:  named.Name,
			ModelCatalog: s.sourceModelCatalog(ctx, source),
		}, s.Deps.Activation, activation.Options{
			ReapplySpec: &spec,
			ReapplyProv: &bindings.Provenance{Kind: "client_profile_snapshot"},
		})
		if err == nil {
			_, err = activation.Execute(ctx, plan, s.Deps.Activation, activation.ExecuteOptions{})
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("restore Codex profile %s from %s: %w",
				named.Name, refs.DisplayRef(source), err))
		}
	}
	return errors.Join(errs...)
}

type scannedLine struct {
	Line string
	Err  error
}

func (s *Server) scanLines() <-chan scannedLine {
	lines := make(chan scannedLine, 8)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(s.In)
		limit := MaxCommandBytes * 2
		if s.serviceMode {
			limit = MaxServiceFrameBytes
		}
		scanner.Buffer(make([]byte, 0, 64*1024), limit)
		for scanner.Scan() {
			lines <- scannedLine{Line: scanner.Text()}
		}
		if err := scanner.Err(); err != nil {
			lines <- scannedLine{Err: err}
		}
	}()
	return lines
}

func (s *Server) handshake(ctx context.Context, lines <-chan scannedLine) error {
	s.write(FrameEngineHello(s.hello))
	select {
	case <-ctx.Done():
		return ctx.Err()
	case scanned, ok := <-lines:
		if !ok || scanned.Err != nil {
			err := fmt.Errorf("desktop host closed before handshake")
			s.rejectHandshake("HANDSHAKE_INCOMPLETE", err)
			return err
		}
		host, err := decodeHostHello(strings.TrimRight(scanned.Line, "\r\n"))
		if err != nil {
			s.rejectHandshake("HANDSHAKE_REJECTED", err)
			return err
		}
		s.setReportedHostState(host.HostState)
		s.write(FrameHandshakeReady(HandshakeReady{
			ProtocolVersion: ServiceProtocolVersion,
			Capabilities:    negotiatedCapabilities(host.Capabilities),
		}))
		return nil
	}
}

func (s *Server) rejectHandshake(code string, err error) {
	s.write(FrameHandshakeRejected(HandshakeRejected{
		ProtocolVersion: ServiceProtocolVersion,
		Code:            code,
		Message:         err.Error(),
	}))
}

func (s *Server) setReportedHostState(state HostStateReport) {
	s.hostStateMu.Lock()
	s.hostStateReported = true
	s.launchAtLoginEnabled = state.LaunchAtLogin
	s.hostStateMu.Unlock()
}

func (s *Server) reportedLaunchAtLogin() (bool, bool) {
	s.hostStateMu.Lock()
	defer s.hostStateMu.Unlock()
	return s.launchAtLoginEnabled, s.hostStateReported
}

func (s *Server) requestHostEffect(m Mutate, effect config.HostEffectRequest) error {
	s.hostEffectMu.Lock()
	if _, exists := s.pendingHostEffects[m.RequestID]; exists {
		s.hostEffectMu.Unlock()
		return fmt.Errorf("requestId is already awaiting a host effect")
	}
	s.pendingHostEffects[m.RequestID] = effect
	s.inFlight.Add(1)
	s.hostEffectMu.Unlock()

	s.write(FrameHostEffect(HostEffectFrame{
		ProtocolVersion: ServiceProtocolVersion,
		RequestID:       m.RequestID,
		Effect:          effect,
	}))
	go func(requestID string) {
		timer := time.NewTimer(10 * time.Second)
		defer timer.Stop()
		<-timer.C
		s.completeHostEffect(context.Background(), HostEffectResult{
			ProtocolVersion: ServiceProtocolVersion,
			RequestID:       requestID,
			Status:          "error",
			Message:         "The native host did not complete the requested system change.",
		})
	}(m.RequestID)
	return nil
}

func (s *Server) handleHostEffectResult(ctx context.Context, result HostEffectResult) {
	s.completeHostEffect(ctx, result)
}

func (s *Server) completeHostEffect(ctx context.Context, result HostEffectResult) {
	s.hostEffectMu.Lock()
	effect, ok := s.pendingHostEffects[result.RequestID]
	if ok {
		delete(s.pendingHostEffects, result.RequestID)
	}
	s.hostEffectMu.Unlock()
	if !ok {
		return // late or duplicate terminal host result
	}
	defer s.inFlight.Done()

	terminal := Result{
		Version:   ProtocolVersion,
		RequestID: result.RequestID,
		Status:    result.Status,
		Message:   result.Message,
	}
	if result.Status == "success" {
		s.setReportedHostState(result.HostState)
		if effect.Kind == string(config.HostEffectLaunchAtLogin) {
			if result.HostState.LaunchAtLogin {
				terminal.Message = "AnyPick will open at login."
			} else {
				terminal.Message = "Launch at login disabled."
			}
		}
	} else if terminal.Message == "" {
		terminal.Message = "The native host could not complete the system change."
	}
	s.write(FrameResult(terminal))
	if terminal.Status == "success" {
		if err := s.refresh(ctx); err != nil && err != errShutdown {
			s.logErr(err)
		}
	}
}

func (s *Server) cancelPendingHostEffects() {
	s.hostEffectMu.Lock()
	count := len(s.pendingHostEffects)
	s.pendingHostEffects = map[string]config.HostEffectRequest{}
	s.hostEffectMu.Unlock()
	for range count {
		s.inFlight.Done()
	}
}

// Wait blocks until every in-flight mutation handler — including its trailing
// refresh — has finished. Tests that drive handle directly (bypassing Run's
// graceful shutdown) must call it before closing the database; otherwise a
// late refresh touches a closed store.
func (s *Server) Wait() { s.inFlight.Wait() }

// shutdown stops proxies it started, then closes the stream.
func (s *Server) shutdown(_ context.Context) error {
	ctx := context.Background()
	s.stopOnce.Do(func() {
		if s.stopCh != nil {
			close(s.stopCh)
		}
	})
	s.cancelMu.Lock()
	for _, cancel := range s.cancellables {
		cancel()
	}
	s.cancelMu.Unlock()
	s.cancelPendingHostEffects()
	// A graceful service exit cannot return while an operation can still emit
	// a late terminal result. The native host owns the outer kill timeout, and
	// an adapter that ignores cancellation must not pin the process past it.
	if !s.waitForInFlight(inflightShutdownWait) {
		s.logErr(fmt.Errorf("shutdown: work still running after %s", inflightShutdownWait))
	}
	if s.Deps.ShutdownOwned != nil {
		if err := s.Deps.ShutdownOwned(ctx); err != nil {
			// Quit remains best-effort. A verified stop failure stays on
			// stderr and in its ownership record; it must not
			// wedge the native app's outer shutdown forever.
			s.logErr(err)
		}
		return nil
	}
	for _, providerID := range s.Deps.Providers.IDs() {
		list, err := s.Deps.Accounts.List(ctx, providerID)
		if err != nil {
			continue
		}
		for _, acc := range list {
			cfg, _ := s.Deps.Proxy.ProxyConfig(ctx, providerID, acc.Meta.Name)
			if !cfg.Enabled {
				continue
			}
			_ = s.Deps.Proxy.Stop(ctx, providerID, acc.Meta.Name)
		}
	}
	return nil
}

func (s *Server) refresh(ctx context.Context) error {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	snap, err := s.buildSnapshot(ctx)
	if err != nil {
		s.snapshotDirty.Store(true)
		return err
	}
	s.snapshotDirty.Store(false)
	if s.serviceMode && s.snapshotSent {
		s.write(FrameSnapshotEvent(SnapshotEvent{
			ProtocolVersion: ServiceProtocolVersion,
			Revision:        snap.Revision,
			Reason:          "state-changed",
			Snapshot:        snap,
		}))
	} else {
		s.write(FrameSnapshot(snap))
	}
	s.snapshotSent = true
	return nil
}

func (s *Server) refreshUsage(ctx context.Context) error {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	s.write(FrameUsageEvent(UsageEvent{
		ProtocolVersion: ServiceProtocolVersion,
		Revision:        s.currentRevision(),
		Usage:           s.buildUsage(ctx),
	}))
	return nil
}

func (s *Server) write(line string) {
	if s.serviceMode {
		if prefix, _, _ := strings.Cut(line, "\t"); prefix == "result" || prefix == "protocol-error" {
			// A terminal frame is the one answer a request gets. A handler that
			// finishes after its watchdog, or after the panic recovery, must not
			// add a second one: the host drops it, but it can only mislead.
			if requestID := RequestIDFromLine(line); requestID != "" && s.markAnswered(requestID) {
				s.logErr(fmt.Errorf("dropped a second terminal frame for %s", requestID))
				return
			}
		}
	}
	if s.serviceMode && len(line) > MaxServiceFrameBytes {
		// The oversized frame may be the only answer a request will ever get,
		// so the replacement keeps its requestId: an unattributed rejection
		// leaves that row spinning.
		line = FrameProtocolError(ProtocolError{
			ProtocolVersion: ServiceProtocolVersion,
			Code:            "FRAME_TOO_LARGE",
			Message:         "output frame exceeded the configured bound",
			RequestID:       RequestIDFromLine(line),
		})
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, _ = io.WriteString(s.Out, line+"\n")
}

// markAnswered records that a request has received its terminal frame and
// reports whether it had one already. Two situations depend on it: a recovery
// path must not answer a request twice (the host would show an internal error
// after a success), and a duplicate command must not run its handler twice.
func (s *Server) markAnswered(requestID string) bool {
	if requestID == "" {
		return false
	}
	s.answeredMu.Lock()
	defer s.answeredMu.Unlock()
	if _, seen := s.answered[requestID]; seen {
		return true
	}
	if s.answered == nil {
		s.answered = map[string]struct{}{}
	}
	s.answered[requestID] = struct{}{}
	s.answeredOrder = append(s.answeredOrder, requestID)
	// Bounded: only a duplicate of a recent command matters, and an unbounded
	// map would grow for the life of an app session.
	if len(s.answeredOrder) > maxAnsweredRequests {
		oldest := s.answeredOrder[0]
		s.answeredOrder = s.answeredOrder[1:]
		delete(s.answered, oldest)
	}
	return false
}

// reserveRequest claims a requestId for one dispatch and reports whether another
// dispatch already has it. A retried command must not run its handler twice;
// unlike markAnswered this says nothing about whether a frame was written.
func (s *Server) reserveRequest(requestID string) bool {
	if requestID == "" {
		return false
	}
	s.answeredMu.Lock()
	defer s.answeredMu.Unlock()
	if _, seen := s.reserved[requestID]; seen {
		return true
	}
	if s.reserved == nil {
		s.reserved = map[string]struct{}{}
	}
	s.reserved[requestID] = struct{}{}
	s.reservedOrder = append(s.reservedOrder, requestID)
	if len(s.reservedOrder) > maxAnsweredRequests {
		oldest := s.reservedOrder[0]
		s.reservedOrder = s.reservedOrder[1:]
		delete(s.reserved, oldest)
	}
	return false
}

func (s *Server) logErr(err error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	fmt.Fprintf(os.Stderr, "[desktop] %v\n", err)
}

func (s *Server) currentRevision() int {
	s.actionsMu.Lock()
	defer s.actionsMu.Unlock()
	return s.revision
}

// actionOptions carries the request-scoped choices one invoke command made.
//
// It is a parameter rather than a context value on purpose: consent to replace
// a client config AnyPick does not own is a security-relevant decision, and a
// context value is silently lost the moment a service in the chain hands the
// handler a detached context (`context.WithoutCancel`, a PostSwitch callback)
// for good reasons of its own. Every handler takes it, so the compiler — not a
// reviewer's memory — guarantees an action cannot run without seeing it.
type actionOptions struct {
	// AllowForeignConfig is the user's answer to a CLIENT_CONFIG_FOREIGN
	// refusal. It is set only by invoke.allowForeignConfig and never persisted.
	AllowForeignConfig bool
}

// actionHandler runs one action row the snapshot published.
type actionHandler func(context.Context, actionOptions) error

func (s *Server) actionHandler(id string) (actionHandler, bool) {
	s.actionsMu.Lock()
	defer s.actionsMu.Unlock()
	if h, ok := s.actions[id]; ok {
		return h, true
	}
	h, ok := s.prevActions[id]
	return h, ok
}

// routeActivator returns a handler that binds clientID to source through the
// persistent planner/executor. Route actions must never mutate a provider's active account directly and never
// succeed silently. Re-selecting the source a client already has re-applies the
// stored spec, so model roles and the transport policy are not reset.
//
// Both branches forward the command's takeover consent. Dropping it on the
// re-apply branch made the app's own "confirm the takeover" offer a dead end:
// a client with a saved route plus a config the user pointed elsewhere always
// resolves to the re-apply branch, so the refusal repeated forever.
func (s *Server) routeActivator(clientID string, source refs.Ref) actionHandler {
	return func(c context.Context, opts actionOptions) error {
		if s.Deps.Bindings != nil {
			if b, err := s.Deps.Bindings.GetGlobalContext(c, clientID); err == nil &&
				b != nil && refs.SerializeRef(b.Spec.Source) == refs.SerializeRef(source) {
				return s.reapplyBinding(c, clientID, b, opts.AllowForeignConfig)
			}
		}
		return s.activateRouteWith(c, clientID, source, activateRouteOptions{
			allowForeignConfig: opts.AllowForeignConfig,
		})
	}
}

type activateRouteOptions struct {
	// restoreOnly rebuilds an already-configured route after a service
	// restart. It must not run live model discovery, and it must not rewrite a
	// native login the user may have changed since the binding was created.
	restoreOnly bool
	// allowForeignConfig is the user's consent to replace client settings
	// AnyPick does not own (activateRouteOptions → activation.ExecuteOptions).
	allowForeignConfig bool
}

func (s *Server) activateRoute(ctx context.Context, clientID string, source refs.Ref) error {
	return s.activateRouteWith(ctx, clientID, source, activateRouteOptions{})
}

func (s *Server) activateRouteWith(ctx context.Context, clientID string, source refs.Ref, routeOpts activateRouteOptions) error {
	if s.Deps.Activation == nil {
		return anyerr.Newf("activation service is unavailable in this composition",
			"ACTIVATION_UNAVAILABLE")
	}
	// Model selection resolves per source, with provider defaults underneath
	// (ADR-0028): explicit per-connection pins win, stored provider defaults
	// fill the rest, and the engine default covers what neither names. If a
	// borrowing client has no cached account/gateway catalog yet, warm that
	// exact source before planning so its
	// native config never receives a model from another connection.
	modelCatalog := s.sourceModelCatalog(ctx, source)
	if !routeOpts.restoreOnly {
		if source.Kind == refs.KindGateway {
			// A configured gateway default is useful for planning but does not prove
			// that the endpoint's complete model list is current. Warm a cold gateway
			// cache even when that default already exists.
			s.warmRouteModelCatalog(ctx, clientID, source)
			modelCatalog = s.sourceModelCatalog(ctx, source)
		} else if len(modelCatalog) == 0 {
			s.warmRouteModelCatalog(ctx, clientID, source)
			modelCatalog = s.sourceModelCatalog(ctx, source)
		}
	}
	req := activation.Request{
		Mode:         activation.ModePersistent,
		Client:       clientID,
		Source:       &source,
		ModelCatalog: modelCatalog,
	}
	// ZCode needs a model before it can even open its provider map. Use the
	// account-scoped cache when available (dynamic models win), then let the
	// activation planner use the provider-owned cold-start hint.
	if model := s.routeDefaultModel(ctx, clientID, source); model != "" {
		req.Model = model
	}
	plan, err := activation.PlanActivation(ctx, req, s.Deps.Activation,
		activation.Options{SkipNativeAuthWrite: routeOpts.restoreOnly})
	if err != nil {
		return err
	}
	// Consent precedence:
	//   1. the user confirmed this exact command (invoke.allowForeignConfig
	//      from the app, or --allow-foreign-config on the CLI);
	//   2. a stale loopback value the adapter can prove is AnyPick's own
	//      (client.Preflight owns it by shape, not by consent).
	// Nothing else grants it. A re-apply of a saved binding does NOT: if the
	// user pointed the client at their own endpoint since, the apply fails
	// closed with CLIENT_CONFIG_FOREIGN and the start reports why instead of
	// silently rewriting their login.
	return s.executeRouteActivation(ctx, clientID, plan, routeOpts.allowForeignConfig)
}

// executeRouteActivation runs one route plan and keeps the snapshot's
// client-config condition in step with the outcome.
func (s *Server) executeRouteActivation(ctx context.Context, clientID string, plan *activation.Plan, takeover bool) error {
	_, err := activation.Execute(ctx, plan, s.Deps.Activation, activation.ExecuteOptions{
		AllowForeignConfig: takeover,
	})
	if err != nil {
		// A refusal is current state, not just an alert the user can dismiss:
		// the app keeps showing the route as active, and this is why it is not.
		if isForeignConfigRefusal(err) {
			s.recordClientConfigIssue(clientID, err)
		}
		return err
	}
	s.clearClientConfigIssue(clientID)
	return nil
}

// isForeignConfigRefusal reports whether an activation was refused because the
// client's live config holds values AnyPick does not own.
func isForeignConfigRefusal(err error) bool {
	var ae *anyerr.Error
	return errors.As(err, &ae) && ae != nil && ae.Code == "CLIENT_CONFIG_FOREIGN"
}

func (s *Server) warmRouteModelCatalog(ctx context.Context, clientID string, source refs.Ref) {
	if s == nil {
		return
	}
	if source.Kind == refs.KindGateway {
		if s.Deps.Profiles == nil {
			return
		}
		pr, err := s.Deps.Profiles.GetContext(ctx, source.Name)
		if err != nil || pr == nil {
			return
		}
		_, cached := s.gatewayCatalogList(ctx, pr)
		if !cached {
			s.warmGatewayModelCatalogBestEffort(ctx, source.Name)
		}
		return
	}
	if source.Kind == refs.KindAccountPool {
		if len(s.accountPoolCatalogList(ctx, source.Provider)) == 0 {
			s.warmAccountPoolModelCatalog(ctx, source.Provider)
		}
		return
	}
	if source.Kind == refs.KindProxyHub {
		s.warmAccountCatalogsForHub(ctx, source.Name)
		return
	}
	if source.Kind != refs.KindAccount || s.discoveryService() == nil {
		return
	}
	// Warm the exact source before planning so a cross-provider proxy binding
	// (e.g. Claude on a Grok account) publishes its model options even when
	// the client itself needs no default model. Native same-family routes
	// (the client's own login, app's own picker) have no proxy catalog: the
	// provider cannot proxy, so there is nothing to warm and no egress to spend.
	if s.Deps.Providers != nil {
		if pv, err := s.Deps.Providers.Get(source.Provider); err != nil || pv == nil || !pv.CanProxy() {
			return
		}
	} else {
		cad, err := s.Deps.Clients.Get(clientID)
		if err != nil || cad == nil || cad.Capabilities() == nil ||
			!cad.Capabilities().RequiresDefaultModel {
			return
		}
	}
	if len(s.accountCatalogList(ctx, source)) > 0 {
		return
	}
	s.warmAccountModelCatalogBestEffort(ctx, source.Provider, source.Name)
}

func (s *Server) routeDefaultModel(ctx context.Context, clientID string, source refs.Ref) string {
	if s == nil || s.Deps.Clients == nil {
		return ""
	}
	cad, err := s.Deps.Clients.Get(clientID)
	if err != nil || cad == nil || cad.Capabilities() == nil ||
		!cad.Capabilities().RequiresDefaultModel {
		return ""
	}

	// Re-applying the selected route must preserve the model already pinned on
	// that binding. A route switch without one can then choose from discovery.
	if s.Deps.Bindings != nil {
		if binding, berr := s.Deps.Bindings.GetGlobalContext(ctx, clientID); berr == nil &&
			binding != nil && refs.SerializeRef(binding.Spec.Source) == refs.SerializeRef(source) {
			if model := primaryModelOf(binding.Spec); model != "" {
				if source.Kind != refs.KindAccount && source.Kind != refs.KindAccountPool && source.Kind != refs.KindProxyHub {
					return model
				}
				// A model pinned for this source remains valid only while the
				// source-scoped catalog still publishes it. If entitlement or a
				// proxy rollout changed, fall through to the current catalog.
				models := s.sourceModelCatalog(ctx, source)
				if len(models) == 0 || containsModel(models, model) {
					return model
				}
			}
		}
	}

	if source.Kind == refs.KindAccount || source.Kind == refs.KindAccountPool {
		models := s.sourceModelCatalog(ctx, source)
		if len(models) > 0 {
			return models[0]
		}
		return s.providerFallbackDefaultModel(source.Provider)
	}

	if source.Kind == refs.KindProxyHub {
		models := s.sourceModelCatalog(ctx, source)
		if len(models) > 0 {
			return models[0]
		}
		if s.Deps.Hub != nil {
			if cfg, err := s.Deps.Hub.GetConfigContext(ctx, source.Name); err == nil && cfg != nil {
				for _, src := range cfg.Sources {
					if !src.IsEnabled() {
						continue
					}
					pID := src.ProviderID
					if p, ok := hub.PoolSourceProvider(src); ok {
						pID = p
					}
					if m := s.providerFallbackDefaultModel(pID); m != "" {
						return m
					}
				}
			}
		}
	}
	return ""
}

func (s *Server) providerFallbackDefaultModel(providerID string) string {
	if pol := catalog.Policy(providerID); pol != nil {
		if def := strings.TrimSpace(pol.RoleDefaults["default"]); def != "" {
			return def
		}
		for _, m := range pol.StaticFallback {
			if m = strings.TrimSpace(m); m != "" {
				return m
			}
		}
	}
	if s.Deps.Providers != nil {
		if pv, err := s.Deps.Providers.Get(providerID); err == nil && pv != nil {
			if c, ok := pv.(*provider.Compatible); ok && c != nil {
				for _, m := range c.Def.Models {
					if m = strings.TrimSpace(m); m != "" {
						return m
					}
				}
			}
		}
	}
	return ""
}

func containsModel(models []string, want string) bool {
	for _, model := range models {
		if model == want {
			return true
		}
	}
	return false
}

// accountSwitchAction returns the Accounts-pane handler that makes one saved
// account current. Use commits the pointer, realigns the binding and starts the
// target proxy; the PostSwitch reapply rewrites bound clients (WorkBuddy's
// models.json and friends) before Use returns success. A failed reapply rolls
// everything back, so the pane cannot show "work" while models.json still
// points at the previous account's stopped proxy.
func (s *Server) accountSwitchAction(providerID, name string) actionHandler {
	return func(c context.Context, opts actionOptions) error {
		_, err := s.Deps.Accounts.Use(c, providerID, name, accounts.UseOptions{
			PostSwitch: func(pc context.Context) error {
				// opts travels into the closure: the switch's post-step runs
				// inside the accounts service, and reading consent back out of
				// the context there would depend on that service never
				// detaching it.
				return s.reapplyClientsBoundTo(pc, refs.AccountRef(providerID, name),
					opts.AllowForeignConfig)
			},
		})
		return err
	}
}

// reapplyClientsBoundTo rewrites every persistent client whose global binding
// is this account. Starting a proxy from the Proxies pane does not go through
// `use`, so without this the live token and ~/.claude/settings.json diverge
// and Claude Code 401s until the next activation.
//
// The stored spec travels with the reapply: planning a fresh source request
// would reset model roles and the transport policy (the TUI had the same bug).
//
// Consent is NOT implied here. A client config AnyPick wrote is recognised by
// the adapter itself (a loopback proxy endpoint is AnyPick's own value), so the
// stale-token repair still works; a config the user has since pointed at their
// own endpoint is refused and reported as a degraded condition instead of being
// overwritten.
func (s *Server) reapplyClientsBoundTo(ctx context.Context, source refs.Ref, allowForeign bool) error {
	if s.Deps.Activation == nil || s.Deps.Bindings == nil || s.Deps.Clients == nil {
		return nil
	}
	want := refs.SerializeRef(source)
	canUndo := s.Deps.Activation != nil && s.Deps.Activation.Runtime != nil
	var recovery [][]string
	for _, clientID := range s.Deps.Clients.IDs() {
		b, err := s.Deps.Bindings.GetGlobalContext(ctx, clientID)
		if err != nil || b == nil {
			continue
		}
		if refs.SerializeRef(b.Spec.Source) != want {
			continue
		}
		var records []string
		if canUndo {
			records, err = s.Deps.Activation.Runtime.PrepareClientConfigRecovery(
				clientID, fmt.Sprintf("reapply-%s-%d", clientID, time.Now().UnixNano()))
			if err != nil {
				return finishReapply(recovery, fmt.Errorf("%s: %w", clientID, err))
			}
		}
		if err := s.reapplyBinding(ctx, clientID, b, allowForeign); err != nil {
			s.recordClientConfigIssue(clientID, err)
			cause := fmt.Errorf("%s: %w", clientID, err)
			if !canUndo && len(recovery) > 0 {
				return accounts.IncompleteClientRestore(cause)
			}
			return finishReapply(append(recovery, records), cause)
		}
		s.clearClientConfigIssue(clientID)
		recovery = append(recovery, records)
	}
	return nil
}

// finishReapply puts client configs taken before this reapply back. A restore
// failure is marked incomplete so the switch notice does not claim the
// clients were returned to the previous account.
func finishReapply(recovery [][]string, cause error) error {
	var restoreErr error
	for i := len(recovery) - 1; i >= 0; i-- {
		if err := runtime.RestoreClientConfigRecovery(recovery[i]); err != nil {
			restoreErr = errors.Join(restoreErr, err)
		}
	}
	if restoreErr != nil {
		return accounts.IncompleteClientRestore(errors.Join(cause, restoreErr))
	}
	return cause
}

// reapplyBinding re-plans one stored binding without touching the source, and
// applies it with the caller's answer on taking over client settings AnyPick
// does not own. The pinned model is kept while the cached source catalog still
// publishes it; otherwise the spec falls back to an omitted selection so the
// planner bootstraps from the current catalog.
//
// Consent is a parameter, not an inference: the startup restore, a user
// confirmation from the app and the CLI flag are different callers with
// different standing, and the old `false`-only wrapper just hid that the
// re-apply branch was silently dropping it.
func (s *Server) reapplyBinding(ctx context.Context, clientID string, b *bindings.Global, allowForeign bool) error {
	catalog := s.sourceModelCatalog(ctx, b.Spec.Source)
	specCopy := b.Spec
	if model := primaryModelOf(b.Spec); model != "" && len(catalog) > 0 && !containsModel(catalog, model) {
		specCopy.Model = bindings.OmittedModel()
	}
	plan, err := activation.PlanActivation(ctx, activation.Request{
		Mode:         activation.ModePersistent,
		Client:       clientID,
		ModelCatalog: catalog,
	}, s.Deps.Activation, activation.Options{
		ReapplySpec: &specCopy,
		ReapplyProv: &bindings.Provenance{
			Kind:                   "global_binding_snapshot",
			GlobalBindingUpdatedAt: b.UpdatedAt,
		},
		SkipNativeAuthWrite: true,
	})
	if err != nil {
		return err
	}
	_, err = activation.Execute(ctx, plan, s.Deps.Activation, activation.ExecuteOptions{
		AllowForeignConfig: allowForeign,
	})
	return err
}

func (s *Server) handle(ctx context.Context, cmd *Command) error {
	switch cmd.Kind {
	case "open", "navigate", "restart":
		// Host concerns; nothing for the engine to do.
		return nil

	case "refresh":
		return s.refresh(ctx)

	case "stop", "quit":
		return errShutdown

	case "cancel":
		var p cancelPayload
		// DecodeLine strictly validates every payload before dispatch, so a
		// decode failure here is unreachable from the wire; an unreadable
		// frame already got its protocol-error answer there. Nothing to look
		// up means nothing to cancel either way.
		_ = json.Unmarshal(cmd.Payload, &p)
		s.cancelMu.Lock()
		cancelFn, ok := s.cancellables[p.RequestID]
		s.cancelMu.Unlock()
		if ok {
			cancelFn()
			return nil
		}
		// The cancel may arrive before the handler it cancels: commands are
		// dispatched off the loop, so the loop is free to read the cancel frame
		// while the handler is still starting. Dropping it would leave the host
		// waiting on an action the user already cancelled. Record it and let
		// the registration honour it.
		s.cancelMu.Lock()
		if s.cancelLedger == nil {
			s.cancelLedger = map[string]time.Time{}
		}
		s.cancelLedger[p.RequestID] = time.Now()
		for id, at := range s.cancelLedger {
			if time.Since(at) > cancelLedgerTTL {
				delete(s.cancelLedger, id)
				continue
			}
			if len(s.cancelLedger) > maxCancelLedger {
				delete(s.cancelLedger, id)
			}
		}
		s.cancelMu.Unlock()
		return nil

	case "invoke":
		var p invokePayload
		if err := json.Unmarshal(cmd.Payload, &p); err != nil {
			return err
		}
		if p.Revision < s.currentRevision()-1 {
			s.write(FrameResult(errorResult(p.RequestID, anyerr.Newf(
				"stale action", "STALE_ACTION",
				anyerr.WithSuggestions("Refresh the app, then try again.")))))
			return nil
		}
		if s.reserveRequest(p.RequestID) {
			// A retried action must not run twice: the first answer already
			// reached the host, and a second run would repeat its writes.
			s.write(FrameResult(errorResult(p.RequestID, anyerr.Newf(
				"That action was already applied.", "STATE_CONFLICT"))))
			return nil
		}
		handler, ok := s.actionHandler(p.ActionID)
		if !ok {
			s.write(FrameResult(errorResult(p.RequestID, anyerr.Newf(
				"unknown action", "UNKNOWN_ACTION",
				anyerr.WithSuggestions("Refresh the app; the action may have been replaced.")))))
			return nil
		}
		// Run the action off the main select loop so a long mutation does
		// not stall the 2.5 s ticker or delay other commands (P1). The
		// handler runs with a background context so parent cancellation
		// does not abandon the mutation mid-write.
		s.inFlight.Add(1)
		go func(reqID string, h actionHandler, opts actionOptions) {
			defer s.inFlight.Done()
			// A panic inside a provider adapter is a bug, not a reason to take
			// the user's proxies down with it: the recovered frame keeps the app
			// usable and tells it what to do, while the engine log keeps the
			// stack. The mutation may already have written, so the warning is
			// mandatory — see Result.Fail's Mutated handling.
			defer func() {
				if panicked := recover(); panicked != nil {
					s.logErr(fmt.Errorf("mutation %s panicked: %v\n%s", reqID, panicked, debug.Stack()))
					s.write(FrameResult(errorResult(reqID, panicErr(panicked))))
				}
			}()
			bgCtx, cancel := context.WithTimeout(context.Background(), DesktopActionTimeout)
			defer cancel()
			result := Result{Version: ProtocolVersion, RequestID: reqID, Status: "success"}
			if err := h(bgCtx, opts); err != nil {
				result = result.Fail(err)
			}
			s.write(FrameResult(result))
			if err := s.refresh(bgCtx); err != nil && err != errShutdown {
				s.logErr(err)
			}
		}(p.RequestID, handler, actionOptions{AllowForeignConfig: p.AllowForeignConfig})
		return nil

	case "model-roles":
		var p modelRolesPayload
		if err := json.Unmarshal(cmd.Payload, &p); err != nil {
			return err
		}
		if p.Revision > 0 && p.Revision < s.currentRevision()-1 {
			// Action ids are revision-scoped: resolving a stale one would apply
			// model choices against a source the user no longer sees.
			s.write(FrameResult(errorResult(p.RequestID, anyerr.Newf(
				"the model list changed; refresh AnyPick and choose the models again",
				"STALE_ACTION"))))
			return nil
		}
		err := s.applyModelRoles(ctx, p.ClientID, p.RoleActionIDs, p.Scope)
		res := Result{Version: ProtocolVersion, RequestID: p.RequestID}
		if err != nil {
			res = res.Fail(err)
		} else {
			res.Status = "success"
		}
		s.write(FrameResult(res))
		if res.Status == "success" {
			return s.refresh(ctx)
		}
		return nil

	case "backup-inspect":
		var p backupInspectPayload
		if err := json.Unmarshal(cmd.Payload, &p); err != nil {
			return err
		}
		preview, err := s.inspections.Inspect(p.RequestID, p.Path)
		if err != nil {
			s.write(FrameBackupPreview(inspectionFailure(p.RequestID, err)))
			return nil
		}
		// The native app drops previews whose requestId does not match the
		// in-flight request — Inspect must echo it on the ready path too.
		s.write(FrameBackupPreview(*preview))
		return nil

	case "logs":
		return s.handleLogs(ctx, cmd.Payload)

	case "doctor":
		return s.handleDoctor(ctx, cmd.Payload)

	case "mutate":
		return s.handleMutate(ctx, cmd.Payload)
	}
	return nil
}

func (s *Server) handleLogs(ctx context.Context, payload json.RawMessage) error {
	var p logsPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		return err
	}
	res := ProxyLogsResult{Version: ProtocolVersion, RequestID: p.RequestID,
		ProxyID: p.ProviderID + "/" + p.Name, State: "not-running"}
	var running bool
	if p.ProviderID == "proxy-hub" {
		cfg, _ := s.hubConfigOrNil(ctx, p.Name)
		port, host := 0, ""
		if cfg != nil {
			port, host = cfg.Port, cfg.Host
		}
		running, _ = s.hubLive(p.Name, port, host)
	} else {
		st, err := s.Deps.Proxy.StatusContext(ctx, p.ProviderID, p.Name)
		running = err == nil && st != nil && st.Running
	}
	if running {
		res.State = "empty"
	}
	// The engine's own log file flows through the Service: historical logs
	// survive a stop and provider-controlled text is secret-screened before
	// it is framed to the native app. A read failure reports "error" WITHOUT
	// blanking the tail: the client keeps its last good text (L4). Only a
	// successful read may replace it.
	var text string
	var terr error
	if p.ProviderID == "proxy-hub" {
		// Hub children log to runtime/hub/<name>/service.log, not an
		// account runtime dir, so the account tail below would always miss.
		text, terr = tailHubLog(s.Deps.Root, p.Name, p.Lines)
	} else {
		text, terr = s.Deps.Proxy.ProxyLogs(ctx, p.ProviderID, p.Name, p.Lines)
	}
	if terr != nil {
		res.State = "error"
	} else if text != "" {
		res.State = "ready"
		res.Text = text
	}
	s.write(FrameProxyLogs(res))
	return nil
}

func (s *Server) handleDoctor(ctx context.Context, payload json.RawMessage) error {
	var request doctorPayload
	if err := json.Unmarshal(payload, &request); err != nil {
		return err
	}
	report := doctor.DiagnoseInstallation(ctx, doctor.InstallationDeps{
		Root:              s.Deps.Root,
		Providers:         s.Deps.Providers,
		Clients:           s.Deps.Clients,
		Accounts:          s.Deps.Accounts,
		Bindings:          s.Deps.Bindings,
		Proxy:             s.Deps.Proxy,
		Environment:       s.Deps.Environment,
		PluginDiagnostics: s.Deps.PluginDiagnostics,
		NamedProfiles:     s.namedProfileRefs,
	})
	s.write(FrameDoctor(DoctorResult{
		Version:   ProtocolVersion,
		RequestID: request.RequestID,
		Status:    report.Status,
		Findings:  report.Findings,
	}))
	return nil
}

// namedProfileRefs adapts the client profile store to the doctor's leaf shape
// (internal/doctor does not import internal/client).
func (s *Server) namedProfileRefs(ctx context.Context) ([]doctor.NamedProfileRef, error) {
	if s.Deps.Activation == nil || s.Deps.Activation.ClientProfiles == nil {
		return nil, nil
	}
	profiles, err := s.Deps.Activation.ClientProfiles.ListAllContext(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]doctor.NamedProfileRef, 0, len(profiles))
	for _, p := range profiles {
		out = append(out, doctor.NamedProfileRef{
			Client: p.Client, Name: p.Name,
			SourceKind: string(p.Spec.Source.Kind),
			Provider:   p.Spec.Source.Provider, AccountName: p.Spec.Source.Name,
		})
	}
	return out, nil
}

// snapshotModelRoleTargets copies the current revision's model-option
// registry. Resolution reads a copy so a concurrent snapshot swap cannot
// half-apply two revisions' ids.
func (s *Server) snapshotModelRoleTargets() map[string]modelRoleTarget {
	s.actionsMu.Lock()
	defer s.actionsMu.Unlock()
	out := make(map[string]modelRoleTarget, len(s.modelRoleTargets))
	for id, target := range s.modelRoleTargets {
		out[id] = target
	}
	return out
}

// applyModelRoles re-activates a client's persistent binding with explicit
// per-role models (the Go counterpart of supervisor model-role actions).
//
// The submitted map is role id → *action id*, never a model id: every model
// the host may choose was published as an opaque id in the snapshot, and this
// resolves those ids back to (client, source, model) before planning — the
// storeProviderModelRoles persists one provider-scope save. Split out of
// applyModelRoles so the command handler stays under the long-function gate.
func (s *Server) storeProviderModelRoles(
	ctx context.Context, source *refs.Ref, modelRoles map[string]string,
) error {
	if s.Deps.Bindings == nil {
		return anyerr.Newf("activation service is unavailable in this composition",
			"ACTIVATION_UNAVAILABLE")
	}
	key := bindings.ModelRolesProviderKey(*source)
	if key == "" {
		return anyerr.Newf("this connection has no provider to save defaults for",
			"INVALID_SELECTION")
	}
	return s.Deps.Bindings.SetProviderModelRoles(ctx, key, modelRoles)
}

// Only ids the server published are resolvable. Nothing the host sends is
// trusted past the id, so a hand-written model id cannot reach activation.
//
// Scope selects where the choice lands. "connection" (default, historical)
// pins this connection. "provider" stores the choice as the provider default
// and re-resolves this connection against it, so one setting covers every
// account of the provider. An empty map on the connection scope clears the
// pins (reset to provider-or-engine default); the default-model requirement
// only applies when something is actually being pinned.
func (s *Server) applyModelRoles(ctx context.Context, clientID string, roleActionIDs map[string]string, scope string) error {
	if len(roleActionIDs) > 0 && roleActionIDs["default"] == "" {
		return anyerr.Newf("choose a Default model before applying model settings",
			"INVALID_SELECTION")
	}
	allowed := client.AllowedRoleIDs(clientID)
	targets := s.snapshotModelRoleTargets()
	modelRoles := map[string]string{}
	var source *refs.Ref
	for role, actionID := range roleActionIDs {
		if !allowed[role] {
			return anyerr.Newf("that model role is not supported by this app",
				"INVALID_SELECTION")
		}
		target, ok := targets[actionID]
		if !ok || target.ClientID != clientID {
			return anyerr.Newf(
				"the model list changed; refresh AnyPick and choose the models again",
				"INVALID_SELECTION")
		}
		switch {
		case source == nil:
			src := target.Source
			source = &src
		case *source != target.Source:
			// One journalled activation covers one source; mixing models from
			// two connections would silently re-bind the client.
			return anyerr.Newf("choose models from one connection", "INVALID_SELECTION")
		}
		modelRoles[role] = target.ModelID
	}
	if len(roleActionIDs) == 0 {
		// Reset (and provider-default clear): nothing was picked, so there
		// is no source to resolve from the selection. Fall back to the
		// client's current binding; without one there is nothing to clear
		// or re-resolve.
		if s.Deps.Bindings == nil {
			return anyerr.Newf("activation service is unavailable in this composition",
				"ACTIVATION_UNAVAILABLE")
		}
		binding, berr := s.Deps.Bindings.GetGlobalContext(ctx, clientID)
		if berr != nil {
			return berr
		}
		if binding == nil {
			return anyerr.Newf("this app has no connection to reset",
				"INVALID_SELECTION")
		}
		src := binding.Spec.Source
		source = &src
	}
	if scope == "provider" {
		// Store first, then plan without roles so the fresh-source branch
		// copies them back as inherited pins (marker "provider") instead of
		// stamping this save as a per-connection customization.
		if err := s.storeProviderModelRoles(ctx, source, modelRoles); err != nil {
			return err
		}
		modelRoles = nil
	}
	plan, err := activation.PlanActivation(ctx, activation.Request{
		Mode:         activation.ModePersistent,
		Client:       clientID,
		Source:       source,
		ModelRoles:   modelRoles,
		ModelCatalog: s.sourceModelCatalog(ctx, *source),
	}, s.Deps.Activation, activation.Options{})
	if err != nil {
		return err
	}
	_, err = activation.Execute(ctx, plan, s.Deps.Activation, activation.ExecuteOptions{})
	return err
}
