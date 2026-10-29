package desktop

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/client"
)

func TestValidateCodexProfileOpenPayload(t *testing.T) {
	for _, tc := range []struct {
		payload string
		ok      bool
	}{
		{`{"version":1,"requestId":"r","operation":"codex-profile-open","name":"work"}`, true},
		{`{"version":1,"requestId":"r","operation":"codex-profile-open","name":"work","path":"/tmp"}`, false},
		{`{"version":1,"requestId":"r","operation":"codex-profile-open","name":""}`, false},
		{`{"version":1,"requestId":"r","operation":"codex-profile-terminal","name":"work"}`, true},
		{`{"version":1,"requestId":"r","operation":"codex-profile-terminal","name":"work","command":"rm -rf ~"}`, false},
	} {
		fields := map[string]json.RawMessage{}
		if err := json.Unmarshal([]byte(tc.payload), &fields); err != nil {
			t.Fatal(err)
		}
		if err := validateMutate(fields); (err == nil) != tc.ok {
			t.Errorf("%s: err = %v, want ok=%v", tc.payload, err, tc.ok)
		}
	}
}

// Opening a profile that is not saved fails with the profile's own error and
// launches nothing.
func TestMutateCodexProfileOpenUnknownProfile(t *testing.T) {
	// On Linux and Windows the platform check answers first; the profile
	// lookup is what this pins.
	t.Cleanup(client.SetCodexAppPlatformForTest("darwin"))
	env := newTrayEnv(t)
	wireActivation(t, env)
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	result := srv.mutateCodexProfileOpen(context.Background(),
		Mutate{RequestID: "r", Operation: "codex-profile-open", Name: "missing"},
		Result{Version: ProtocolVersion, RequestID: "r", Status: "success"})
	if result.Status != "error" || result.Code != "CODEX_PROFILE_NOT_FOUND" {
		t.Fatalf("result = %+v", result)
	}
}

// The terminal runs the engine's own launch command for a saved profile, so
// an unknown name fails before any script is written.
func TestMutateCodexProfileTerminalUnknownProfile(t *testing.T) {
	env := newTrayEnv(t)
	wireActivation(t, env)
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	result := srv.mutateCodexProfileTerminal(context.Background(),
		Mutate{RequestID: "r", Operation: "codex-profile-terminal", Name: "missing"},
		Result{Version: ProtocolVersion, RequestID: "r", Status: "success"})
	if result.Status != "error" || result.Code != "CODEX_PROFILE_NOT_FOUND" {
		t.Fatalf("result = %+v", result)
	}
}
