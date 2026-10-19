package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/desktop"
)

func TestDesktopServiceCrossProcessHandshake(t *testing.T) {
	isolateEnv(t)
	bin := requireBuiltCLI(t)
	p := spawnDesktopService(t, bin)

	hello := awaitServiceFrame(t, p, "hello")
	if !strings.HasPrefix(hello, "hello\t") {
		t.Fatalf("protocol stdout was polluted before hello: %q", hello)
	}
	host := desktop.HostHello{
		ProtocolVersion: desktop.ServiceProtocolVersion,
		AppVersion:      "(devel)",
		Platform:        "test",
		Capabilities: []string{
			"cancel-v1", "command-dto-v1", "explicit-refresh",
			"host-effects-v1", "post-mutation-events", "snapshot-dto-v1",
			"usage-events-v1",
		},
	}
	if _, err := p.stdin.Write([]byte(desktop.FrameHostHello(host) + "\n")); err != nil {
		t.Fatal(err)
	}
	_ = awaitServiceFrame(t, p, "ready")
	_ = awaitServiceFrame(t, p, "snapshot")
	if _, err := p.stdin.Write([]byte("quit\n")); err != nil {
		t.Fatal(err)
	}
	_ = p.stdin.Close()

	done := make(chan error, 1)
	go func() { done <- p.cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("desktop-service exited with error: %v\nstderr: %s", err, p.stderr.String())
		}
	case <-time.After(serviceDeadline):
		t.Fatalf("desktop-service did not stop after quit\nstderr: %s", p.stderr.String())
	}
}

func TestDesktopServiceRequiresExplicitStdio(t *testing.T) {
	isolateEnv(t)
	var code int
	_, stderr := captureBoth(t, func() { code = run([]string{"desktop-service"}) })
	if code == 0 {
		t.Fatal("desktop-service without --stdio unexpectedly started")
	}
	if !strings.Contains(stderr, "desktop-service --stdio") {
		t.Fatalf("missing usage guidance: %q", stderr)
	}
}

func TestDesktopServiceCrossProcessCommandKinds(t *testing.T) {
	isolateEnv(t)
	bin := requireBuiltCLI(t)
	p := spawnDesktopService(t, bin)

	_ = awaitServiceFrame(t, p, "hello")
	host := desktop.HostHello{
		ProtocolVersion: desktop.ServiceProtocolVersion,
		AppVersion:      "(devel)",
		Platform:        "test",
		Capabilities: []string{
			"cancel-v1", "command-dto-v1", "explicit-refresh",
			"host-effects-v1", "post-mutation-events", "snapshot-dto-v1",
			"usage-events-v1",
		},
	}
	writeServiceLine(t, p.stdin, desktop.FrameHostHello(host))
	_ = awaitServiceFrame(t, p, "ready")
	_ = awaitServiceFrame(t, p, "snapshot")

	// Host-only commands must neither mutate nor pollute protocol stdout. A
	// following refresh proves the same child remains responsive.
	writeServiceLine(t, p.stdin, "open")
	writeServiceLine(t, p.stdin, "navigate\taccounts")
	writeServiceLine(t, p.stdin, "restart")
	writeServiceLine(t, p.stdin, "refresh")
	_ = awaitServiceFrame(t, p, "snapshot-event")

	writeServicePayload(t, p.stdin, "doctor", map[string]any{
		"version": 1, "requestId": "doctor-1",
	})
	diagnosis := decodeServicePayload(t, awaitServiceFrame(t, p, "doctor"))
	if diagnosis["requestId"] != "doctor-1" || diagnosis["findings"] == nil {
		t.Fatalf("doctor response = %#v", diagnosis)
	}

	writeServicePayload(t, p.stdin, "logs", map[string]any{
		"version": 1, "requestId": "logs-1", "providerId": "codex",
		"name": "not-saved", "lines": 20,
	})
	logs := decodeServicePayload(t, awaitServiceFrame(t, p, "logs"))
	if logs["requestId"] != "logs-1" || logs["state"] != "not-running" {
		t.Fatalf("logs response = %#v", logs)
	}

	writeServicePayload(t, p.stdin, "backup-inspect", map[string]any{
		"version": 1, "requestId": "inspect-1", "path": t.TempDir() + "/missing.anypick",
	})
	preview := decodeServicePayload(t,
		awaitServiceFrame(t, p, "backup-preview"))
	if preview["requestId"] != "inspect-1" || preview["status"] != "error" {
		t.Fatalf("backup preview = %#v", preview)
	}

	writeServicePayload(t, p.stdin, "invoke", map[string]any{
		"version": 1, "requestId": "invoke-1", "revision": 0,
		"actionId": "missing-action",
	})
	invoked := decodeServicePayload(t, awaitServiceFrame(t, p, "result"))
	if invoked["requestId"] != "invoke-1" || invoked["status"] != "error" {
		t.Fatalf("invoke result = %#v", invoked)
	}

	writeServicePayload(t, p.stdin, "model-roles", map[string]any{
		"version": 1, "requestId": "roles-1", "revision": 0,
		"clientId": "missing-client", "roleActionIds": map[string]string{},
	})
	roles := decodeServicePayload(t, awaitServiceFrame(t, p, "result"))
	if roles["requestId"] != "roles-1" || roles["status"] != "error" {
		t.Fatalf("model roles result = %#v", roles)
	}

	writeServicePayload(t, p.stdin, "mutate", map[string]any{
		"version": 1, "requestId": "setting-1", "operation": "setting-show-quota",
		"name": "show-quota", "enabled": false,
	})
	setting := decodeServicePayload(t, awaitServiceFrame(t, p, "result"))
	if setting["requestId"] != "setting-1" || setting["status"] != "success" {
		t.Fatalf("setting result = %#v", setting)
	}
	_ = awaitServiceFrame(t, p, "snapshot-event")

	const fixtureSecret = "must-not-cross-desktop-boundary"
	writeServicePayload(t, p.stdin, "mutate", map[string]any{
		"version": 1, "requestId": "gateway-create-1", "operation": "gateway-create",
		"providerId": "custom", "name": "fixture", "label": "Fixture",
		"endpoint": "https://example.invalid/v1", "apiKey": fixtureSecret,
	})
	created := decodeServicePayload(t, awaitServiceFrame(t, p, "result"))
	if created["requestId"] != "gateway-create-1" || created["status"] != "success" {
		t.Fatalf("gateway create result = %#v", created)
	}
	createdEvent := awaitServiceFrame(t, p, "snapshot-event")
	createdPayload, err := json.Marshal(decodeServicePayload(t, createdEvent))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(createdPayload), fixtureSecret) {
		t.Fatal("gateway secret crossed the desktop protocol boundary")
	}

	writeServicePayload(t, p.stdin, "mutate", map[string]any{
		"version": 1, "requestId": "gateway-remove-1", "operation": "gateway-remove",
		"name": "fixture",
	})
	removed := decodeServicePayload(t, awaitServiceFrame(t, p, "result"))
	if removed["requestId"] != "gateway-remove-1" || removed["status"] != "success" {
		t.Fatalf("gateway remove result = %#v", removed)
	}
	_ = awaitServiceFrame(t, p, "snapshot-event")

	// Cancelling an unknown request is deliberately idempotent and silent.
	writeServicePayload(t, p.stdin, "cancel", map[string]any{
		"version": 1, "requestId": "already-finished",
	})
	writeServiceLine(t, p.stdin, "refresh")
	_ = awaitServiceFrame(t, p, "snapshot-event")

	writeServiceLine(t, p.stdin, "quit")
	_ = p.stdin.Close()
	done := make(chan error, 1)
	go func() { done <- p.cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("desktop-service exited with error: %v\nstderr: %s", err, p.stderr.String())
		}
	case <-time.After(serviceDeadline):
		t.Fatalf("desktop-service did not stop after command matrix\nstderr: %s", p.stderr.String())
	}
}

// TestDesktopServiceGeminiGatewayCreate exercises the exact path Erik reported
// missing: a Gemini gateway created from the Tạo Gateway/Proxy sheet must persist
// as a profile the resolver can bridge (snapshotUpstreamResolver seeds the
// GEMINI_API_KEY .env) and surface as a usable gateway action. It also guards
// the secret boundary — the api key must never cross the desktop protocol.
func TestDesktopServiceGeminiGatewayCreate(t *testing.T) {
	isolateEnv(t)
	bin := requireBuiltCLI(t)
	p := spawnDesktopService(t, bin)
	_ = awaitServiceFrame(t, p, "hello")
	host := desktop.HostHello{
		ProtocolVersion: desktop.ServiceProtocolVersion,
		AppVersion:      "(devel)",
		Platform:        "test",
		Capabilities: []string{
			"cancel-v1", "command-dto-v1", "explicit-refresh",
			"host-effects-v1", "post-mutation-events", "snapshot-dto-v1",
			"usage-events-v1",
		},
	}
	writeServiceLine(t, p.stdin, desktop.FrameHostHello(host))
	_ = awaitServiceFrame(t, p, "ready")
	_ = awaitServiceFrame(t, p, "snapshot")

	const gwKey = "AIza-fake-gemini-e2e-key"
	writeServicePayload(t, p.stdin, "mutate", map[string]any{
		"version":    1,
		"requestId":  "gemini-gw-1",
		"operation":  "gateway-create",
		"providerId": "gemini",
		"name":       "gemgw",
		"label":      "Gemini GW",
		"endpoint":   "https://generativelanguage.googleapis.com/v1beta",
		"apiKey":     gwKey,
	})
	created := decodeServicePayload(t, awaitServiceFrame(t, p, "result"))
	if created["requestId"] != "gemini-gw-1" || created["status"] != "success" {
		t.Fatalf("gemini gateway-create result = %#v", created)
	}

	// The gateway must surface as a gateway action in the post-mutation snapshot,
	// and the secret must not cross the desktop boundary.
	createdEvt := awaitServiceFrame(t, p, "snapshot-event")
	snap := decodeServicePayload(t, createdEvt)
	snapshotJSON, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(snapshotJSON), gwKey) {
		t.Fatal("gemini gateway api key crossed the desktop protocol boundary")
	}
	inner, _ := snap["snapshot"].(map[string]any)
	actions, _ := inner["actions"].([]any)
	found := false
	for _, a := range actions {
		row, _ := a.(map[string]any)
		if row["label"] == "gemgw" && row["kind"] == "gateway" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("created gemini gateway not surfaced as a gateway action in snapshot")
	}

	// Clean up so the isolated env does not leak the fixture gateway.
	writeServicePayload(t, p.stdin, "mutate", map[string]any{
		"version":   1,
		"requestId": "gemini-gw-remove-1",
		"operation": "gateway-remove",
		"name":      "gemgw",
	})
	removed := decodeServicePayload(t, awaitServiceFrame(t, p, "result"))
	if removed["requestId"] != "gemini-gw-remove-1" || removed["status"] != "success" {
		t.Fatalf("gemini gateway-remove result = %#v", removed)
	}

	writeServiceLine(t, p.stdin, "quit")
	_ = p.stdin.Close()
	done := make(chan error, 1)
	go func() { done <- p.cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("desktop-service exited with error: %v\nstderr: %s", err, p.stderr.String())
		}
	case <-time.After(serviceDeadline):
		t.Fatalf("desktop-service did not stop after gemini gateway test\nstderr: %s", p.stderr.String())
	}
}

// TestDesktopServicePublishesModelConfigForAGatewayRoute drives the model
// configuration path over the real protocol: create a gateway, point a client
// at it, then read back the snapshot the macOS Models pane consumes and apply
// a model role through the option id it published.
//
// The unit tests cover the builder and the resolver in-process; this one
// proves the wiring survives the binary, the frame codec and a real
// activation, which is where "the UI never appeared" actually happened.
func TestDesktopServicePublishesModelConfigForAGatewayRoute(t *testing.T) {
	isolateEnv(t)
	bin := requireBuiltCLI(t)
	p := spawnDesktopService(t, bin)
	_ = awaitServiceFrame(t, p, "hello")
	host := desktop.HostHello{
		ProtocolVersion: desktop.ServiceProtocolVersion,
		AppVersion:      "(devel)",
		Platform:        "test",
		Capabilities: []string{
			"cancel-v1", "command-dto-v1", "explicit-refresh",
			"host-effects-v1", "post-mutation-events", "snapshot-dto-v1",
			"usage-events-v1",
		},
	}
	writeServiceLine(t, p.stdin, desktop.FrameHostHello(host))
	_ = awaitServiceFrame(t, p, "ready")
	_ = awaitServiceFrame(t, p, "snapshot")

	drain := &serviceDrain{t: t, p: p}
	writeServicePayload(t, p.stdin, "mutate", map[string]any{
		"version": 1, "requestId": "gw-models-1", "operation": "gateway-create",
		"providerId": "custom", "name": "models-gw", "label": "Models GW",
		"endpoint": "https://example.invalid/v1", "apiKey": "models-gw-key",
	})
	if got := drain.result("gw-models-1"); got["status"] != "success" {
		t.Fatalf("gateway-create result = %#v", got)
	}
	inner := drain.snapshot()

	actionID := ""
	for _, row := range serviceRows(inner, "actions") {
		if row["clientId"] == "claude" && row["kind"] == "gateway" && row["label"] == "models-gw" {
			actionID, _ = row["id"].(string)
			break
		}
	}
	if actionID == "" {
		t.Fatalf("no claude gateway action in snapshot: %#v", inner["actions"])
	}
	writeServicePayload(t, p.stdin, "invoke", map[string]any{
		"version": 1, "requestId": "gw-models-invoke", "revision": serviceRevision(inner),
		"actionId": actionID,
	})
	if got := drain.result("gw-models-invoke"); got["status"] != "success" {
		t.Fatalf("invoke result = %#v", got)
	}
	bound := drain.snapshot()

	config := map[string]any(nil)
	for _, row := range serviceRows(bound, "clientModelConfigs") {
		if row["clientId"] == "claude" {
			config = row
			break
		}
	}
	if config == nil {
		t.Fatalf("no clientModelConfigs row for claude: %#v", bound["clientModelConfigs"])
	}
	roles, _ := config["roles"].([]any)
	options, _ := config["options"].([]any)
	if len(roles) == 0 || len(options) == 0 {
		t.Fatalf("model config incomplete: %#v", config)
	}
	if editable, _ := config["editable"].(bool); !editable {
		t.Fatalf("a bound gateway route must be editable: %#v", config)
	}

	// Apply the published default option — the exact request the macOS sheet
	// sends. An unpublished id must not be needed here.
	defaultAction := ""
	for _, raw := range options {
		option, _ := raw.(map[string]any)
		if model, _ := option["modelId"].(string); model != "" {
			defaultAction, _ = option["actionId"].(string)
			break
		}
	}
	writeServicePayload(t, p.stdin, "model-roles", map[string]any{
		"version": 1, "requestId": "gw-models-roles", "revision": serviceRevision(bound),
		"clientId": "claude", "roleActionIds": map[string]string{"default": defaultAction},
	})
	if got := drain.result("gw-models-roles"); got["status"] != "success" {
		t.Fatalf("model-roles with a published option failed: %#v", got)
	}

	writeServicePayload(t, p.stdin, "mutate", map[string]any{
		"version": 1, "requestId": "gw-models-remove", "operation": "gateway-remove",
		"name": "models-gw",
	})
	_ = drain.result("gw-models-remove")

	writeServiceLine(t, p.stdin, "quit")
	_ = p.stdin.Close()
	done := make(chan error, 1)
	go func() { done <- p.cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("desktop-service exited with error: %v\nstderr: %s", err, p.stderr.String())
		}
	case <-time.After(serviceDeadline):
		t.Fatalf("desktop-service did not stop after the model-config test\nstderr: %s", p.stderr.String())
	}
}

// serviceDrain reads frames until the one it wants arrives, remembering the
// newest snapshot it passed on the way.
//
// Snapshot events and result frames are independent emissions — a refresh
// that lands before a result is normal, not a protocol error — so a test that
// insists on frame order desyncs the first time one arrives early.
type serviceDrain struct {
	t      *testing.T
	p      *serviceProc
	latest map[string]any
}

func (d *serviceDrain) result(requestID string) map[string]any {
	d.t.Helper()
	for {
		line := nextServiceFrame(d.t, d.p)
		switch {
		case strings.HasPrefix(line, "snapshot-event\t"):
			d.latest = serviceSnapshot(d.t, line)
		case strings.HasPrefix(line, "result\t"):
			got := decodeServicePayload(d.t, line)
			if got["requestId"] == requestID {
				return got
			}
		}
	}
}

func (d *serviceDrain) snapshot() map[string]any {
	d.t.Helper()
	if d.latest != nil {
		snap := d.latest
		d.latest = nil
		return snap
	}
	for {
		line := nextServiceFrame(d.t, d.p)
		if strings.HasPrefix(line, "snapshot-event\t") {
			return serviceSnapshot(d.t, line)
		}
	}
}

func nextServiceFrame(t *testing.T, p *serviceProc) string {
	t.Helper()
	timer := time.NewTimer(serviceDeadline)
	defer timer.Stop()
	select {
	case line, ok := <-p.frames:
		if !ok {
			p.fatalf(t, "service stdout closed")
		}
		return line
	case <-timer.C:
		p.fatalf(t, "timeout after %s waiting for a service frame", serviceDeadline)
	}
	return ""
}

func serviceSnapshot(t *testing.T, frame string) map[string]any {
	t.Helper()
	event := decodeServicePayload(t, frame)
	inner, ok := event["snapshot"].(map[string]any)
	if !ok {
		t.Fatalf("snapshot-event carried no snapshot: %#v", event)
	}
	return inner
}

func serviceRows(snapshot map[string]any, key string) []map[string]any {
	raw, _ := snapshot[key].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if row, ok := item.(map[string]any); ok {
			out = append(out, row)
		}
	}
	return out
}

func serviceRevision(snapshot map[string]any) int {
	value, _ := snapshot["revision"].(float64)
	return int(value)
}

func writeServiceLine(t *testing.T, stdin interface{ Write([]byte) (int, error) }, line string) {
	t.Helper()
	if _, err := stdin.Write([]byte(line + "\n")); err != nil {
		t.Fatal(err)
	}
}

func writeServicePayload(
	t *testing.T,
	stdin interface{ Write([]byte) (int, error) },
	prefix string,
	payload any,
) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	writeServiceLine(t, stdin, prefix+"\t"+base64.StdEncoding.EncodeToString(raw))
}

func decodeServicePayload(t *testing.T, line string) map[string]any {
	t.Helper()
	_, encoded, ok := strings.Cut(line, "\t")
	if !ok {
		t.Fatalf("unframed service line: %q", line)
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("decode service frame: %v", err)
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("decode service JSON: %v", err)
	}
	return value
}

// serviceDeadline bounds how long one protocol frame may take to arrive.
//
// It is deliberately not tight. The child is a freshly spawned process that
// opens the account database and runs migrations before it can emit `hello`,
// and under a fully parallel `go test ./...` that cold start competes with
// every other package for CPU. Eight seconds was enough on an idle machine and
// not enough on a loaded one, which made this suite fail for reasons unrelated
// to the protocol it is testing. The bound still exists — it is not a wait
// forever — so a genuinely hung child fails the test instead of hanging CI.
const serviceDeadline = 30 * time.Second

// serviceProc is a spawned `desktop-service --stdio` child wired for
// frame-by-frame assertions.
type serviceProc struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	frames  <-chan string
	scanErr <-chan error
	stderr  *bytes.Buffer
}

// spawnDesktopService starts `bin desktop-service --stdio` and wires its
// protocol stdout into a frame channel.
//
// The child's stderr is captured and dumped whenever the test fails. A cross-
// process protocol test can fail *inside the child* for reasons the parent
// cannot observe, and "timeout waiting for service hello frame" with no stderr
// is unfalsifiable: it reads like a protocol bug when it is usually a startup
// failure. Reporting stderr is what makes the next occurrence diagnosable.
func spawnDesktopService(t *testing.T, bin string) *serviceProc {
	t.Helper()
	cmd := exec.Command(bin, "desktop-service", "--stdio")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	p := &serviceProc{cmd: cmd, stdin: stdin, stderr: &bytes.Buffer{}}
	cmd.Stderr = p.stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	frames := make(chan string, 64)
	scanErr := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), desktop.MaxServiceFrameBytes)
		for scanner.Scan() {
			frames <- scanner.Text()
		}
		scanErr <- scanner.Err()
		close(frames)
	}()
	p.frames = frames
	p.scanErr = scanErr
	t.Cleanup(func() {
		_ = stdin.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		if t.Failed() && p.stderr.Len() > 0 {
			t.Logf("desktop-service stderr:\n%s", p.stderr.String())
		}
	})
	return p
}

func awaitServiceFrame(t *testing.T, p *serviceProc, prefix string) string {
	t.Helper()
	timer := time.NewTimer(serviceDeadline)
	defer timer.Stop()
	for {
		select {
		case line, ok := <-p.frames:
			if !ok {
				select {
				case err := <-p.scanErr:
					p.fatalf(t, "service stdout closed waiting for %s: %v", prefix, err)
				default:
					p.fatalf(t, "service stdout closed waiting for %s", prefix)
				}
			}
			if strings.HasPrefix(line, prefix+"\t") {
				return line
			}
			p.fatalf(t, "unexpected protocol frame before %s: %q", prefix, line)
		case <-timer.C:
			p.fatalf(t, "timeout after %s waiting for service %s frame", serviceDeadline, prefix)
		}
	}
}

// fatalf fails the test with the child's stderr attached. Cleanup cannot be
// relied on for this: it runs after the killing of the process, and a reader
// diagnosing a CI failure should not have to scroll past the rest of the
// output to find out why the child said nothing.
func (p *serviceProc) fatalf(t *testing.T, format string, args ...any) {
	t.Helper()
	msg := fmt.Sprintf(format, args...)
	if p.stderr.Len() > 0 {
		msg += "\ndesktop-service stderr:\n" + p.stderr.String()
	}
	t.Fatal(msg)
}
