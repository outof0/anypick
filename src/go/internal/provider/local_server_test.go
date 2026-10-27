package provider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalServerEndpoints(t *testing.T) {
	ollama := newOllama()
	for _, tc := range []struct {
		name, profile string
		hasKey        bool
		want          string
		wantErr       string
	}{
		{name: "CLI default profile", profile: "global", want: "http://127.0.0.1:11434/v1"},
		{name: "picker default profile", profile: "default", want: "http://127.0.0.1:11434/v1"},
		{name: "empty profile", profile: "", want: "http://127.0.0.1:11434/v1"},
		{name: "bare host gets /v1", profile: "http://10.0.0.5:11434", want: "http://10.0.0.5:11434/v1"},
		{name: "trailing slash dropped", profile: "http://localhost:11434/v1/", want: "http://localhost:11434/v1"},
		{name: "keyless LAN http is fine", profile: "http://192.168.1.20:11434/v1", want: "http://192.168.1.20:11434/v1"},
		{name: "key over loopback http is fine", profile: "http://127.0.0.1:1234/v1", hasKey: true, want: "http://127.0.0.1:1234/v1"},
		{name: "key over https is fine", profile: "https://models.example.test/v1", hasKey: true, want: "https://models.example.test/v1"},
		{name: "key over LAN http is refused", profile: "http://192.168.1.20:1234/v1", hasKey: true, wantErr: "only over https"},
		{name: "not a URL", profile: "ollama.local", wantErr: "http(s) URL"},
		{name: "credentials in the URL", profile: "http://user:pw@127.0.0.1:11434/v1", wantErr: "must not carry"},
		{name: "query string", profile: "http://127.0.0.1:11434/v1?key=x", wantErr: "must not carry"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ollama.resolveEndpoint(tc.profile, tc.hasKey)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("want error containing %q, got %q, %v", tc.wantErr, got, err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}

// The account works with no key at all, and the proxy then sends none.
func TestLocalServerKeylessRoundTrip(t *testing.T) {
	var sawAuth bool
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, sawAuth = r.Header["Authorization"]
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"qwen3:8b"},{"id":"llama3.2"}]}`))
	}))
	t.Cleanup(stub.Close)

	snap := t.TempDir()
	lm := newLMStudio()
	info, err := lm.BackupInput("server", "", stub.URL, snap)
	if err != nil {
		t.Fatal(err)
	}
	if info.Identity == "" || strings.Contains(info.Identity, "http") {
		t.Fatalf("identity = %q, want the server host", info.Identity)
	}
	raw, err := os.ReadFile(filepath.Join(snap, localServerCredentialFile))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"secret"`) {
		t.Fatalf("a keyless account stored a secret field: %s", raw)
	}
	up, err := lm.ResolveUpstream(snap)
	if err != nil {
		t.Fatal(err)
	}
	if up.Auth != "" || !up.TranslateAnthropic || up.BaseURL.Path != "/v1" {
		t.Fatalf("upstream = auth %q translate %v path %q", up.Auth, up.TranslateAnthropic, up.BaseURL.Path)
	}
	models, err := up.ModelDiscovery(context.Background())
	if err != nil || strings.Join(models, ",") != "qwen3:8b,llama3.2" {
		t.Fatalf("models = %v, %v", models, err)
	}
	if sawAuth {
		t.Fatal("a keyless model listing sent an Authorization header")
	}
}

func TestLocalServerRefusesOtherKinds(t *testing.T) {
	if _, err := newOllama().BackupInput("api-key", "sk-x", "default", t.TempDir()); err == nil {
		t.Fatal("ollama accepted a kind it does not publish")
	}
}

func TestLocalServerPublishesAKeyOptionalProduct(t *testing.T) {
	for _, p := range []*localServer{newOllama(), newLMStudio()} {
		defs := p.CredentialDefinitions()
		if len(defs) != 1 || !defs[0].SecretOptional || defs[0].Kind != localServerCredentialKind {
			t.Fatalf("%s definitions = %+v", p.id, defs)
		}
		if len(defs[0].Profiles) != 1 || defs[0].Profiles[0].ID != localServerDefaultProfile {
			t.Fatalf("%s profiles = %+v", p.id, defs[0].Profiles)
		}
	}
}
