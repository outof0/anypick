package desktop

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/outof0/anypick/go/internal/client"
)

func TestClaudeAppProfilePayloadValidation(t *testing.T) {
	for _, tc := range []struct {
		payload string
		ok      bool
	}{
		{`{"version":1,"requestId":"r","operation":"claude-app-profile-open","name":"work"}`, true},
		{`{"version":1,"requestId":"r","operation":"claude-app-profile-open","name":""}`, false},
		{`{"version":1,"requestId":"r","operation":"claude-app-profile-open","name":"work","path":"/tmp"}`, false},
		{`{"version":1,"requestId":"r","operation":"claude-app-profile-remove","name":"work"}`, true},
		{`{"version":1,"requestId":"r","operation":"claude-app-profile-remove","name":"work","path":"/tmp"}`, false},
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

// Nothing tells the service that a Claude window was quit or opened elsewhere,
// so the refusal itself has to correct the host's stale row.
func TestRefusedClaudeAppProfileOpenSendsASnapshot(t *testing.T) {
	t.Cleanup(client.SetCodexAppPlatformForTest("darwin"))
	t.Cleanup(client.SetClaudeAppProcessListForTest(func() (string, error) { return "", nil }))
	t.Cleanup(client.SetCodexAppOpenForTest(func([]string) error { return nil }))
	env := newTrayEnv(t)
	wireActivation(t, env)
	out := &strings.Builder{}
	srv := New(env.Deps, strings.NewReader(""), out)
	for i, want := range []string{"success", "error"} {
		out.Reset()
		raw, err := json.Marshal(Mutate{Version: ProtocolVersion, RequestID: fmt.Sprintf("r%d", i),
			Operation: "claude-app-profile-open", Name: "work"})
		if err != nil {
			t.Fatal(err)
		}
		if err := srv.handleMutate(context.Background(), raw); err != nil {
			t.Fatal(err)
		}
		var res Result
		if err := json.Unmarshal(decodeFramePayload(t, firstFrameLine(out.String())), &res); err != nil {
			t.Fatal(err)
		}
		if res.Status != want {
			t.Fatalf("open %d: result = %+v, want %s", i, res, want)
		}
		if frames := strings.Count(strings.TrimSpace(out.String()), "\n") + 1; frames != 2 {
			t.Fatalf("open %d wrote %d frames, want a result and a snapshot", i, frames)
		}
	}
}

func TestMutateClaudeAppProfileOpenThenListAndRemoveMissing(t *testing.T) {
	t.Cleanup(client.SetCodexAppPlatformForTest("darwin"))
	t.Cleanup(client.SetClaudeAppProcessListForTest(func() (string, error) { return "", nil }))
	opened := 0
	t.Cleanup(client.SetCodexAppOpenForTest(func([]string) error {
		opened++
		return nil
	}))
	env := newTrayEnv(t)
	wireActivation(t, env)
	srv := New(env.Deps, strings.NewReader(""), &strings.Builder{})
	blank := Result{Version: ProtocolVersion, RequestID: "r", Status: "success"}

	result := srv.routeClaudeAppProfileMutation(context.Background(),
		Mutate{RequestID: "r", Operation: "claude-app-profile-open", Name: "work"}, blank)
	if result.Status != "success" || opened != 1 {
		t.Fatalf("result = %+v, opened = %d", result, opened)
	}
	b := &snapshotBuilder{srv: srv, snap: &Snapshot{}}
	b.claudeAppProfiles()
	if !b.snap.ClaudeAppSupported || len(b.snap.ClaudeAppProfiles) != 1 ||
		b.snap.ClaudeAppProfiles[0].Name != "work" {
		t.Fatalf("snapshot = %+v", b.snap.ClaudeAppProfiles)
	}

	result = srv.routeClaudeAppProfileMutation(context.Background(),
		Mutate{RequestID: "r", Operation: "claude-app-profile-remove", Name: "missing"}, blank)
	if result.Status != "error" || result.Code != "CLAUDE_APP_PROFILE_NOT_FOUND" {
		t.Fatalf("result = %+v", result)
	}
}
