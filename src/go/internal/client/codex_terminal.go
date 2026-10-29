package client

import (
	"fmt"
	"path/filepath"

	"github.com/outof0/anypick/go/internal/atomicfile"
)

// ErrCodexTerminalUnsupported reports a platform without the terminal launch
// path. open(1) hands a .command file to the user's terminal; Linux and
// Windows have no equivalent default handler.
var ErrCodexTerminalUnsupported = fmt.Errorf("opening a Codex profile in a terminal is supported only on macOS")

// CodexProfileTerminalSupported reports whether this machine can open a
// profile in a terminal window.
func CodexProfileTerminalSupported() bool { return codexAppGOOS == "darwin" }

// CodexProfileTerminalScriptPath is the .command file a terminal runs to
// start the Codex CLI on one profile. It holds the launch command only: paths,
// never the route's token.
func CodexProfileTerminalScriptPath(root, name string) string {
	if root == "" {
		root = anyPickRootFallback()
	}
	return filepath.Join(root, "clients", "codex", "profiles", name, "open-in-terminal.command")
}

// LaunchCodexProfileTerminal opens a terminal window running command, the
// profile's launch command (CodexProfileLaunchCommand). The script runs it in
// the user's login shell: the terminal starts a .command file with a bare
// environment, and `codex` is usually on a PATH only the login profile sets.
// The command is POSIX shell (`source`, `&&`, `VAR=value cmd`), and csh-family
// shells reject `-l` with `-c`, so a login shell outside the POSIX family is
// replaced by zsh, macOS's default.
func LaunchCodexProfileTerminal(root, name, command string) error {
	if err := ValidateCodexProfileName(name); err != nil {
		return err
	}
	if !CodexProfileTerminalSupported() {
		return ErrCodexTerminalUnsupported
	}
	path := CodexProfileTerminalScriptPath(root, name)
	script := "#!/bin/sh\n" +
		"# Written by AnyPick: runs Codex on profile " + name + ".\n" +
		"case \"${SHELL##*/}\" in\n" +
		"  zsh|bash|sh|ksh|dash) login=\"$SHELL\" ;;\n" +
		"  *) login=/bin/zsh ;;\n" +
		"esac\n" +
		"exec \"$login\" -l -c " + shellQuote(command) + "\n"
	if err := atomicfile.Write(path, []byte(script), 0o700); err != nil {
		return err
	}
	return codexAppOpen([]string{path})
}
