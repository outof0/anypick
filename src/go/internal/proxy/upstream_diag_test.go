package proxy

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The 11128 fingerprint lands in proxy.log, and proxy.log gets attached to
// bug reports. Naming the model and counting the messages is useful;
// repeating what the user typed is not.
func TestDescribeSanitizedOpenAILeaksNoPromptText(t *testing.T) {
	body := []byte(`{"model":"hy4-preview","messages":[{"role":"user","content":"my-secret-prompt"}],"tools":[{"name":"t"}]}`)
	got := describeSanitizedOpenAI(body)
	for _, want := range []string{"model=hy4-preview", "n=1", "lead=user", "tools=1"} {
		if !strings.Contains(got, want) {
			t.Fatalf("fingerprint = %q, want it to contain %q", got, want)
		}
	}
	if strings.Contains(got, "my-secret-prompt") {
		t.Fatalf("fingerprint leaked prompt text: %q", got)
	}
}

// A body that is not a JSON object must not panic or spill raw bytes.
func TestDescribeSanitizedOpenAIUnparseable(t *testing.T) {
	if got := describeSanitizedOpenAI([]byte("not json at all")); got != "unparseable" {
		t.Fatalf("fingerprint = %q, want \"unparseable\"", got)
	}
}

// Vendor-controlled content must never reach diagnostics: an upstream can
// echo prompts, tool arguments or secrets into its error message, and user
// tool names are user-defined. Only status, numeric code, request id and
// structural counts are allowlisted.
func TestDiagnosticsLogOnlyAllowlistedFields(t *testing.T) {
	canary := "canary-vendor-echo-must-not-persist"
	toolName := "canary-user-tool-name"

	vendor := `{"code":11128,"msg":"rejected, echoed prompt: ` + canary + `","requestId":"r1"}`
	got := describeVendorError(vendor, 400)
	if !strings.Contains(got, "code=11128") || !strings.Contains(got, "req=r1") {
		t.Fatalf("fingerprint lost allowlisted fields: %q", got)
	}
	if strings.Contains(got, canary) {
		t.Fatalf("vendor message leaked into diagnostics: %q", got)
	}

	got = describeVendorError("not json: "+canary, 400)
	if strings.Contains(got, canary) {
		t.Fatalf("raw vendor body leaked into diagnostics: %q", got)
	}

	shape := describeAnthropicShape([]byte(
		`{"model":"m","messages":[{"role":"user","content":"` + canary + `"}],"tools":[{"name":"` + toolName + `"}]}`))
	if !strings.Contains(shape, "tools=1") {
		t.Fatalf("fingerprint lost tool count: %q", shape)
	}
	if strings.Contains(shape, canary) || strings.Contains(shape, toolName) {
		t.Fatalf("user content leaked into shape fingerprint: %q", shape)
	}
}

// A vendor edge failure (APISIX/openresty 502/504) must be identifiable in the
// log without copying page bodies: only the bounded <title> is allowlisted.
func TestDescribeVendorErrorReadsGatewayTitleOnly(t *testing.T) {
	page := "<html><head><title>502 Bad Gateway</title></head><body>canary-body-secret</body></html>"
	got := describeVendorError(page, 502)
	if !strings.Contains(got, `html title="502 Bad Gateway"`) {
		t.Fatalf("gateway title missing: %q", got)
	}
	if strings.Contains(got, "canary-body-secret") {
		t.Fatalf("page body leaked into diagnostics: %q", got)
	}
}

// Regression for the P0 raw dump: serving a translated request that hits
// 11128 must never write inbound/sanitized bodies to disk. The canary stands
// in for prompt text, history, or pasted secrets.
func TestNoRawDumpOn11128(t *testing.T) {
	canary := "canary-11128-b9f27d-prompt-must-not-persist"
	dir := t.TempDir()
	t.Setenv("ANYPICK_HOME", dir)
	t.Setenv("HOME", dir)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"code":11128,"msg":"bad channel","requestId":"r1"}`))
	}))
	t.Cleanup(upstream.Close)
	base, _ := url.Parse(upstream.URL)
	up := &Upstream{BaseURL: base, Auth: "k", TranslateAnthropic: true}

	body := `{"model":"m","max_tokens":8,"messages":[{"role":"user","content":"` + canary + `"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body))
	rec := httptest.NewRecorder()
	// The 11128 diagnostic goes to the proxy log, which a spawned proxy writes
	// under ANYPICK_HOME. Checking only files would pass with the prompt in
	// the log.
	logs := captureProxyLogs(t)
	Serve(rec, req, up)

	if rec.Code != 400 {
		t.Fatalf("status = %d, want vendor 4xx passthrough", rec.Code)
	}
	// Without this the test also passes when the 11128 branch never ran.
	if !strings.Contains(logs.String(), "upstream 11128") {
		t.Fatalf("the 11128 diagnostic did not run; logs = %q", logs.String())
	}
	if strings.Contains(logs.String(), canary) {
		t.Fatalf("canary leaked into the proxy log: %q", logs.String())
	}
	// Walk the whole tree: a dump written under logs/ or a provider directory
	// is the same leak as one at the root.
	err := filepath.WalkDir(dir, func(path string, e fs.DirEntry, err error) error {
		if err != nil || e.IsDir() {
			return err
		}
		if e.Name() == "last-11128.json" {
			t.Errorf("raw dump file must not exist: %s", path)
		}
		p, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(p), canary) {
			t.Errorf("canary leaked into %s", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rec.Body.String(), canary) {
		t.Fatalf("canary leaked into response body")
	}
}
