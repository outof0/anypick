package main

import (
	"os"

	"golang.org/x/term"

	"github.com/outof0/anypick/go/internal/anyerr"
)

// promptSecret reads a credential from the terminal without echoing it. The
// value never enters shell history or the process listing, unlike --secret.
// It fails closed without a TTY (invariant #6): under pipes, CI, or --json
// the caller must pass --secret or ANYPICK_SECRET instead.
func promptSecret(label string) (string, error) {
	if globals.NoInput || !isTTY(os.Stdin) {
		return "", anyerr.Newf(
			"Refusing to prompt for "+label+" without a terminal.",
			"CONFIRMATION_REQUIRED",
			anyerr.WithExitCode(anyerr.InvalidUsage),
			anyerr.WithSuggestions("Pass --secret, or set ANYPICK_SECRET in the environment."))
	}
	cliFprintf(os.Stderr, "%s: ", label)
	b, err := term.ReadPassword(int(os.Stdin.Fd()))
	cliFprintln(os.Stderr)
	if err != nil {
		return "", anyerr.Wrapf(err, "read "+label, "OPERATIONAL")
	}
	return string(b), nil
}
