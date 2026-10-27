package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/accounts"
	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/refs"
	"github.com/outof0/anypick/go/internal/runtime"
	"github.com/outof0/anypick/go/internal/transport"
)

// ReapplyOptions are the caller's standing for one reapply.
type ReapplyOptions struct {
	// AllowForeign is consent to take over client settings AnyPick does not
	// own. Without it a client the user moved off AnyPick's managed route is
	// left alone: a saved binding is history, not consent to recreate
	// settings someone deleted.
	AllowForeign bool
}

// ReapplyClientsBoundTo re-runs activation for every persistent client whose
// global binding names ref, and reports how many it rewrote. A switch, a token
// rotation and a proxy restart all change what a bound client must present,
// and without this the client keeps the previous account or a dead key.
//
// Only exact matches move; cross-provider routes stay pinned by design. The
// pinned model is kept while the source catalog still publishes it. A failure
// restores the client configs this call already rewrote.
//
// The TUI and the CLI share this; the desktop keeps its own copy because it
// also records per-client degraded conditions for the app.
func (a *App) ReapplyClientsBoundTo(ctx context.Context, ref refs.Ref, opts ReapplyOptions) (int, error) {
	if a == nil || a.Clients == nil || a.BindingSvc == nil || a.Deps == nil {
		return 0, nil
	}
	want := refs.SerializeRef(ref)
	type target struct {
		clientID string
		binding  *bindings.Global
	}
	var targets []target
	var errs []error
	for _, clientID := range a.Clients.IDs() {
		b, err := a.BindingSvc.GetGlobalContext(ctx, clientID)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", clientID, err))
			continue
		}
		if b == nil || refs.SerializeRef(b.Spec.Source) != want {
			continue
		}
		if !opts.AllowForeign && a.managedSource(ctx, clientID, ref) && !a.canAutomaticallyReapply(clientID) {
			continue
		}
		targets = append(targets, target{clientID: clientID, binding: b})
	}
	if len(targets) == 0 {
		// No client is bound to this source, so nothing needs the catalog and
		// the caller must not perform live vendor egress.
		return 0, errors.Join(errs...)
	}
	var catalog []string
	if ref.Kind == refs.KindAccount && a.Proxy != nil {
		if models, derr := a.Proxy.DiscoverModels(ctx, ref.Provider, ref.Name); derr == nil {
			catalog = models
		}
	}
	reapplied := 0
	canUndo := a.Deps.Runtime != nil
	var recovery [][]string
	for _, t := range targets {
		b := t.binding
		model := pinnedBindingModel(b)
		specCopy := b.Spec
		if model != "" && len(catalog) > 0 && !containsModelID(catalog, model) {
			// The entitlement changed under this binding; let the planner
			// bootstrap from the current catalog instead of pinning stale.
			specCopy.Model = bindings.OmittedModel()
		}
		var records []string
		if canUndo {
			var rerr error
			records, rerr = a.Deps.Runtime.PrepareClientConfigRecovery(
				t.clientID, fmt.Sprintf("reapply-%s-%d", t.clientID, time.Now().UnixNano()))
			if rerr != nil {
				return reapplied, finishReapply(recovery, fmt.Errorf("%s: %w", t.clientID, rerr))
			}
		}
		// Re-apply the stored spec rather than planning a fresh source-only
		// request: model roles and the transport policy travel with the
		// binding, and a fresh spec would silently reset them.
		plan, err := activation.PlanActivation(ctx, activation.Request{
			Mode:         activation.ModePersistent,
			Client:       t.clientID,
			ModelCatalog: catalog,
		}, a.Deps, activation.Options{
			ReapplySpec: &specCopy,
			ReapplyProv: &bindings.Provenance{
				Kind:                   "global_binding_snapshot",
				GlobalBindingUpdatedAt: b.UpdatedAt,
			},
			SkipNativeAuthWrite: true,
		})
		if err != nil {
			cause := errors.Join(append(errs, fmt.Errorf("%s: %w", t.clientID, err))...)
			if !canUndo && len(recovery) > 0 {
				return reapplied, accounts.IncompleteClientRestore(cause)
			}
			return reapplied, finishReapply(recovery, cause)
		}
		if _, err := activation.Execute(ctx, plan, a.Deps, activation.ExecuteOptions{
			AllowForeignConfig: opts.AllowForeign,
		}); err != nil {
			cause := errors.Join(append(errs, fmt.Errorf("%s: %w", t.clientID, err))...)
			if !canUndo && len(recovery) > 0 {
				return reapplied, accounts.IncompleteClientRestore(cause)
			}
			return reapplied, finishReapply(append(recovery, records), cause)
		}
		recovery = append(recovery, records)
		reapplied++
	}
	return reapplied, errors.Join(errs...)
}

// managedSource reports whether clientID reaches ref through an AnyPick-owned
// route. Only such a route can be taken back without the user's consent.
func (a *App) managedSource(ctx context.Context, clientID string, ref refs.Ref) bool {
	if ref.Kind != refs.KindAccount {
		return true
	}
	if a.Providers == nil {
		return false
	}
	pv, err := a.Providers.Get(ref.Provider)
	if err != nil || pv == nil {
		return false
	}
	enabled := false
	if a.Accounts != nil {
		if account, err := a.Accounts.CachedAccount(ctx, ref.Provider, ref.Name); err == nil && account != nil {
			enabled = account.Proxy.Enabled
		}
	}
	capability := pv.AccountAdapter(ref.Name, enabled).TransportFor(clientID)
	return capability == transport.ManagedBuiltinProxy || capability == transport.ManagedExternalProxy
}

// canAutomaticallyReapply is true only when the client's config is readable,
// AnyPick-managed, and still on the route AnyPick wrote. Anything uncertain
// (a locked Keychain, an unreadable file) leaves the config alone.
func (a *App) canAutomaticallyReapply(clientID string) bool {
	if a.Clients == nil {
		return false
	}
	cad, err := a.Clients.Get(clientID)
	if err != nil {
		return false
	}
	inspected, err := cad.Inspect()
	return err == nil && inspected != nil && !inspected.Native && !inspected.RoutingChanged
}

// finishReapply restores client configs captured before this reapply. A
// restore failure is marked incomplete so the caller does not claim the
// clients were returned to their previous state.
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

// pinnedBindingModel returns the model id a binding already runs, if any:
// the explicit selection first, then the default model role.
func pinnedBindingModel(b *bindings.Global) string {
	if b == nil {
		return ""
	}
	if b.Spec.Model.Mode == "explicit" && strings.TrimSpace(b.Spec.Model.ID) != "" {
		return strings.TrimSpace(b.Spec.Model.ID)
	}
	if roles, ok := b.Spec.ClientOptions["modelRoles"].(map[string]interface{}); ok {
		if def, ok := roles["default"].(string); ok {
			return strings.TrimSpace(def)
		}
	}
	return ""
}

func containsModelID(models []string, want string) bool {
	for _, model := range models {
		if model == want {
			return true
		}
	}
	return false
}
