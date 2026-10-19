package app

import (
	"context"
	"errors"
	"fmt"

	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/refs"
)

// refreshCodexProfilesForAccount reapplies named Codex profiles whose source
// snapshot changed. The profile's auth.json is a private copy, so without this
// cascade it can keep using a credential that the saved account has replaced.
func (a *App) refreshCodexProfilesForAccount(ctx context.Context, providerID, accountName string) error {
	if a.Deps == nil || a.Deps.ClientProfiles == nil {
		return nil
	}
	profiles, err := a.Deps.ClientProfiles.ListContext(ctx, "codex")
	if err != nil {
		return fmt.Errorf("read Codex profiles: %w", err)
	}
	want := refs.SerializeRef(refs.AccountRef(providerID, accountName))
	var errs []error
	for _, named := range profiles {
		if refs.SerializeRef(named.Spec.Source) != want {
			continue
		}
		spec := named.Spec
		plan, err := activation.PlanActivation(ctx, activation.Request{
			Mode:        activation.ModeProfile,
			Client:      "codex",
			ProfileName: named.Name,
		}, a.Deps, activation.Options{
			ReapplySpec: &spec,
			ReapplyProv: &bindings.Provenance{Kind: "client_profile_snapshot"},
		})
		if err == nil {
			_, err = activation.Execute(ctx, plan, a.Deps, activation.ExecuteOptions{})
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("refresh Codex profile %s: %w", named.Name, err))
		}
	}
	return errors.Join(errs...)
}
