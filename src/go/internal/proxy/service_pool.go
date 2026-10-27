// Pool lifecycle (StartPoolProxy/StopPoolProxy): one shared pool proxy per
// provider serving every enabled member account through a credential ring
// with Quota Guard failover.
//
// Invariants carried over:
//   - multi-mode + ≥1 enabled member or POOL_NOT_ENABLED / POOL_EMPTY;
//   - loopback-only host;
//   - the primary member's own proxy config points at the pool port WITHOUT
//     auth dirs — the record outlives the pool;
//   - the previous pool AND the primary's single-account proxy are stopped
//     before binding (port collision);
//   - token reuse: prior non-empty proxy_state token wins over a fresh one,
//     and the pool token lives ONLY in proxy_state (never stdout/logs);
//   - the pool lease is keyed (provider, "");
//   - mutations run under refs.ProviderScope(providerID) — never per-account
//     scopes, because all accounts share the provider's live credential file
//     (ADR 0011).
package proxy

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/paths"
	"github.com/outof0/anypick/go/internal/quotacache"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/store"
	"github.com/outof0/anypick/go/internal/upstream"
)

func poolScope(providerID string) string { return "pool/" + providerID }

// defaultPoolPort is the last-resort pool port when neither the pool row nor
// the provider default names one.
const defaultPoolPort = 8080

// defaultPortFor resolves the provider's advertised default proxy port via the
// composition hook; 0 when unwired.
func (s *Service) defaultPortFor(providerID string) int {
	if s.DefaultPort == nil {
		return 0
	}
	return s.DefaultPort(providerID)
}

// pickPoolToken reuses a surviving record's token so issued client configs
// stay valid; otherwise a fresh secret is generated.
func pickPoolToken(prior *store.ProxyRuntimeState) (string, error) {
	if prior != nil && prior.Token != "" {
		return prior.Token, nil
	}
	token, err := NewToken()
	if err != nil {
		return "", anyerr.Wrapf(err, "generate proxy token", "PROXY_START_FAILED")
	}
	return token, nil
}

// poolServer tracks running in-process PoolServers keyed by provider. Pools
// have no account identity, so their lease and registry key are (provider, "")
// — deliberately distinct from single-account slots.
type poolServerRegistry struct {
	mu sync.Mutex
	m  map[string]*PoolServer
}

func newPoolServerRegistry() *poolServerRegistry {
	return &poolServerRegistry{m: map[string]*PoolServer{}}
}

func (r *poolServerRegistry) get(providerID string) (*PoolServer, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.m[providerID]
	return s, ok
}

func (r *poolServerRegistry) put(providerID string, s *PoolServer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.m[providerID] = s
}

func (r *poolServerRegistry) remove(providerID string) (*PoolServer, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.m[providerID]
	if ok {
		delete(r.m, providerID)
	}
	return s, ok
}

func (r *poolServerRegistry) removeAll() []*PoolServer {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*PoolServer, 0, len(r.m))
	for k, s := range r.m {
		out = append(out, s)
		delete(r.m, k)
	}
	return out
}

// StartPoolProxy persists {enabled, host, port}, points the primary member's
// own config at the pool port, stops the previous pool AND the primary's
// single-account proxy, then binds one loopback listener guarded by the
// reused-or-fresh pool token. There is no instance adoption — every start
// restarts, only the TOKEN survives.
func (s *Service) StartPoolProxy(ctx context.Context, providerID string) (*StartResult, error) {
	var result *StartResult
	err := lock.WithMutationLocks(ctx, s.Store.Root, []string{
		refs.ProviderScope(providerID), poolScope(providerID),
	}, func(c context.Context) error {
		r, runErr := s.startPoolLocked(c, providerID)
		if runErr != nil {
			return runErr
		}
		result = r
		return nil
	}, 0)
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) startPoolLocked(ctx context.Context, providerID string) (*StartResult, error) {
	return s.startPoolLockedWithToken(ctx, providerID, "")
}

// startPoolLockedWithToken starts the pool serving token, or the reused-or-
// fresh token when it is empty. A rotation needs the explicit form: stopping
// the pool clears the primary's runtime row, token included, so a rotated
// token written before the restart would be lost and a different one served.
func (s *Service) startPoolLockedWithToken(ctx context.Context, providerID, token string) (*StartResult, error) {
	pool, err := s.Pools.GetContext(ctx, providerID)
	if err != nil {
		return nil, err
	}
	if pool == nil || pool.Mode != "multi" {
		return nil, anyerr.Newf(
			fmt.Sprintf("Pool multi-mode is off for %s (default is single account). Enable with: anypick proxy pool enable %s", providerID, providerID),
			"POOL_NOT_ENABLED", anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	var members []string
	for _, m := range pool.Members {
		if m.Enabled {
			members = append(members, m.Account)
		}
	}
	if len(members) == 0 {
		return nil, anyerr.Newf(
			fmt.Sprintf("No enabled accounts in %s pool. Enable a member first.", providerID),
			"POOL_EMPTY")
	}
	primary := members[0]

	host := pool.Host
	if host == "" {
		host = "127.0.0.1"
	}
	if err := AssertLoopbackHost(host); err != nil {
		return nil, err
	}
	port := pool.Port
	if port == 0 {
		// Bind the planned/persisted port deterministically — pool.port, the
		// provider default, else 8080 — so the planner's advertised
		// endpoint always equals the served one. The previous pool and primary
		// proxy are pre-stopped below, so collision is rare, and a busy port
		// fails loudly instead of silently relocating.
		port = s.defaultPortFor(providerID)
		if port == 0 {
			port = defaultPoolPort
		}
	}
	if port < 0 || port > 65535 {
		return nil, anyerr.Newf(
			fmt.Sprintf("Invalid pool port %d. Use an integer 0–65535 (0 = provider default).", port),
			"PROXY_PORT_INVALID", anyerr.WithExitCode(anyerr.InvalidUsage))
	}

	// Persist enabled + port before touching processes.
	pool.Enabled = true
	pool.Host = host
	pool.Port = port
	if err := s.Pools.Set(ctx, *pool); err != nil {
		return nil, err
	}

	originalCfg, err := s.Store.GetProxyConfig(ctx, providerID, primary)
	if err != nil {
		return nil, err
	}
	cfg := originalCfg
	cfg.Enabled = true
	cfg.Host = host
	cfg.Port = port

	// Stop the pool listener before the account proxy. They share the primary
	// account's runtime row, and an in-process pool reports this process on
	// /health. Account stop would treat that pid as a detached child and
	// SIGTERM this process. The account stop's pid is discarded on purpose:
	// this function still holds the provider lock, and a detached child's
	// cleanup takes that lock only after its listener has closed.
	stopPoolErr := s.stopPoolLocked(ctx, providerID, primary)
	_, stopAccountErr := s.stopLocked(ctx, providerID, primary)
	stopErrs := errors.Join(stopPoolErr, stopAccountErr)

	// Token reuse reads prior state only AFTER the stop attempts: a verified
	// stop clears the primary's proxy_state, so a normal restart rotates the
	// token; reuse happens only when a stop was a no-op/failure that left the
	// record behind.
	priorState, err := s.Store.ReadProxyState(ctx, providerID, primary)
	if err != nil {
		return nil, errors.Join(err, stopErrs)
	}
	poolToken := token
	if poolToken == "" {
		poolToken, err = pickPoolToken(priorState)
		if err != nil {
			return nil, errors.Join(err, stopErrs)
		}
	}
	instanceID, err := NewInstanceID()
	if err != nil {
		return nil, errors.Join(
			anyerr.Wrapf(err, "generate instance id", "PROXY_START_FAILED"), stopErrs)
	}
	endpoint := fmt.Sprintf("http://%s:%d", normalizedLoopback(host), port)

	if err := s.Store.SetProxyConfigContext(ctx, providerID, primary, cfg); err != nil {
		return nil, errors.Join(err, stopErrs)
	}

	// Persist BEFORE spawning so the child reads its own credentials and a
	// parent crash leaves a coherent record. State lives under the PRIMARY
	// account slot.
	st := store.ProxyRuntimeState{
		AccountName: primary, Endpoint: endpoint,
		PID: 0, InstanceID: instanceID, StartedAt: nowISO(), Token: poolToken,
	}
	if werr := s.Store.WriteProxyStateContext(ctx, providerID, primary, st); werr != nil {
		return nil, errors.Join(werr, stopErrs,
			s.abortPoolStart(ctx, providerID, primary, originalCfg))
	}

	guardOptions := s.guardOptions(providerID, members)
	var pid int
	if s.PoolSpawner != nil {
		pid, err = s.PoolSpawner(providerID)
		if err != nil {
			return nil, errors.Join(
				anyerr.Wrapf(err, "spawn pool child", "PROXY_START_FAILED"),
				stopErrs,
				s.abortPoolStart(ctx, providerID, primary, originalCfg),
			)
		}
	} else {
		server := &PoolServer{
			ProviderID: providerID, InstanceID: instanceID, Token: poolToken,
			Members: members, Strategy: pool.Strategy, ResetOrder: s.resetOrder(providerID),
			Resolver: s.Resolver, Guard: upstream.NewGuard(guardOptions),
		}
		if lerr := server.Listen(host, port); lerr != nil {
			return nil, errors.Join(lerr, stopErrs,
				s.abortPoolStart(ctx, providerID, primary, originalCfg))
		}
		if herr := server.WaitReady(healthTimeout); herr != nil {
			_ = server.Close()
			return nil, errors.Join(herr, stopErrs,
				s.abortPoolStart(ctx, providerID, primary, originalCfg))
		}
		s.poolServers.put(providerID, server)
		pid = ownPID()
	}

	// Ownership proof before declaring success (PROC-01): whatever process
	// hosts the listener must echo OUR instance id.
	if herr := waitHealthInstance(endpoint, instanceID, healthTimeout); herr != nil {
		return nil, errors.Join(herr, stopErrs,
			s.abortPoolStart(ctx, providerID, primary, originalCfg))
	}

	st.PID = pid
	if werr := s.Store.WriteProxyStateContext(ctx, providerID, primary, st); werr != nil {
		return nil, errors.Join(werr, stopErrs,
			s.abortPoolStart(ctx, providerID, primary, originalCfg))
	}

	leaseID, err := NewInstanceID()
	if err != nil {
		// Lease is bookkeeping; the pool is already healthy.
		leaseID = instanceID
	}
	if lErr := s.Jobs.CreateContext(ctx, Lease{
		LeaseID: leaseID, Provider: providerID, Account: "",
		Port: portOf(endpoint), Host: host, Endpoint: endpoint,
		OwnerPID: pid, InstanceID: instanceID,
	}); lErr != nil {
		return nil, errors.Join(lErr, stopErrs,
			s.abortPoolStarted(ctx, providerID, primary, instanceID, endpoint, pid, leaseID, originalCfg))
	}
	s.startLeaseHeartbeat(leaseID, instanceID, pid)

	return &StartResult{
		Endpoint: endpoint, Token: poolToken,
		LeaseID: leaseID, InstanceID: instanceID,
		Port: portOf(endpoint), StartedNow: true,
	}, nil
}

// guardOptions builds the QuotaGuard configuration from the composition hook,
// defaulting to disabled with a 60-minute cooldown when unwired.
func (s *Service) guardOptions(providerID string, members []string) upstream.GuardOptions {
	opts := upstream.GuardOptions{
		Enabled:    false,
		CooldownMs: 60 * 60_000,
		AccountNames: func() []string {
			out := make([]string, len(members))
			copy(out, members)
			return out
		}(),
		StatePath:  paths.PoolQuotaGuardStatePath(s.Store.Root, providerID),
		ProviderID: providerID,
	}
	if s.QuotaGuardPolicy != nil {
		policy := s.QuotaGuardPolicy(context.Background())
		opts.Enabled = policy.Enabled
		opts.ServeWhenAllCooling = policy.ServeWhenAllCooling
		if policy.CooldownMinutes > 0 {
			opts.CooldownMs = int64(policy.CooldownMinutes) * 60_000
		}
	}
	return opts
}

// abortPoolStart compensates everything a failed start touched except a bound
// listener or spawned child; abortPoolStarted handles those too.
func (s *Service) abortPoolStart(ctx context.Context, providerID, primary string, originalCfg store.ProxyConfig) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*healthTimeout)
	defer cancel()
	return s.Store.SetProxyConfigContext(cleanupCtx, providerID, primary, originalCfg)
}

func (s *Service) abortPoolStarted(
	ctx context.Context,
	providerID, primary, instanceID, endpoint string,
	pid int, leaseID string,
	originalCfg store.ProxyConfig,
) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*healthTimeout)
	defer cancel()

	var errs []error
	stopped := true
	if server, ok := s.poolServers.get(providerID); ok && server.InstanceID == instanceID {
		_, _ = s.poolServers.remove(providerID)
		if err := server.Close(); err != nil {
			errs = append(errs, err)
			stopped = false
		}
	} else if s.PoolSpawner != nil && pid > 0 && processAlive(pid) {
		if err := signalPID(pid); err != nil {
			errs = append(errs, err)
			stopped = false
		} else {
			waitHealthGone(endpoint, instanceID, healthTimeout)
		}
	}
	if stopped {
		if leaseID != "" {
			s.stopLeaseHeartbeat(leaseID)
			errs = append(errs, s.Jobs.DeleteContext(cleanupCtx, leaseID))
		}
		errs = append(errs, s.Store.ClearProxyStateContext(cleanupCtx, providerID, primary))
	}
	errs = append(errs,
		s.Store.SetProxyConfigContext(cleanupCtx, providerID, primary, originalCfg))
	return errors.Join(errs...)
}

// StopPoolProxy stops the pool under the provider scope: stop the pool
// (listener first, then records) and release the (provider, "") lease.
func (s *Service) StopPoolProxy(ctx context.Context, providerID string) error {
	return lock.WithMutationLocks(ctx, s.Store.Root, []string{
		refs.ProviderScope(providerID), poolScope(providerID),
	}, func(c context.Context) error {
		pool, err := s.Pools.GetContext(c, providerID)
		if err != nil {
			return err
		}
		primary := ""
		if pool != nil {
			for _, m := range pool.Members {
				if m.Enabled {
					primary = m.Account
					break
				}
			}
		}
		if primary == "" {
			// No primary to clean: still drop any stray in-process pool.
			if server, ok := s.poolServers.remove(providerID); ok {
				_ = server.Close()
			}
			return nil
		}
		return s.stopPoolLocked(c, providerID, primary)
	}, 0)
}

// KeyHolders names every source whose clients present this account's proxy
// key: the account itself and, when the account is its pool's primary, the
// pool, whose listener serves the key stored on that row. A rotation must move
// the clients of all of them, or the pool's clients keep a refused key.
func (s *Service) KeyHolders(ctx context.Context, providerID, accountName string) []refs.Ref {
	holders := []refs.Ref{refs.AccountRef(providerID, accountName)}
	if pooled, err := s.poolOwnsRow(ctx, providerID, accountName); err == nil && pooled {
		holders = append(holders, refs.AccountPoolRef(providerID))
	}
	return holders
}

// poolOwnsRow reports whether the listener recorded on this account's runtime
// row is the provider's pool rather than the account's own proxy. A running
// pool stores its state on the primary member's row, so "is this account's
// proxy running?" answers yes for the pool too. Pool leases carry no account,
// which is what tells them apart, for an in-process pool and a detached child
// alike.
func (s *Service) poolOwnsRow(ctx context.Context, providerID, accountName string) (bool, error) {
	if s.Jobs == nil {
		return false, nil
	}
	state, err := s.Store.ReadProxyState(ctx, providerID, accountName)
	if err != nil || state == nil || state.InstanceID == "" {
		return false, err
	}
	leases, err := s.Jobs.ListPoolLeasesContext(ctx, providerID)
	if err != nil {
		return false, err
	}
	for _, lease := range leases {
		if lease != nil && lease.InstanceID == state.InstanceID {
			return true, nil
		}
	}
	return false, nil
}

// stopPoolLocked stops the pool for a known primary account. Listener closes
// first, then leases and state — deterministic shutdown, no orphaned child.
func (s *Service) stopPoolLocked(ctx context.Context, providerID, primary string) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*healthTimeout)
	defer cancel()

	if server, ok := s.poolServers.remove(providerID); ok {
		closeErr := server.Close()
		leaseErr := s.cleanupPoolLeases(cleanupCtx, providerID, server.InstanceID)
		stateErr := s.Store.ClearProxyStateContext(cleanupCtx, providerID, primary)
		return errors.Join(closeErr, leaseErr, stateErr)
	}

	state, err := s.Store.ReadProxyState(cleanupCtx, providerID, primary)
	if err != nil {
		return err
	}
	if state == nil {
		return nil
	}
	health := healthOwnership(state.Endpoint)
	if health.InstanceID != state.InstanceID {
		// Not ours / already dead: drop stale records only.
		leaseErr := s.cleanupPoolLeases(cleanupCtx, providerID, state.InstanceID)
		stateErr := s.Store.ClearProxyStateContext(cleanupCtx, providerID, primary)
		return errors.Join(leaseErr, stateErr)
	}
	pid := health.PID
	if pid <= 0 {
		pid = state.PID
	}
	if pid == ownPID() {
		// The listener is in this process. An account proxy lives in
		// s.servers and stopLocked closes it. A pool server that this map
		// already missed must fail closed: SIGTERM would kill the service,
		// and returning success would leave the listener bound.
		if _, ok := s.servers.get(providerID, primary); ok {
			return nil
		}
		return anyerr.Newf(
			"pool listener is in this process and was not closed",
			"PROXY_STOP_FAILED",
		)
	}
	if pid > 0 && processAlive(pid) {
		if err := signalPID(pid); err != nil {
			return anyerr.Wrapf(err, "signal pool child", "PROXY_STOP_FAILED")
		}
		waitHealthGone(state.Endpoint, state.InstanceID, 5*time.Second)
		if healthOwnership(state.Endpoint).InstanceID == state.InstanceID {
			// Fail closed with PROXY_STOP_UNVERIFIED: never erase the record
			// of an orphaned credential-bearing proxy we could not verify dead.
			return anyerr.Newf("pool process did not stop after SIGTERM",
				"PROXY_STOP_UNVERIFIED")
		}
	}
	leaseErr := s.cleanupPoolLeases(cleanupCtx, providerID, state.InstanceID)
	stateErr := s.Store.ClearProxyStateContext(cleanupCtx, providerID, primary)
	return errors.Join(leaseErr, stateErr)
}

// cleanupPoolLeases releases pool leases keyed (provider, "") for one instance.
func (s *Service) cleanupPoolLeases(ctx context.Context, providerID, instanceID string) error {
	leases, err := s.Jobs.ListPoolLeasesContext(ctx, providerID)
	if err != nil {
		return err
	}
	var errs []error
	for _, l := range leases {
		if l.InstanceID == instanceID {
			s.stopLeaseHeartbeat(l.LeaseID)
			errs = append(errs, s.Jobs.DeleteContext(ctx, l.LeaseID))
		}
	}
	return errors.Join(errs...)
}

// hubRing is a cached hub pool ring and what it was built from.
type hubRing struct {
	key  string
	ring *PoolServer
}

// resetOrder orders member names by the provider's quota cache, read on each
// call so a refresh steers the next request without a restart.
func (s *Service) resetOrder(providerID string) func([]string) []string {
	root := s.Store.Root
	return func(names []string) []string {
		return quotacache.OrderBySoonestReset(names, quotacache.Load(root, providerID), time.Now().UnixMilli())
	}
}

// HubPoolRing returns (without binding or auth) the ring for one provider's
// enabled multi-account pool, so a Proxy Hub pool source serves through the
// same member ordering and quota-class classification as a standalone pool.
//
// The ring is kept between requests while its members and strategy are
// unchanged. It used to be rebuilt per request, which reset the round-robin
// position to the first member every time: a hub pool source never rotated.
// Cooldowns were unaffected, because the guard keeps them in its state file.
func (s *Service) HubPoolRing(ctx context.Context, providerID string) (*PoolServer, error) {
	pool, err := s.Pools.GetContext(ctx, providerID)
	if err != nil {
		return nil, err
	}
	if pool == nil || pool.Mode != "multi" || !pool.Enabled {
		return nil, anyerr.Newf(
			fmt.Sprintf("Pool multi-mode is off for %s (default is single account). Enable with: anypick proxy pool enable %s", providerID, providerID),
			"POOL_NOT_ENABLED", anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	var members []string
	for _, m := range pool.Members {
		if m.Enabled {
			members = append(members, m.Account)
		}
	}
	if len(members) == 0 {
		return nil, anyerr.Newf(
			fmt.Sprintf("No enabled accounts in %s pool. Enable a member first.", providerID),
			"POOL_EMPTY")
	}
	// The guard policy is part of the key: the ring is reused across hub
	// requests, and a changed cooldown or all-cooling rule must reach the next
	// request as it did when the ring was built per request (ADR-0026).
	guard := s.guardOptions(providerID, members)
	key := fmt.Sprintf("%s|%s|%t|%t|%d", pool.Strategy, strings.Join(members, "\x00"),
		guard.Enabled, guard.ServeWhenAllCooling, guard.CooldownMs)
	s.hubRingsMu.Lock()
	defer s.hubRingsMu.Unlock()
	if cached, ok := s.hubRings[providerID]; ok && cached.key == key {
		return cached.ring, nil
	}
	ring := &PoolServer{
		ProviderID: providerID,
		Members:    members,
		Strategy:   pool.Strategy,
		ResetOrder: s.resetOrder(providerID),
		Resolver:   s.Resolver,
		Guard:      upstream.NewGuard(guard),
	}
	if s.hubRings == nil {
		s.hubRings = map[string]hubRing{}
	}
	s.hubRings[providerID] = hubRing{key: key, ring: ring}
	return ring, nil
}

// ServePoolExisting is the detached `_serve-pool <provider>` child entry: it
// adopts the state the parent persisted (token, port, instance id), serves
// until SIGTERM/SIGINT, then closes its listener before exiting. Identity is
// proven by echoing the recorded instance id on /health — the same veto the
// hub uses, so stop never trusts a numeric PID alone (ADR 0003 §3).
func (s *Service) ServePoolExisting(ctx context.Context, providerID string) error {
	pool, err := s.Pools.GetContext(ctx, providerID)
	if err != nil {
		return err
	}
	if pool == nil || !pool.Enabled {
		return fmt.Errorf("pool is not enabled: %s", providerID)
	}
	primary := ""
	var members []string
	for _, m := range pool.Members {
		if m.Enabled {
			members = append(members, m.Account)
			if primary == "" {
				primary = m.Account
			}
		}
	}
	if primary == "" {
		return fmt.Errorf("no enabled accounts in %s pool", providerID)
	}
	state, err := s.Store.ReadProxyState(ctx, providerID, primary)
	if err != nil {
		return err
	}
	if state == nil || state.Endpoint == "" || state.Token == "" || state.InstanceID == "" {
		return fmt.Errorf("no pool state to serve for %s", providerID)
	}

	guardOptions := s.guardOptions(providerID, members)
	server := &PoolServer{
		ProviderID: providerID, InstanceID: state.InstanceID, Token: state.Token,
		Members: members, Strategy: pool.Strategy, ResetOrder: s.resetOrder(providerID),
		Resolver: s.Resolver, Guard: upstream.NewGuard(guardOptions),
	}
	if err := server.Listen(hostOf(state.Endpoint), portOf(state.Endpoint)); err != nil {
		return err
	}

	// Same reasoning as the single-account child: the pool lease outlives the
	// parent, so the child keeps it fresh.
	s.startInstanceHeartbeat(state.InstanceID, ownPID())
	defer s.stopInstanceHeartbeat(state.InstanceID)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	select {
	case <-sigCh:
	case <-ctx.Done():
	case err := <-server.Err():
		closeErr := server.Close()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return errors.Join(err, closeErr)
		}
		return closeErr
	}
	// Listener closed before process exit — no orphaned port, no orphaned child.
	return server.Close()
}

// waitHealthGone polls until the endpoint stops echoing want or times out.
func waitHealthGone(endpoint, want string, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if healthInstance(endpoint) != want {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// hostOf extracts the loopback host from a persisted endpoint URL.
func hostOf(endpoint string) string {
	ep := strings.TrimPrefix(endpoint, "http://")
	if i := strings.LastIndex(ep, ":"); i >= 0 {
		return ep[:i]
	}
	return "127.0.0.1"
}
