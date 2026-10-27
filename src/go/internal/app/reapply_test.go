package app

import (
	"context"
	"testing"

	"github.com/outof0/anypick/go/internal/bindings"
	"github.com/outof0/anypick/go/internal/refs"
)

// Explicit selection first, then the default model role.
func TestPinnedBindingModelPrefersExplicitSelection(t *testing.T) {
	if got := pinnedBindingModel(nil); got != "" {
		t.Fatalf("nil binding = %q, want empty", got)
	}
	explicit := &bindings.Global{Spec: bindings.Spec{
		Model:         bindings.ExplicitModel("hy3"),
		ClientOptions: map[string]interface{}{"modelRoles": map[string]interface{}{"default": "other"}},
	}}
	if got := pinnedBindingModel(explicit); got != "hy3" {
		t.Fatalf("explicit = %q, want hy3", got)
	}
	roles := &bindings.Global{Spec: bindings.Spec{
		Model:         bindings.OmittedModel(),
		ClientOptions: map[string]interface{}{"modelRoles": map[string]interface{}{"default": "  deep  "}},
	}}
	if got := pinnedBindingModel(roles); got != "deep" {
		t.Fatalf("role default = %q, want trimmed deep", got)
	}
	empty := &bindings.Global{Spec: bindings.Spec{Model: bindings.OmittedModel()}}
	if got := pinnedBindingModel(empty); got != "" {
		t.Fatalf("omitted = %q, want empty", got)
	}
}

// Fail-closed without a composition: nothing to reapply, no error.
func TestReapplyClientsBoundToFailsClosedWithoutComposition(t *testing.T) {
	var a *App
	if n, err := a.ReapplyClientsBoundTo(context.Background(), refs.AccountRef("workbuddy", "work"), ReapplyOptions{}); n != 0 || err != nil {
		t.Fatalf("nil app = (%d, %v), want (0, nil)", n, err)
	}
}
