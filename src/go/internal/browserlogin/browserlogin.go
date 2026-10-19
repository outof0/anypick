// Package browserlogin runs a provider's own login-only command without
// forwarding its output, so OAuth URLs, device codes, and tokens never cross
// the tray/JSON output boundary.
package browserlogin

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
)

const DefaultTimeout = 10 * time.Minute

// TerminationGrace bounds how long a SIGTERMed launcher may stay alive before
// the process group is force-killed. A launcher that traps or ignores TERM
// must not hold the provider mutation lock (or a desktop operation) forever.
const TerminationGrace = 3 * time.Second

type Command struct {
	Names      []string
	ExtraPaths []string
	Args       []string
	Env        map[string]string
	Timeout    time.Duration // zero selects DefaultTimeout
}

// Method carries the availability result for a declared login method.
// The caller supplies every field except
// Available/UnavailableReason, which only this package may decide.
type Method struct {
	ID          string
	Label       string
	Description string
	Provenance  string
	Preferred   bool
	Source      string
	// SourceLabel names the local credential store this method reads when it
	// is selected as an existing-account source. It is separate from Label:
	// the latter describes the sign-in product, while native UI needs to say
	// which local app owns the detected login.
	SourceLabel       string
	Available         bool
	UnavailableReason string
}

// Availability resolves whether the launcher binary exists right now.
func Availability(base Method, command Command) Method {
	if ResolveBinary(command.Names, command.ExtraPaths) != "" {
		base.Available = true
		return base
	}
	base.Available = false
	base.UnavailableReason = "The provider login launcher is not installed."
	return base
}

// ResolveBinary searches extra paths first, then each bare name on PATH.
// Names containing a separator are used verbatim. Returns "" when nothing
// executable is found.
func ResolveBinary(names []string, extraPaths []string) string {
	var candidates []string
	candidates = append(candidates, extraPaths...)
	dirs := filepath.SplitList(os.Getenv("PATH"))
	for _, declaredName := range names {
		for _, name := range executableNames(declaredName) {
			if name == "" {
				continue
			}
			if strings.ContainsRune(name, '/') || strings.ContainsRune(name, filepath.Separator) {
				candidates = append(candidates, name)
				continue
			}
			for _, dir := range dirs {
				if dir == "" {
					continue
				}
				candidates = append(candidates, filepath.Join(dir, name))
			}
		}
	}
	for _, c := range candidates {
		if accessibleExecutable(c) {
			return c
		}
	}
	return ""
}

func errUnavailable() error {
	return anyerr.Newf(
		"The provider login launcher is not installed.",
		"PROVIDER_LOGIN_UNAVAILABLE",
		anyerr.WithSuggestions("Install the provider's official login tool, then try again."))
}

func errCancelled() error {
	return anyerr.Newf("Browser sign-in was cancelled.", "PROVIDER_LOGIN_CANCELLED")
}

func errTimeout() error {
	return anyerr.Newf(
		"Browser sign-in timed out.",
		"PROVIDER_LOGIN_TIMEOUT",
		anyerr.WithSuggestions("Try Sign In again and complete the browser flow within ten minutes."))
}

func errInterrupted() error {
	return anyerr.Newf(
		"Provider sign-in was interrupted.",
		"PROVIDER_LOGIN_FAILED",
		anyerr.WithSuggestions("Try Sign In again and finish the provider's browser flow."))
}

func errIncomplete() error {
	return anyerr.Newf(
		"Provider sign-in did not complete.",
		"PROVIDER_LOGIN_FAILED",
		anyerr.WithSuggestions("Try Sign In again and finish the provider's browser flow."))
}

func errStart() error {
	return anyerr.Newf(
		"The provider login launcher could not be started.",
		"PROVIDER_LOGIN_FAILED",
		anyerr.WithSuggestions("Check the provider installation, then try again."))
}

// Run executes the provider's own login command with output discarded and
// returns once the child exits successfully. Cancellation via ctx kills the
// child's process group and yields PROVIDER_LOGIN_CANCELLED; the ten-minute
// default timeout yields PROVIDER_LOGIN_TIMEOUT.
func Run(ctx context.Context, command Command, home string) error {
	binary := ResolveBinary(command.Names, command.ExtraPaths)
	if binary == "" {
		return errUnavailable()
	}
	if err := ctx.Err(); err != nil {
		return errCancelled()
	}

	timeout := command.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}

	child := exec.Command(binary, command.Args...) // #nosec G204 — provider-owned launcher resolved above
	env := os.Environ()
	filtered := env[:0]
	for _, entry := range env {
		if isHomeEnvironment(entry) {
			continue
		}
		filtered = append(filtered, entry)
	}
	filtered = append(filtered, "HOME="+home)
	filtered = append(filtered, platformHomeEnvironment(home)...)
	for k, v := range command.Env {
		filtered = append(filtered, k+"="+v)
	}
	child.Env = filtered
	// Provider login output may contain an OAuth URL or one-time code. The
	// browser is the user-facing surface; no child bytes cross our boundary.
	child.Stdout = nil
	child.Stderr = nil
	child.Stdin = nil
	controller, err := startIsolatedChild(child)
	if err != nil {
		return errStart()
	}
	defer controller.close()

	// Arm the timeout only after Start: the AfterFunc callback reads
	// child.Process, so arming earlier races Start's write of that field
	// (-race catches this; TestRunTimeout pins it).
	var timedOut atomic.Bool
	timer := time.AfterFunc(timeout, func() {
		timedOut.Store(true)
		controller.terminate()
	})
	defer timer.Stop()
	// A launcher that traps TERM must not extend the timeout indefinitely:
	// escalate to a group SIGKILL after the same grace period.
	escalate := time.AfterFunc(timeout+TerminationGrace, func() {
		controller.kill()
	})
	defer escalate.Stop()

	waitc := make(chan error, 1)
	go func() { waitc <- child.Wait() }()

	var waitErr error
	cancelled := false
	select {
	case <-ctx.Done():
		cancelled = true
		controller.terminate()
		waitErr = awaitExit(controller, waitc)
	case waitErr = <-waitc:
	}

	switch {
	case timedOut.Load():
		return errTimeout()
	case cancelled:
		return errCancelled()
	}

	if waitErr == nil {
		return nil
	}
	var exitErr *exec.ExitError
	if !errors.As(waitErr, &exitErr) {
		return errStart()
	}
	if processWasSignaled(exitErr) {
		return errInterrupted()
	}
	return errIncomplete()
}

// awaitExit waits TerminationGrace for the child to exit after SIGTERM; a
// launcher that traps or ignores TERM is then force-killed as a whole process
// group. The returned error is whatever Wait reported (or nil on timeout kill).
func awaitExit(controller childController, waitc <-chan error) error {
	select {
	case err := <-waitc:
		return err
	case <-time.After(TerminationGrace):
	}
	// Escalate: SIGKILL cannot be trapped or ignored.
	controller.kill()
	select {
	case err := <-waitc:
		return err
	case <-time.After(5 * time.Second):
		// Wait itself is stuck (pathological kernel state); give up waiting so
		// the caller can release its locks. The zombie is reaped by init.
		return nil
	}
}
