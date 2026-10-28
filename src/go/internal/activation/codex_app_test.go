package activation

import (
	"context"
	"os"
	"testing"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/client"
)

// The app config carries the route's bearer token and is the CLI's base
// config in that CODEX_HOME, so a platform that cannot launch the app must
// fail before writing it.
func TestOpenCodexProfileAppRefusesUnsupportedPlatformBeforeWriting(t *testing.T) {
	env := newTestEnv(t)
	t.Cleanup(client.SetCodexAppPlatformForTest("linux"))

	err := OpenCodexProfileApp(context.Background(), "work", env.Deps)
	var ae *anyerr.Error
	if !errorsAsAny(err, &ae) || ae.Code != "UNSUPPORTED_PLATFORM" {
		t.Fatalf("err = %v", err)
	}
	if _, statErr := os.Stat(client.CodexProfileAppConfigPath(env.Deps.Root, "work")); !os.IsNotExist(statErr) {
		t.Fatalf("app config written on an unsupported platform: %v", statErr)
	}
}
