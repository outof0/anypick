package desktop

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateCodexProfileOpenPayload(t *testing.T) {
	for _, tc := range []struct {
		payload string
		ok      bool
	}{
		{`{"version":1,"requestId":"r","operation":"codex-profile-open","name":"work"}`, true},
		{`{"version":1,"requestId":"r","operation":"codex-profile-open","name":"work","path":"/tmp"}`, false},
		{`{"version":1,"requestId":"r","operation":"codex-profile-open","name":""}`, false},
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
