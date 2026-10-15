// Mutation handlers: account/gateway/proxy mutations, sign-in bookkeeping and their helpers.
package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime/debug"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/accounts"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/config"
	"github.com/outof0/anypick/go/internal/hub"
	"github.com/outof0/anypick/go/internal/i18n"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/profile"
	"github.com/outof0/anypick/go/internal/provider"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/slug"
	"github.com/outof0/anypick/go/internal/store"
)

func (s *Server) handleMutate(ctx context.Context, payload json.RawMessage) error {
	var m Mutate
	if err := json.Unmarshal(payload, &m); err != nil {
		return err
	}
	if m.Operation == "account-login" {
		return s.handleAccountLogin(ctx, m)
	}
	if s.reserveRequest(m.RequestID) {
		// A retried command must not be applied twice. The first answer already
		// reached the host; a duplicate is reported rather than repeated.
		s.write(FrameResult(errorResult(m.RequestID, anyerr.Newf(
			"That action was already applied.", "STATE_CONFLICT"))))
		return nil
	}
	result, answered := s.routeMutation(ctx, payload, m)
	if !answered {
		return nil
	}
	s.write(FrameResult(result))
	if result.Status == "success" {
		// The terminal frame is already out. A failed refresh must not become a
		// second answer for the same requestId (the app turns it into an error
		// toast over a success), so it is logged here and retried by the ticker
		// like every other snapshot failure.
		if err := s.refresh(ctx); err != nil {
			s.logErr(fmt.Errorf("refresh after %s: %w", m.Operation, err))
		}
	}
	return nil
}

// deriveGatewayEndpoint resolves the endpoint for account-derived providers
// (GatewayInfo.RequiresAccountID) from the raw profile account id. Anything
// else returns the typed endpoint untouched; provider lookup failures fail
// closed so a typo'd provider id never silently becomes a custom endpoint.
func deriveGatewayEndpoint(providers *provider.Registry, providerID, profile string) (string, error) {
	if providers == nil {
		return "", serviceUnavailableErr("providers")
	}
	pv, err := providers.Get(providerID)
	if err != nil || pv == nil {
		return "", anyerr.Newf("Unknown gateway provider \""+providerID+".",
			"INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	deriver, ok := pv.(provider.GatewayEndpointDeriver)
	if !ok {
		return "", anyerr.Newf("gateway provider cannot derive an endpoint",
			"INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage))
	}
	return deriver.DeriveGatewayEndpoint(profile)
}

// resolveGatewayCreateCredential derives the stored endpoint and headers
// for one gateway-create mutation. grok's base is fixed and engine-supplied;
// account-derived providers (Cloudflare) build the base URL from the account
// id the UI collected instead of a typed URL; multi-gateway providers persist
// the normalized gateway id under the generic "gatewayId" header key, which
// the provider maps onto its wire header at resolve time. No provider id
// branches here: everything provider-specific comes from capabilities.
func (s *Server) resolveGatewayCreateCredential(m Mutate) (string, map[string]string, error) {
	endpoint := m.Endpoint
	if m.ProviderID == "grok" && endpoint == "" {
		endpoint = "https://cli-chat-proxy.grok.com"
	}
	var headers map[string]string
	var info *provider.GatewayInfo
	if s.Deps.Providers != nil {
		if pv, perr := s.Deps.Providers.Get(m.ProviderID); perr == nil && pv != nil {
			if gi, ok := pv.(provider.GatewayInfoProvider); ok {
				got := gi.GatewayInfo()
				info = &got
			}
		}
	}
	if info != nil && info.RequiresAccountID {
		derived, derr := deriveGatewayEndpoint(s.Deps.Providers, m.ProviderID, m.Profile)
		if derr != nil {
			return "", nil, derr
		}
		endpoint = derived
	}
	if info != nil && info.RequiresGatewayID {
		var normalizer provider.GatewayIDNormalizer
		if pv, perr := s.Deps.Providers.Get(m.ProviderID); perr == nil && pv != nil {
			normalizer, _ = pv.(provider.GatewayIDNormalizer)
		}
		if normalizer == nil {
			return "", nil, anyerr.Newf(
				"gateway provider cannot validate gateway ids",
				"INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage))
		}
		gatewayID, nerr := normalizer.NormalizeGatewayID(m.GatewayID)
		if nerr != nil {
			return "", nil, nerr
		}
		headers = map[string]string{"gatewayId": gatewayID}
	}
	return endpoint, headers, nil
}

func (s *Server) mutateGatewayCreate(ctx context.Context, m Mutate, result Result) Result {
	if m.Name == "" || m.ProviderID == "" {
		result = result.Fail(payloadErr("gateway-create", "name and providerId"))
		return result
	}
	// grok gateways authenticate with the live x.ai OIDC session shared
	// with the account flow, so no API key is collected. Every other
	// gateway (including gemini) carries its key in the profile.
	needsKey := m.ProviderID != "grok"
	if s.Deps.Profiles == nil {
		result = result.Fail(serviceUnavailableErr("profiles"))
		return result
	}
	endpoint, headers, cerr := s.resolveGatewayCreateCredential(m)
	if cerr != nil {
		result = result.Fail(cerr)
		return result
	}
	if (needsKey && m.APIKey == "") || endpoint == "" {
		result = result.Fail(payloadErr("gateway-create",
			"endpoint"+map[bool]string{true: " and apiKey", false: ""}[needsKey]))
		return result
	}
	err := lock.WithMutationLock(ctx, s.Deps.Root, refs.MutationScopeForRef(refs.GatewayRef(m.Name)), func(c context.Context) error {
		_, err := s.Deps.Profiles.UpsertContext(c, profile.Runtime{
			Meta: profile.Meta{
				Name:         m.Name,
				Provider:     orString(m.ProviderID, "custom"),
				Label:        strings.TrimSpace(m.Label),
				Endpoint:     endpoint,
				DefaultModel: m.DefaultModel,
			},
			Secrets: profile.Secrets{APIKey: m.APIKey, Headers: headers},
		})
		return err
	})
	if err != nil {
		result = result.Fail(err)
	} else {
		// An explicit gateway creation is also an explicit model-discovery
		// action. Warm before the next snapshot so its client pickers and native
		// adapters see the endpoint's models, not the provider-wide fallback.
		s.warmGatewayModelCatalogBestEffort(ctx, m.Name)
		label := strings.TrimSpace(m.Label)
		if label == "" {
			label = m.Name
		}
		result.Message = fmt.Sprintf("Added gateway %s.", label)
	}
	return result
}

func (s *Server) mutateAccountRemove(ctx context.Context, m Mutate, result Result) Result {
	if m.ProviderID == "" || m.Name == "" {
		result = result.Fail(payloadErr("account-remove", "providerId and name"))
		return result
	}
	deleted, err := s.Deps.Accounts.Delete(ctx, m.ProviderID, m.Name)
	if err != nil {
		result = result.Fail(err)
	} else {
		result.Message = fmt.Sprintf("Removed account %s.", m.Name)
		if len(deleted.Profiles) > 0 {
			result.Message += fmt.Sprintf(" Removed named profile(s): %s.", strings.Join(deleted.Profiles, ", "))
		}
		// An account row is the only thing Delete removes; hub sources and
		// route pins that named it would otherwise rot into ghosts the
		// snapshot hides and serving trips over. Prune them while the
		// provider/name pair is still in hand.
		if s.Deps.Hub != nil {
			if pruned, perr := s.Deps.Hub.PruneAccount(ctx, m.ProviderID, m.Name); perr != nil {
				s.logErr(fmt.Errorf("hub prune for %s/%s: %w", m.ProviderID, m.Name, perr))
			} else if len(pruned) > 0 {
				result.Message += fmt.Sprintf(" Hub references dropped: %s.", strings.Join(pruned, ", "))
			}
			s.refreshUnsyncedHubs(ctx, m.ProviderID, m.Name)
		}
	}
	return result
}

// refreshUnsyncedHubs restarts children still serving a deleted account.
// In-sync hubs are adopted by SpawnHubChild only when they are in the
// reload list, and port 0 is left running: there is no echo address.
func (s *Server) refreshUnsyncedHubs(ctx context.Context, providerID, name string) {
	if s.Deps.Hub == nil || s.Deps.Activation == nil || s.Deps.Activation.SpawnHubChild == nil {
		return
	}
	configs, err := s.Deps.Hub.ListConfigsContext(ctx)
	if err != nil {
		s.logErr(fmt.Errorf("hub refresh for %s/%s: %w", providerID, name, err))
		return
	}
	if err := hub.ReloadUnsynced(configs, s.Deps.Activation.SpawnHubChild); err != nil {
		s.logErr(fmt.Errorf("hub refresh for %s/%s: %w", providerID, name, err))
	}
}

func (s *Server) mutateAccountRefresh(ctx context.Context, m Mutate, result Result) Result {
	if m.ProviderID == "" || m.Name == "" {
		result = result.Fail(payloadErr("account-refresh", "providerId and name"))
		return result
	}
	if _, err := s.Deps.Accounts.RefreshSnapshot(ctx, m.ProviderID, m.Name); err != nil {
		result = result.Fail(err)
		if result.Code == "ACCOUNT_NOT_FOUND" {
			result.Message = fmt.Sprintf("account not found: %s is no longer available. Refresh your accounts list or re-add it.", m.Name)
		}
	} else {
		s.warmAccountModelCatalogBestEffort(ctx, m.ProviderID, m.Name)
		result.Message = fmt.Sprintf("Refreshed models for %s.", m.Name)
	}
	return result
}

func (s *Server) mutateGatewayRemove(ctx context.Context, m Mutate, result Result) Result {
	if s.Deps.Profiles == nil || m.Name == "" {
		result = result.Fail(payloadErr("gateway-remove", "name"))
		return result
	}
	err := lock.WithMutationLock(ctx, s.Deps.Root, refs.MutationScopeForRef(refs.GatewayRef(m.Name)), func(c context.Context) error {
		return s.Deps.Profiles.DeleteContext(c, m.Name)
	})
	if err != nil {
		result = result.Fail(err)
	} else {
		result.Message = fmt.Sprintf("Removed gateway %s.", m.Name)
	}
	return result
}

func (s *Server) mutateGatewayEdit(ctx context.Context, m Mutate, result Result) Result {
	if s.Deps.Profiles == nil || m.Name == "" {
		result = result.Fail(payloadErr("gateway-edit", "name"))
		return result
	}
	err := lock.WithMutationLock(ctx, s.Deps.Root, refs.MutationScopeForRef(refs.GatewayRef(m.Name)), func(c context.Context) error {
		existing, err := s.Deps.Profiles.GetContext(c, m.Name)
		if err != nil {
			return err
		}
		if existing == nil {
			return anyerr.Newf(fmt.Sprintf("gateway not found: %s does not exist", m.Name), "GATEWAY_NOT_FOUND")
		}
		if m.Label != "" {
			existing.Meta.Label = m.Label
		}
		if m.Endpoint != "" {
			existing.Meta.Endpoint = m.Endpoint
		}
		if m.APIKey != "" {
			existing.Secrets.APIKey = m.APIKey
		}
		if m.DefaultModel != "" {
			existing.Meta.DefaultModel = m.DefaultModel
		}
		_, err = s.Deps.Profiles.UpsertContext(c, *existing)
		return err
	})
	if err != nil {
		result = result.Fail(err)
	} else {
		s.warmGatewayModelCatalogBestEffort(ctx, m.Name)
		label := strings.TrimSpace(m.Label)
		if label == "" {
			label = m.Name
		}
		result.Message = fmt.Sprintf("Updated gateway %s.", label)
	}
	return result
}

func (s *Server) mutateClientReset(ctx context.Context, m Mutate, result Result) Result {
	clientID := strings.TrimSpace(m.Name)
	if clientID == "" {
		clientID = strings.TrimSpace(m.ProviderID)
	}
	cad, cerr := s.Deps.Clients.Get(clientID)
	if cerr != nil {
		result = result.Fail(cerr)
		return result
	}
	rerr := lock.WithMutationLock(ctx, s.Deps.Root, "client/"+cad.ID(), func(c context.Context) error {
		if err := cad.Reset(); err != nil {
			return err
		}
		if s.Deps.Bindings != nil {
			if err := s.Deps.Bindings.DeleteGlobalContext(c, cad.ID()); err != nil {
				return err
			}
		}
		return nil
	})
	if rerr != nil {
		result = result.Fail(rerr)
	} else {
		result.Message = fmt.Sprintf("Disconnected %s and restored native login.", designAppName(cad.ID()))
	}
	return result
}

func (s *Server) mutateProxyStopAll(ctx context.Context, m Mutate, result Result) Result {
	restart := m.Operation == "proxy-restart-all"
	verb, infinitive := "stopped", "stop"
	if restart {
		verb, infinitive = "restarted", "restart"
	}
	// Aggregate per-proxy failures (PX4): the old loop swallowed every
	// error and always reported success. Per-row progress would need
	// protocol work; naming the failures in the result is what fits.
	var failed []string
	attempted := 0
	// Discovery is read-only and must still identify the concrete proxies
	// when the command context was cancelled. The stop/restart operation
	// itself keeps ctx, so cancellation is reported per proxy instead of
	// being mistaken for "nothing to do".
	enumerateCtx := context.WithoutCancel(ctx)
	for _, providerID := range s.Deps.Providers.IDs() {
		list, lerr := s.Deps.Accounts.List(enumerateCtx, providerID)
		if lerr != nil {
			continue
		}
		for _, acc := range list {
			cfg, _ := s.Deps.Proxy.ProxyConfig(enumerateCtx, providerID, acc.Meta.Name)
			if !cfg.Enabled {
				continue
			}
			attempted++
			label := providerID + "/" + acc.Meta.Name
			if serr := s.Deps.Proxy.Stop(ctx, providerID, acc.Meta.Name); serr != nil {
				failed = append(failed, label+": "+serr.Error())
				continue
			}
			if restart {
				if _, rerr := s.Deps.Proxy.StartProxy(ctx, providerID, acc.Meta.Name); rerr != nil {
					failed = append(failed, label+": "+rerr.Error())
				}
			}
		}
	}
	if len(failed) > 0 {
		result = result.Fail(anyerr.Newf(fmt.Sprintf("could not %s %d of %d proxies: %s",
			infinitive, len(failed), attempted, strings.Join(failed, "; ")),
			"PROXY_BULK_FAILED",
			anyerr.WithMutated(true),
			anyerr.WithSuggestions("Open Live Logs for the first proxy that failed.")))
	} else if attempted == 0 {
		result.Message = "no enabled proxies to " + infinitive
	} else {
		result.Message = fmt.Sprintf("%s %d of %d proxies", verb, attempted, attempted)
	}
	return result
}

func (s *Server) mutateProxyStartAll(ctx context.Context, result Result) Result {
	// Account relays only. Proxy Hub is not an account; its row publishes a
	// toggle action, and starting it here would ignore that action's catalog
	// check. A proxy that is already running is left alone: this is not a toggle.
	var failed []string
	attempted := 0
	enumerateCtx := context.WithoutCancel(ctx)
	for _, providerID := range s.Deps.Providers.IDs() {
		list, lerr := s.Deps.Accounts.List(enumerateCtx, providerID)
		if lerr != nil {
			continue
		}
		for _, acc := range list {
			name := acc.Meta.Name
			if st, serr := s.Deps.Proxy.StatusContext(enumerateCtx, providerID, name); serr == nil && st != nil && st.Running {
				continue
			}
			attempted++
			label := providerID + "/" + name
			if _, err := s.Deps.Proxy.StartProxy(ctx, providerID, name); err != nil {
				failed = append(failed, label+": "+err.Error())
				continue
			}
			if err := s.reapplyClientsBoundTo(ctx, refs.AccountRef(providerID, name), false); err != nil {
				failed = append(failed, label+": "+err.Error())
			}
		}
	}
	if len(failed) > 0 {
		result = result.Fail(anyerr.Newf(fmt.Sprintf("could not start %d of %d proxies: %s",
			len(failed), attempted, strings.Join(failed, "; ")),
			"PROXY_BULK_FAILED",
			anyerr.WithMutated(true),
			anyerr.WithSuggestions("Open Live Logs for the first proxy that failed.")))
	} else if attempted == 0 {
		result.Message = "no stopped proxies to start"
	} else {
		result.Message = fmt.Sprintf("started %d of %d proxies", attempted, attempted)
	}
	return result
}

func (s *Server) mutateLaunchAtLogin(ctx context.Context, m Mutate, result Result) (Result, bool) {
	// ADR 0020 §7: the engine validates and emits a typed host effect;
	// the native app executes SMAppService and reflects the new state in
	// its next host report. No OS mutation happens here — on any platform.
	effect := config.NewLaunchAtLoginEffect(m.Enabled)
	if s.serviceMode {
		if err := s.requestHostEffect(m, effect); err != nil {
			result = result.Fail(err)
			return result, false
		}
		return result, true
	}
	payload, perr := json.Marshal(effect)
	if perr != nil {
		result = result.Fail(perr)
		return result, false
	}
	result.Payload = payload
	if m.Enabled {
		result.Message = "AnyPick will open at login."
	} else {
		result.Message = "Launch at login disabled."
	}
	return result, false
}

func (s *Server) mutateAutoStartProxies(ctx context.Context, m Mutate, result Result) Result {
	if s.Deps.Config == nil {
		result = result.Fail(serviceUnavailableErr("config service"))
		return result
	}
	_, uerr := s.Deps.Config.SetTrayPreference(ctx, "startEnabledProxies", m.Enabled)
	if uerr != nil {
		result = result.Fail(uerr)
		return result
	}
	if m.Enabled {
		s.startEnabledProxies(ctx)
	}
	if m.Enabled {
		result.Message = "Enabled proxies will start with AnyPick."
	} else {
		result.Message = "Proxy auto-start disabled."
	}
	return result
}

func (s *Server) mutateShowQuota(ctx context.Context, m Mutate, result Result) Result {
	if s.Deps.Config == nil {
		result = result.Fail(serviceUnavailableErr("config service"))
		return result
	}
	if _, qerr := s.Deps.Config.SetTrayPreference(ctx, "showQuota", m.Enabled); qerr != nil {
		result = result.Fail(qerr)
	} else if m.Enabled {
		result.Message = "Quota is visible."
	} else {
		result.Message = "Quota is hidden."
	}
	return result
}

func (s *Server) mutateQuotaGuard(ctx context.Context, m Mutate, result Result) Result {
	if s.Deps.Config == nil {
		result = result.Fail(serviceUnavailableErr("config service"))
		return result
	}
	if _, gerr := s.Deps.Config.SetQuotaGuardEnabled(ctx, m.Enabled); gerr != nil {
		result = result.Fail(gerr)
		return result
	}
	if rerr := s.restartRunningPools(ctx); rerr != nil {
		// The preference is stored; only the running pools did not pick it up.
		result = result.Fail(anyerr.Wrapf(rerr,
			"Saved the quota-guard setting, but running pools did not restart",
			"POOL_RESTART_FAILED", anyerr.WithMutated(true)))
		return result
	}
	if m.Enabled {
		result.Message = "Quota Guard enabled for multi-account compatibility proxy pools."
	} else {
		result.Message = "Quota Guard disabled. Native app logins were not changed."
	}
	return result
}

func (s *Server) mutateLanguage(ctx context.Context, m Mutate, result Result) Result {
	if s.Deps.Config == nil {
		return result.Fail(serviceUnavailableErr("config service"))
	}
	cfg, err := s.Deps.Config.SetLanguage(ctx, m.Language)
	if err != nil {
		return result.Fail(err)
	}
	i18n.SetLanguage(config.LanguageOf(cfg))
	result.Message = i18n.T("desktop.settings.language_saved")
	return result
}

// loginRejection is why a sign-in did not start.
type loginRejection int

const (
	loginAccepted loginRejection = iota
	loginRejectedDuplicate
	loginRejectedCancelled
)

// registerLogin claims one sign-in. The entry must stay registered while the
// attempt runs: deleting it up front makes a later `cancel` frame a no-op and
// strands the run with no terminal result.
func (s *Server) registerLogin(requestID string, cancel context.CancelFunc) loginRejection {
	s.cancelMu.Lock()
	_, exists := s.cancellables[requestID]
	if exists {
		s.cancelMu.Unlock()
		cancel()
		return loginRejectedDuplicate
	}
	if s.takeEarlyCancel(requestID) {
		s.cancelMu.Unlock()
		cancel()
		return loginRejectedCancelled
	}
	s.cancellables[requestID] = cancel
	s.cancelMu.Unlock()
	return loginAccepted
}

// armLoginDeadline answers a sign-in that outlives the engine's backstop even if
// the adapter ignores the context. Nothing else will: the host holds its mutation
// slot on this request.
func (s *Server) armLoginDeadline(
	requestID, providerID string, runCtx context.Context, cancel context.CancelFunc, budget time.Duration,
) {
	s.inFlight.Add(1)
	go func() {
		defer s.inFlight.Done()
		timer := time.NewTimer(budget)
		defer timer.Stop()
		select {
		case <-runCtx.Done():
			return
		case <-s.stopCh:
			return
		case <-timer.C:
		}
		cancel()
		s.write(FrameResult(errorResult(requestID, loginTimeoutErr(providerID))))
	}()
}

// takeEarlyCancel consumes a cancel that arrived before this request registered.
// Callers hold cancelMu.
func (s *Server) takeEarlyCancel(requestID string) bool {
	if _, cancelled := s.cancelLedger[requestID]; !cancelled {
		return false
	}
	delete(s.cancelLedger, requestID)
	return true
}

// loginOutcome maps one sign-in attempt to its terminal result. A failed
// sign-in is compensated before this point, so the code and suggestions are
// what tell the user which login method or source to fix.
func loginOutcome(requestID string, login accounts.LoginResult, err error) Result {
	result := Result{Version: ProtocolVersion, RequestID: requestID, Status: "success"}
	switch {
	case err == nil:
		result.Message = fmt.Sprintf("Signed in with %s and saved %s/%s.",
			login.Method.Label, login.Account.Provider, login.Account.Name)
	case errors.Is(err, context.Canceled):
		result = result.Cancel("Sign-in cancelled.")
	default:
		var ae *anyerr.Error
		if errors.As(err, &ae) && ae.Code == "PROVIDER_LOGIN_CANCELLED" {
			result = result.Cancel("Sign-in cancelled.")
		} else {
			result = result.Fail(err)
		}
	}
	return result
}

// routeMutation runs one mutation and returns its terminal result. It holds the
// dispatch table only; publishing and the follow-up refresh stay in handleMutate
// so a failure path can never write two answers for one request.
func (s *Server) routeMutation(ctx context.Context, payload json.RawMessage, m Mutate) (Result, bool) {
	result := Result{Version: ProtocolVersion, RequestID: m.RequestID, Status: "success"}
	switch m.Operation {
	case "account-detect":
		result = s.handleAccountDetect(m)
	case "account-save-current":
		result = s.handleAccountSaveCurrent(ctx, m)
	case "gateway-create":
		result = s.mutateGatewayCreate(ctx, m, result)
	case "account-remove":
		result = s.mutateAccountRemove(ctx, m, result)
	case "account-save":
		result = s.handleAccountSave(ctx, payload, m)
	case "account-save-input":
		result = s.handleAccountSaveInput(ctx, m)
	case "account-save-auth":
		result = s.handleAccountSaveAuth(ctx, m)
	case "account-edit":
		result = s.handleAccountEdit(ctx, payload, m)
	case "account-refresh":
		result = s.mutateAccountRefresh(ctx, m, result)
	case "gateway-remove":
		result = s.mutateGatewayRemove(ctx, m, result)
	case "gateway-edit":
		result = s.mutateGatewayEdit(ctx, m, result)
	case "account-clear":
		result = s.handleAccountClear(ctx, m)
	case "client-reset":
		result = s.mutateClientReset(ctx, m, result)
	case "codex-profile-save":
		result = s.mutateCodexProfileSave(ctx, m, result)
	case "codex-profile-update":
		result = s.mutateCodexProfileUpdate(ctx, m, result)
	case "codex-profile-sync":
		result = s.mutateCodexProfileSync(ctx, m, result)
	case "codex-profile-remove":
		result = s.mutateCodexProfileRemove(ctx, m, result)
	case "account-import", "account-export", "account-backup-all",
		"account-backup-export", "account-backup-import", "account-backup-forget":
		result = s.handleTransferOp(ctx, m)
	case "gateway-test":
		result = s.handleGatewayTest(ctx, m)
	case "gateway-refresh":
		result = s.handleGatewayRefresh(ctx, m)
	case "hub-source-toggle":
		result = s.handleHubSourceToggle(ctx, m)
	case "hub-rotation":
		result = s.handleHubRotation(ctx, m)
	case "proxy-stop-all", "proxy-restart-all":
		result = s.mutateProxyStopAll(ctx, m, result)
	case "proxy-start-all":
		result = s.mutateProxyStartAll(ctx, result)
	case "proxy-token":
		result = s.mutateProxyToken(ctx, m, result)
	case "setting-launch-at-login":
		var terminal bool
		if result, terminal = s.mutateLaunchAtLogin(ctx, m, result); terminal {
			// The host effect owns the answer; nothing may be written here.
			return result, false
		}
	case "setting-auto-start-proxies":
		result = s.mutateAutoStartProxies(ctx, m, result)
	case "setting-show-quota":
		result = s.mutateShowQuota(ctx, m, result)
	case "setting-quota-guard":
		result = s.mutateQuotaGuard(ctx, m, result)
	case "setting-language":
		result = s.mutateLanguage(ctx, m, result)
	default:
		// Unknown operations must surface as structured errors, never crash
		// or silently succeed.
		result = result.Fail(anyerr.Newf(
			fmt.Sprintf("unknown mutation operation %q", m.Operation),
			"INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage)))
	}
	return result, true
}

// errorResult is the one place a desktop mutation turns a Go error into a
// terminal frame. It delegates to Fail so the code, the CLI's suggestions and
// the partial-mutation warning survive the boundary instead of collapsing into
// err.Error().
func errorResult(requestID string, err error) Result {
	return Result{Version: ProtocolVersion, RequestID: requestID, Status: "success"}.Fail(err)
}

// detectLiveSource resolves the live source: a source-aware provider owns
// the scoped probe; every other provider has one live store and uses
// DetectLive. The identity is returned raw: clear/save match it against
// stored accounts, and sanitizing here would make an opaque-but-legitimate
// identity miss its account. Callers sanitize only what they display.
func detectLiveSource(pv provider.Provider, sourceID string) (provider.LiveAuthStatus, error) {
	var (
		live provider.LiveAuthStatus
		err  error
	)
	if sourceID != "" {
		if scoped, ok := pv.(provider.SourceScopedProvider); ok {
			live, err = scoped.DetectLiveSource(sourceID)
		} else {
			live, err = pv.DetectLive()
		}
	} else {
		live, err = pv.DetectLive()
	}
	if err != nil {
		return provider.LiveAuthStatus{}, err
	}
	return live, nil
}

func (s *Server) handleAccountDetect(m Mutate) Result {
	result := Result{Version: ProtocolVersion, RequestID: m.RequestID, Status: "success"}
	pv, err := s.Deps.Providers.Get(m.ProviderID)
	if err != nil {
		return errorResult(m.RequestID, err)
	}
	live, err := detectLiveSource(pv, strings.TrimSpace(m.SourceID))
	if err != nil {
		return errorResult(m.RequestID, err)
	}
	if !live.Present {
		return errorResult(m.RequestID,
			anyerr.Newf("No live "+pv.Name()+" login was found.", "NO_LIVE_AUTH",
				anyerr.WithSuggestions("Sign in to your "+pv.Name()+" account in the official application or browser, then try detecting again.")))
	}
	location := pv.Name()
	if sourceID := strings.TrimSpace(m.SourceID); sourceID != "" {
		location = sourceID
	}
	if identity := displaySafeIdentity(live.Identity); identity != "" {
		result.Message = fmt.Sprintf("Detected %s in %s.", identity, location)
	} else {
		result.Message = fmt.Sprintf("Detected the current login in %s.", location)
	}
	return result
}

func (s *Server) handleAccountSave(ctx context.Context, raw json.RawMessage, m Mutate) Result {
	if m.ProviderID == "" || m.Name == "" {
		return errorResult(m.RequestID, payloadErr("account-save", "providerId and name"))
	}
	var saved store.Meta
	err := lock.WithMutationLock(ctx, s.Deps.Root, refs.ProviderScope(m.ProviderID),
		func(c context.Context) error {
			var saveErr error
			if apiKey := strings.TrimSpace(m.APIKey); apiKey != "" {
				profileID := strings.TrimSpace(m.Region)
				if profileID == "" {
					profileID = "global"
				}
				saved, saveErr = s.Deps.Accounts.SaveInput(c, m.ProviderID, m.Name,
					accounts.CredentialInput{Kind: "api-key", Secret: apiKey, Profile: profileID},
					m.Overwrite)
			} else {
				if source := strings.TrimSpace(m.SourceID); source != "" {
					saved, saveErr = s.Deps.Accounts.SaveWithSource(
						c, m.ProviderID, m.Name, source, m.Overwrite)
				} else {
					saved, saveErr = s.Deps.Accounts.Save(c, m.ProviderID, m.Name, m.Overwrite)
				}
			}
			if saveErr != nil {
				return saveErr
			}
			// account-save treats a blank label as absent, while a non-blank
			// label is committed under the same provider scope as the snapshot.
			if jsonFieldPresent(raw, "label") {
				label := strings.TrimSpace(m.Label)
				if label != "" && label != saved.Label {
					saved, saveErr = s.Deps.Accounts.PatchMeta(c, m.ProviderID, saved.Name,
						store.MetaPatch{LabelSet: true, Label: label})
				}
			}
			return saveErr
		})
	if err != nil {
		return errorResult(m.RequestID, err)
	}
	label := saved.Label
	if label == "" {
		label = saved.Name
	}
	s.warmAccountModelCatalogBestEffort(ctx, m.ProviderID, saved.Name)
	return Result{Version: ProtocolVersion, RequestID: m.RequestID, Status: "success",
		Message: "Saved " + label + "."}
}

// handleAccountSaveInput saves a typed credential (API key / plan key) for a
// provider-declared credential product — the native Add Account sheet's key path. Unlike
// account-save there is no live login to snapshot; unlike gateway-create the
// credential lands in the account store, so apps can be bound to it. An empty
// profile selects the kind's first endpoint profile.
func (s *Server) handleAccountSaveInput(ctx context.Context, m Mutate) Result {
	if m.ProviderID == "" || m.Name == "" || m.Kind == "" || strings.TrimSpace(m.APIKey) == "" {
		return errorResult(m.RequestID,
			payloadErr("account-save-input", "providerId, name, kind and apiKey"))
	}
	if s.Deps.Accounts == nil {
		return errorResult(m.RequestID, serviceUnavailableErr("accounts service"))
	}
	profileID := strings.TrimSpace(m.Profile)
	if profileID == "" {
		first, err := s.defaultCredentialProfile(m.ProviderID, m.Kind)
		if err != nil {
			return errorResult(m.RequestID, err)
		}
		profileID = first
	}
	meta, err := s.Deps.Accounts.SaveInput(ctx, m.ProviderID, m.Name,
		accounts.CredentialInput{Kind: m.Kind, Secret: m.APIKey, Profile: profileID}, false)
	if err != nil {
		return errorResult(m.RequestID, err)
	}
	label := meta.Label
	if label == "" {
		label = meta.Name
	}
	s.warmAccountModelCatalogBestEffort(ctx, m.ProviderID, meta.Name)
	return Result{Version: ProtocolVersion, RequestID: m.RequestID, Status: "success",
		Message: "Saved " + meta.Provider + "/" + label + "."}
}

// handleAccountSaveAuth reads a provider auth document from a regular file
// the host staged. The document is not a protocol field: a Codex auth.json
// with several JWTs does not fit in MaxCommandBytes. The file is the host's,
// including a CLI path the user still needs, so this handler never deletes it.
func (s *Server) handleAccountSaveAuth(ctx context.Context, m Mutate) Result {
	if m.ProviderID == "" || m.Path == "" {
		return errorResult(m.RequestID, payloadErr("account-save-auth", "providerId and path"))
	}
	if s.Deps.Accounts == nil {
		return errorResult(m.RequestID, serviceUnavailableErr("accounts service"))
	}
	info, err := os.Lstat(m.Path)
	if err != nil {
		return errorResult(m.RequestID, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errorResult(m.RequestID, anyerr.Newf(
			"Auth JSON must be a regular file.",
			"INVALID_USAGE", anyerr.WithExitCode(anyerr.InvalidUsage)))
	}
	f, err := os.Open(m.Path)
	if err != nil {
		return errorResult(m.RequestID, err)
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, int64(provider.MaxAuthPasteBytes)+1))
	if err != nil {
		return errorResult(m.RequestID, err)
	}
	metas, err := s.Deps.Accounts.SavePastedAuth(ctx, m.ProviderID, m.Name, raw, m.Overwrite)
	if err != nil {
		return errorResult(m.RequestID, err)
	}
	names := make([]string, len(metas))
	for i, meta := range metas {
		names[i] = meta.Provider + "/" + meta.Name
		s.warmAccountModelCatalogBestEffort(ctx, meta.Provider, meta.Name)
	}
	message := "Saved " + strings.Join(names, ", ") + "."
	if len(metas) > 1 {
		message = fmt.Sprintf("Saved %d accounts: %s.", len(metas), strings.Join(names, ", "))
	}
	return Result{Version: ProtocolVersion, RequestID: m.RequestID, Status: "success", Message: message}
}

// defaultCredentialProfile resolves an omitted endpoint profile to the kind's
// first declared profile, so single-profile vendors stay one field simpler
// for every client. Unknown providers and kinds fail here with the same
// coded error BackupInput would raise.
func (s *Server) defaultCredentialProfile(providerID, kind string) (string, error) {
	pv, err := s.Deps.Providers.Get(providerID)
	if err != nil {
		return "", err
	}
	definer, ok := pv.(provider.CredentialDefinitionsProvider)
	if !ok {
		return "", anyerr.Newf(
			"Provider "+providerID+" does not accept credential inputs. Sign in natively and use save.",
			"UNSUPPORTED_CREDENTIAL_INPUT")
	}
	for _, c := range definer.CredentialDefinitions() {
		if c.Kind == kind {
			if len(c.Profiles) == 0 {
				break
			}
			return c.Profiles[0].ID, nil
		}
	}
	return "", anyerr.Newf(
		"Provider "+providerID+" does not accept credential kind \""+kind+"\".",
		"UNSUPPORTED_CREDENTIAL_INPUT")
}

func (s *Server) handleAccountSaveCurrent(ctx context.Context, m Mutate) Result {
	if m.ProviderID == "" {
		return errorResult(m.RequestID, payloadErr("account-save-current", "providerId"))
	}
	pv, err := s.Deps.Providers.Get(m.ProviderID)
	if err != nil {
		return errorResult(m.RequestID, err)
	}
	var saved store.Meta
	err = lock.WithMutationLock(ctx, s.Deps.Root, refs.ProviderScope(m.ProviderID),
		func(c context.Context) error {
			live, detectErr := detectLiveSource(pv, strings.TrimSpace(m.SourceID))
			if detectErr != nil {
				return detectErr
			}
			if !live.Present {
				return anyerr.Newf("No live "+pv.Name()+" login to save.", "NO_LIVE_AUTH")
			}
			name, nameErr := s.currentSaveName(c, m.ProviderID, strings.TrimSpace(m.Name), live)
			if nameErr != nil {
				return nameErr
			}
			var saveErr error
			saved, saveErr = s.Deps.Accounts.SaveWithSource(c, m.ProviderID, name,
				strings.TrimSpace(m.SourceID), true)
			return saveErr
		})
	if err != nil {
		return errorResult(m.RequestID, err)
	}
	label := saved.Label
	if label == "" {
		label = saved.Name
	}
	s.warmAccountModelCatalogBestEffort(ctx, m.ProviderID, saved.Name)
	return Result{Version: ProtocolVersion, RequestID: m.RequestID, Status: "success",
		Message: "Saved " + label + "."}
}

// currentSaveName resolves the save name: an existing identity wins, then
// an explicit name, a matching active account, and finally an
// identity-derived stable slug. The active pointer alone is never identity.
func (s *Server) currentSaveName(ctx context.Context, providerID, requested string,
	live provider.LiveAuthStatus) (string, error) {
	list, err := s.Deps.Accounts.List(ctx, providerID)
	if err != nil {
		return "", err
	}
	if live.Identity != "" {
		for _, acc := range list {
			if sameIdentity(acc.Meta.Identity, live.Identity) {
				return acc.Meta.Name, nil
			}
		}
	}
	if requested != "" {
		return slug.AccountName(requested)
	}
	active, err := s.Deps.Accounts.Active(ctx, providerID)
	if err != nil {
		return "", err
	}
	if active != "" {
		for _, acc := range list {
			if acc.Meta.Name == active &&
				(live.Identity == "" || sameIdentity(acc.Meta.Identity, live.Identity)) {
				return active, nil
			}
		}
	}
	if live.Identity != "" {
		return accountNameFromIdentity(live.Identity)
	}
	return "", anyerr.Newf("Name the login before saving it.", "MISSING_ACCOUNT_NAME")
}

func (s *Server) handleAccountEdit(ctx context.Context, raw json.RawMessage, m Mutate) Result {
	if m.ProviderID == "" || m.Name == "" {
		return errorResult(m.RequestID, payloadErr("account-edit", "providerId and name"))
	}
	var edited store.Meta
	err := lock.WithMutationLock(ctx, s.Deps.Root, refs.ProviderScope(m.ProviderID),
		func(c context.Context) error {
			account, err := s.Deps.Accounts.Get(c, m.ProviderID, m.Name)
			if err != nil {
				return err
			}
			if account == nil {
				return anyerr.Newf(
					fmt.Sprintf("No account %q for provider %q.", m.Name, m.ProviderID),
					"ACCOUNT_NOT_FOUND")
			}
			edited = account.Meta
			if !jsonFieldPresent(raw, "label") {
				return nil
			}
			edited, err = s.Deps.Accounts.PatchMeta(c, m.ProviderID, m.Name,
				store.MetaPatch{LabelSet: true, Label: strings.TrimSpace(m.Label)})
			return err
		})
	if err != nil {
		return errorResult(m.RequestID, err)
	}
	label := edited.Label
	if label == "" {
		label = edited.Name
	}
	return Result{Version: ProtocolVersion, RequestID: m.RequestID, Status: "success",
		Message: "Updated " + label + "."}
}

func (s *Server) handleAccountClear(ctx context.Context, m Mutate) Result {
	if m.ProviderID == "" {
		return errorResult(m.RequestID, payloadErr("account-clear", "providerId"))
	}
	pv, err := s.Deps.Providers.Get(m.ProviderID)
	if err != nil {
		return errorResult(m.RequestID, err)
	}
	sourceID := strings.TrimSpace(m.SourceID)
	clear, cerr := resolveClearer(pv, sourceID, m.ProviderID)
	if cerr != nil {
		return errorResult(m.RequestID, cerr)
	}
	var live provider.LiveAuthStatus
	var backedUpTo string
	var matchedByIdentity bool
	err = lock.WithMutationLock(ctx, s.Deps.Root, refs.ProviderScope(m.ProviderID),
		func(c context.Context) error {
			var detectErr error
			live, detectErr = detectLiveSource(pv, sourceID)
			if detectErr != nil || !live.Present {
				return detectErr
			}
			if policy, ok := pv.(provider.LiveClearPolicy); ok && !policy.CanClearLive(live.Source) {
				return anyerr.Newf(
					pv.Name()+" login is owned by the external application and cannot be signed out safely.",
					"STASH_UNSUPPORTED",
					anyerr.WithSuggestions(fmt.Sprintf("Open %s settings to sign out directly.", pv.Name())))
			}
			name, matched, nameErr := s.stashSaveName(c, m.ProviderID, live)
			if nameErr != nil {
				return nameErr
			}
			if _, saveErr := s.Deps.Accounts.Save(c, m.ProviderID, name, true); saveErr != nil {
				return anyerr.Wrapf(saveErr,
					"Could not back up the live "+pv.Name()+" login before clearing it",
					"STASH_BACKUP_FAILED")
			}
			backedUpTo, matchedByIdentity = name, matched
			if cerr := clear(); cerr != nil {
				// The back-up snapshot is on disk: the user must be told the
				// state changed even though the action failed.
				return anyerr.Wrapf(cerr,
					"Saved the live login but could not clear it", "CLEAR_FAILED",
					anyerr.WithMutated(true))
			}
			return nil
		})
	if err != nil {
		return errorResult(m.RequestID, err)
	}
	location := m.ProviderID
	if sourceID != "" {
		location = sourceID
	}
	message := fmt.Sprintf("No live %s login to clear.", location)
	if live.Present {
		if matchedByIdentity {
			message = fmt.Sprintf("Saved live %s login into %s/%s and cleared local auth.",
				location, m.ProviderID, backedUpTo)
		} else {
			message = fmt.Sprintf("Backed up live %s login as %s/%s and cleared local auth.",
				location, m.ProviderID, backedUpTo)
		}
	}
	return Result{Version: ProtocolVersion, RequestID: m.RequestID, Status: "success",
		Message: message}
}

func resolveClearer(pv provider.Provider, sourceID, providerID string) (func() error, error) {
	if sourceID != "" {
		if scoped, ok := pv.(interface{ ClearLiveSource(string) error }); ok {
			return func() error { return scoped.ClearLiveSource(sourceID) }, nil
		}
	}
	if clearer, ok := pv.(provider.LiveClearer); ok {
		return clearer.ClearLive, nil
	}
	return nil, anyerr.Newf(
		fmt.Sprintf("Provider %q does not support clearing live auth.", providerID),
		"STASH_UNSUPPORTED",
		anyerr.WithSuggestions(fmt.Sprintf("Sign out directly within the %s application or browser.", pv.Name())))
}

func (s *Server) stashSaveName(ctx context.Context, providerID string,
	live provider.LiveAuthStatus) (string, bool, error) {
	list, err := s.Deps.Accounts.List(ctx, providerID)
	if err != nil {
		return "", false, err
	}
	if live.Identity != "" {
		for _, acc := range list {
			if sameIdentity(acc.Meta.Identity, live.Identity) {
				return acc.Meta.Name, true, nil
			}
		}
	}
	active, err := s.Deps.Accounts.Active(ctx, providerID)
	if err != nil {
		return "", false, err
	}
	if active != "" {
		for _, acc := range list {
			if acc.Meta.Name == active &&
				(live.Identity == "" || acc.Meta.Identity == "" ||
					sameIdentity(acc.Meta.Identity, live.Identity)) {
				return active, false, nil
			}
		}
	}
	if live.Identity != "" {
		name, nameErr := accountNameFromIdentity(live.Identity)
		return name, false, nameErr
	}
	return "stash", false, nil
}

func accountNameFromIdentity(identity string) (string, error) {
	local := strings.TrimSpace(identity)
	if at := strings.Index(local, "@"); at >= 0 {
		local = local[:at]
	}
	name, err := slug.AccountName(local)
	if err != nil {
		return "stash", nil
	}
	return name, nil
}

func sameIdentity(a, b string) bool {
	return a != "" && b != "" && strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
}

func (s *Server) handleGatewayRefresh(ctx context.Context, m Mutate) Result {
	if s.Deps.Profiles == nil || m.Name == "" {
		return errorResult(m.RequestID, payloadErr("gateway-refresh", "an available profile and name"))
	}
	models, err := s.refreshGatewayModelCatalog(ctx, m.Name)
	if err != nil {
		return errorResult(m.RequestID, err)
	}
	return Result{Version: ProtocolVersion, RequestID: m.RequestID, Status: "success",
		Message: fmt.Sprintf("Refreshed %s: %d models.", m.Name, len(models.Models))}
}

func jsonFieldPresent(raw json.RawMessage, field string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return false
	}
	_, ok := fields[field]
	return ok
}

// recoverLoginPanic is deferred by the sign-in goroutine. A panic anywhere in
// the OAuth child, the provider adapter or the credential write must still
// publish one terminal frame: the sheet disables itself until a result for its
// requestId arrives, so a silent panic stranded it — and, unhandled, the whole
// service with it.
func (s *Server) recoverLoginPanic(requestID string) {
	if panicked := recover(); panicked != nil {
		s.logErr(fmt.Errorf("login %s panicked: %v\n%s", requestID, panicked, debug.Stack()))
		s.write(FrameResult(errorResult(requestID, panicErr(panicked))))
	}
}

// handleAccountLogin runs the browser sign-in off the main loop with a
// cancellable context registered under its requestId. Cancellation must reach
// the OAuth child while the login is still awaiting it, and a cancelled run
// must publish exactly one terminal result — "cancelled", never a late success.
func (s *Server) handleAccountLogin(_ context.Context, m Mutate) error {
	fail := func(err error) {
		s.write(FrameResult(errorResult(m.RequestID, err)))
	}
	if m.ProviderID == "" || m.MethodID == "" {
		fail(payloadErr("account-login", "providerId and methodId"))
		return nil
	}
	if s.Deps.Accounts == nil {
		fail(serviceUnavailableErr("accounts service"))
		return nil
	}
	runCtx, cancel := context.WithCancel(context.Background())
	loginDeadline := s.loginDeadline()
	switch s.registerLogin(m.RequestID, cancel) {
	case loginRejectedDuplicate:
		fail(anyerr.Newf("requestId is already in flight", "STATE_CONFLICT",
			anyerr.WithSuggestions("Wait for the sign-in already running, or cancel it first.")))
		return nil
	case loginRejectedCancelled:
		// Nothing was started and nothing changed, so the terminal frame is the
		// whole answer; no snapshot is needed.
		s.write(FrameResult(Result{Version: ProtocolVersion, RequestID: m.RequestID,
			Status: "success"}.Cancel("Sign-in cancelled.")))
		return nil
	}
	s.armLoginDeadline(m.RequestID, m.ProviderID, runCtx, cancel, loginDeadline)
	s.inFlight.Add(1)
	go func() {
		defer s.inFlight.Done()
		defer s.recoverLoginPanic(m.RequestID)
		// The entry MUST stay registered while Login runs — deleting it up
		// front makes the later `cancel` frame a no-op and strands this run
		// with no terminal result. Unregister only once the login finished.
		defer func() {
			s.cancelMu.Lock()
			delete(s.cancellables, m.RequestID)
			s.cancelMu.Unlock()
			cancel()
		}()

		attemptCtx, cancelAttempt := context.WithTimeout(runCtx, loginDeadline)
		defer cancelAttempt()
		attempt := s.loginAttempt
		if attempt == nil {
			attempt = s.Deps.Accounts.Login
		}
		login, err := attempt(attemptCtx, m.ProviderID, accounts.LoginOptions{
			MethodID: strings.TrimSpace(m.MethodID),
			Source:   strings.TrimSpace(m.SourceID),
			Name:     strings.TrimSpace(m.Name),
			Label:    strings.TrimSpace(m.Label),
		})
		result := loginOutcome(m.RequestID, login, err)
		// The sheet has been waiting on this frame; publish it before the
		// best-effort warm (up to 8s) and the snapshot refresh.
		s.write(FrameResult(result))
		if err == nil {
			// Login has just committed the snapshot, so warm the account-scoped
			// catalog before the next snapshot. A denied or transient model probe
			// must not turn a successful sign-in into a failure.
			s.warmAccountModelCatalogBestEffort(context.Background(),
				login.Account.Provider, login.Account.Name)
		}
		// Refresh for every terminal outcome. A failed login is compensated
		// before this point, and the native sheet needs the restored live source
		// immediately so its fallback action is truthful.
		if rerr := s.refresh(context.Background()); rerr != nil && rerr != errShutdown {
			s.logErr(rerr)
		}
	}()
	return nil
}

func orString(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
