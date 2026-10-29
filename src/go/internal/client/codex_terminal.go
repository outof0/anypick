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
// profile's launch command (CodexProfileLaunchCommand), through the script
// codexTerminalScript writes.
func LaunchCodexProfileTerminal(root, name, command string) error {
	if err := ValidateCodexProfileName(name); err != nil {
		return err
	}
	if !CodexProfileTerminalSupported() {
		return ErrCodexTerminalUnsupported
	}
	path := CodexProfileTerminalScriptPath(root, name)
	script := codexTerminalScript(name, command)
	if err := atomicfile.Write(path, []byte(script), 0o700); err != nil {
		return err
	}
	return codexAppOpen([]string{path})
}

// codexTerminalScript runs the launch command the way the user's own shell
// would find it, whatever that shell is.
//
// A terminal starts a .command file with a bare PATH, and `codex` is usually
// on a PATH that only the user's shell startup files set (Homebrew in
// .zprofile, a Node version manager in .zshrc or config.fish). So the script
// asks the user's login shell, read from the account record (dscl) rather
// than $SHELL, for its PATH, in the form each shell family accepts: zsh and
// bash as interactive login shells, so .zshrc/.bashrc run too; fish as a
// login shell; csh and tcsh without -l, which they reject next to -c.
// printenv prints PATH colon-joined from every shell, fish included.
//
// The launch command itself is POSIX (`source`, `&&`, `VAR=value cmd`), so it
// runs in /bin/sh with that PATH, in a subshell so the profile's env file does
// not leak into what follows. When Codex exits, the window becomes the user's
// own login shell instead of closing.
func codexTerminalScript(name, command string) string {
	return `#!/bin/sh
# Written by AnyPick: runs Codex on profile ` + name + `.
user_shell=$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | sed -n 's/^UserShell: //p')
[ -x "$user_shell" ] || user_shell=${SHELL:-/bin/zsh}
case "${user_shell##*/}" in
  zsh|bash) user_path=$("$user_shell" -i -l -c 'printenv PATH' </dev/null 2>/dev/null | tail -n 1) ;;
  csh|tcsh) user_path=$("$user_shell" -c 'printenv PATH' </dev/null 2>/dev/null | tail -n 1) ;;
  *) user_path=$("$user_shell" -l -c 'printenv PATH' </dev/null 2>/dev/null | tail -n 1) ;;
esac
[ -n "$user_path" ] && PATH=$user_path && export PATH
if command -v codex >/dev/null 2>&1; then
  (` + command + `)
else
  echo "AnyPick: codex is not on the PATH your $user_shell sets up. Install Codex CLI, or add it to PATH, then run:" >&2
  echo ` + shellQuote(command) + ` >&2
fi
exec "$user_shell" -l
`
}
