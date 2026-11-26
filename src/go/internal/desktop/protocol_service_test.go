package desktop

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/db"
)

func TestServiceHandshakeGatesInitialSnapshotAndRemovesStartupSleep(t *testing.T) {
	env := newTrayEnv(t)
	inR, inW, outR, outW := servicePipes(t)
	srv := NewService(env.Deps, inR, outW)
	done := make(chan error, 1)
	started := time.Now()
	go func() { done <- srv.Run(context.Background()) }()

	helloFrame := readFrame(t, outR, "hello")
	if elapsed := time.Since(started); elapsed >= 900*time.Millisecond {
		t.Fatalf("service hello took %s; fixed legacy startup sleep is still on the path", elapsed)
	}
	hello := decodeJSON(t, helloFrame[len("hello\t"):])
	if hello["protocolVersion"] != float64(ServiceProtocolVersion) ||
		hello["messageVersion"] != float64(ProtocolVersion) {
		t.Fatalf("unexpected hello versions: %#v", hello)
	}
	if hello["schemaVersion"] != float64(db.CurrentSchemaVersion()) {
		t.Fatalf("schemaVersion = %v", hello["schemaVersion"])
	}
	instanceID, _ := hello["instanceId"].(string)
	if len(instanceID) != 32 {
		t.Fatalf("instanceId = %q, want 128-bit diagnostic id", instanceID)
	}

	sendCommand(t, inW, FrameHostHello(validHostHello()))
	ready := decodeJSON(t, readFrame(t, outR, "ready")[len("ready\t"):])
	if ready["protocolVersion"] != float64(ServiceProtocolVersion) {
		t.Fatalf("ready = %#v", ready)
	}
	first := readFrame(t, outR, "snapshot")
	if !strings.HasPrefix(first, "snapshot\t") {
		t.Fatalf("first state frame = %q", first)
	}

	// Explicit refreshes become events; the service does not resume the old
	// 2.5-second full-snapshot polling loop.
	sendCommand(t, inW, "refresh")
	event := decodeJSON(t, readFrame(t, outR, "snapshot-event")[len("snapshot-event\t"):])
	if event["reason"] != "state-changed" || event["snapshot"] == nil {
		t.Fatalf("snapshot event = %#v", event)
	}

	sendCommand(t, inW, "quit")
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("service did not exit")
	}
}

func TestServicePollPublishesExternalLoginChange(t *testing.T) {
	env := newTrayEnv(t)
	t.Setenv("ANYPICK_CODEX_USAGE_ENDPOINT", "http://127.0.0.1:1/usage")
	ctx := context.Background()
	for _, name := range []string{"second", "first"} {
		env.writeCodexLive(name + "@example.com")
		if _, err := env.Svc.Save(ctx, "codex", name, false); err != nil {
			t.Fatal(err)
		}
	}
	var out strings.Builder
	srv := NewService(env.Deps, strings.NewReader(""), &out)
	if err := srv.refresh(ctx); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := srv.pollService(ctx); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.String(), "usage-event\t") {
		t.Fatal("unchanged login should only publish usage")
	}

	env.writeCodexLive("second@example.com")
	out.Reset()
	if err := srv.pollService(ctx); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.String(), "snapshot-event\t") {
		t.Fatal("external login change did not publish a snapshot")
	}
	var event SnapshotEvent
	if err := json.Unmarshal(decodeFramePayload(t, strings.TrimSpace(out.String())), &event); err != nil {
		t.Fatal(err)
	}
	var active []string
	for _, account := range event.Snapshot.Accounts {
		if account.ProviderID == "codex" && account.Active {
			active = append(active, account.Name)
		}
	}
	if strings.Join(active, ",") != "second" {
		t.Fatalf("current accounts after external login = %v, want second", active)
	}
	out.Reset()
	if err := srv.pollService(ctx); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.String(), "usage-event\t") {
		t.Fatal("already published login should only publish usage")
	}
}

func TestServiceRejectsMismatchedHandshakeBeforeSnapshot(t *testing.T) {
	env := newTrayEnv(t)
	inR, inW, outR, outW := servicePipes(t)
	srv := NewService(env.Deps, inR, outW)
	done := make(chan error, 1)
	go func() { done <- srv.Run(context.Background()) }()
	_ = readFrame(t, outR, "hello")

	host := validHostHello()
	host.ProtocolVersion++
	sendCommand(t, inW, FrameHostHello(host))
	rejected := decodeJSON(t,
		readFrame(t, outR, "handshake-rejected")[len("handshake-rejected\t"):])
	if rejected["code"] != "HANDSHAKE_REJECTED" {
		t.Fatalf("rejection = %#v", rejected)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("mismatched protocol unexpectedly started service")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("mismatched handshake did not terminate")
	}
}

func TestServiceMalformedCommandIsDeterministicAndNonFatal(t *testing.T) {
	env := newTrayEnv(t)
	inR, inW, outR, outW := servicePipes(t)
	srv := NewService(env.Deps, inR, outW)
	done := make(chan error, 1)
	go func() { done <- srv.Run(context.Background()) }()
	_ = readFrame(t, outR, "hello")
	sendCommand(t, inW, FrameHostHello(validHostHello()))
	_ = readFrame(t, outR, "ready")
	_ = readFrame(t, outR, "snapshot")

	sendCommand(t, inW, "mutate\tnot-canonical-base64")
	protocolErr := decodeJSON(t,
		readFrame(t, outR, "protocol-error")[len("protocol-error\t"):])
	if protocolErr["code"] != "MALFORMED_FRAME" {
		t.Fatalf("protocol error = %#v", protocolErr)
	}
	sendCommand(t, inW, "quit")
	if err := <-done; err != nil {
		t.Fatalf("malformed frame killed service: %v", err)
	}
}

func TestServiceHostEffectCompletesOnlyAfterHostResult(t *testing.T) {
	env := newTrayEnv(t)
	inR, inW, outR, outW := servicePipes(t)
	srv := NewService(env.Deps, inR, outW)
	done := make(chan error, 1)
	go func() { done <- srv.Run(context.Background()) }()
	_ = readFrame(t, outR, "hello")
	sendCommand(t, inW, FrameHostHello(validHostHello()))
	_ = readFrame(t, outR, "ready")
	_ = readFrame(t, outR, "snapshot")

	sendCommand(t, inW, "mutate\t"+encodePayload(map[string]any{
		"version": 1, "requestId": "effect-1", "operation": "setting-launch-at-login",
		"name": "launch-at-login", "enabled": true,
	}))
	effectFrame := readFrame(t, outR, "host-effect")
	effect := decodeJSON(t, strings.TrimPrefix(effectFrame, "host-effect\t"))
	if effect["requestId"] != "effect-1" {
		t.Fatalf("host effect = %#v", effect)
	}

	sendCommand(t, inW, FrameHostEffectResult(HostEffectResult{
		ProtocolVersion: ServiceProtocolVersion,
		RequestID:       "effect-1",
		Status:          "success",
		HostState:       HostStateReport{LaunchAtLogin: true},
	}))
	result := decodeJSON(t, readFrame(t, outR, "result")[len("result\t"):])
	if result["requestId"] != "effect-1" || result["status"] != "success" {
		t.Fatalf("host effect result = %#v", result)
	}
	event := decodeJSON(t,
		readFrame(t, outR, "snapshot-event")[len("snapshot-event\t"):])
	snapshot := event["snapshot"].(map[string]any)
	settings := snapshot["settings"].(map[string]any)
	if settings["launchAtLogin"] != true {
		t.Fatalf("host truth not reflected in snapshot: %#v", settings)
	}

	sendCommand(t, inW, "quit")
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestDecodeHostHelloIsStrictCanonicalAndCapabilityGated(t *testing.T) {
	valid := FrameHostHello(validHostHello())
	if _, err := decodeHostHello(valid); err != nil {
		t.Fatalf("valid hello: %v", err)
	}

	hostWithPadding := validHostHello()
	raw, _ := json.Marshal(hostWithPadding)
	for len(raw)%3 == 0 {
		hostWithPadding.AppVersion += "x"
		raw, _ = json.Marshal(hostWithPadding)
	}
	nonCanonical := "hello\t" + base64.RawStdEncoding.EncodeToString(raw)
	if _, err := decodeHostHello(nonCanonical); err == nil {
		t.Fatal("unpadded/non-canonical base64 accepted")
	}

	host := validHostHello()
	host.Capabilities = []string{"command-dto-v1"}
	if _, err := decodeHostHello(FrameHostHello(host)); err == nil {
		t.Fatal("host missing snapshot capability accepted")
	}
}

func TestCompatibleBuildVersions(t *testing.T) {
	for _, tc := range []struct {
		app, engine string
		want        bool
	}{
		{"1.2.3", "1.2.3", true},
		{"1.2.3", "1.2.4", false},
		{"(devel)", "9.0.0", true},
		{"9.0.0", "(devel)", true},
	} {
		if got := compatibleBuildVersions(tc.app, tc.engine); got != tc.want {
			t.Errorf("compatibleBuildVersions(%q, %q) = %v", tc.app, tc.engine, got)
		}
	}
}

func TestServiceBoundsOutputFrames(t *testing.T) {
	var out bytes.Buffer
	srv := NewService(Deps{}, strings.NewReader(""), &out)
	srv.write(strings.Repeat("x", MaxServiceFrameBytes+1))
	line := strings.TrimSpace(out.String())
	if !strings.HasPrefix(line, "protocol-error\t") {
		t.Fatalf("oversized output was not replaced by protocol error: %.80q", line)
	}
	payload := decodeJSON(t, strings.TrimPrefix(line, "protocol-error\t"))
	if payload["code"] != "FRAME_TOO_LARGE" {
		t.Fatalf("protocol error = %#v", payload)
	}
}

func validHostHello() HostHello {
	return HostHello{
		ProtocolVersion: ServiceProtocolVersion,
		AppVersion:      "(devel)",
		Platform:        "test",
		Capabilities:    append([]string(nil), serviceCapabilities...),
		HostState:       HostStateReport{},
	}
}

func servicePipes(t *testing.T) (inR, inW, outR, outW *os.File) {
	t.Helper()
	var err error
	if inR, inW, err = os.Pipe(); err != nil {
		t.Fatal(err)
	}
	if outR, outW, err = os.Pipe(); err != nil {
		t.Fatal(err)
	}
	for _, file := range []*os.File{inR, inW, outR, outW} {
		f := file
		t.Cleanup(func() { _ = f.Close() })
	}
	return inR, inW, outR, outW
}
