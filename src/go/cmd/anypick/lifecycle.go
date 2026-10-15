package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mattn/go-isatty"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/app"
	"github.com/outof0/anypick/go/internal/cli"
)

// knownGlobalFlags are accepted before or after the subcommand (invariant #7:
// machine output stays machine-readable regardless of position). The short
// names are aliases of the long ones: the reference documents `-y`, `-q` and
// `-v`, and isGlobalFlag strips leading dashes, so a bare "y" key is what
// `-y` looks up.
var knownGlobalFlags = map[string]bool{
	"json": true, "dry-run": true, "no-input": true, "yes": true,
	"quiet": true, "verbose": true, "trace": true, "reveal": true,
	"tray": true,
	"y":    true, "q": true, "v": true,
}

func isGlobalFlag(arg string) bool {
	if !strings.HasPrefix(arg, "-") {
		return false
	}
	return knownGlobalFlags[strings.TrimLeft(arg, "-")]
}

// globals records root-level global options so subcommand handlers honor them
// even though they were consumed before the command name.
var globals struct {
	JSON    bool
	DryRun  bool
	NoInput bool
	Yes     bool
	Quiet   bool
	Verbose bool
	Trace   bool
	Reveal  bool
	Tray    bool
}

// globalJSON is kept as an alias for the many existing wantJSON call sites.
var globalJSON bool

func recordGlobalFlag(name string) bool {
	switch name {
	case "json":
		globals.JSON, globalJSON = true, true
	case "dry-run":
		globals.DryRun = true
	case "no-input":
		globals.NoInput = true
	case "yes", "y":
		globals.Yes = true
	case "quiet", "q":
		globals.Quiet = true
	case "verbose", "v":
		globals.Verbose = true
	case "trace":
		globals.Trace = true
	case "reveal":
		globals.Reveal = true
	case "tray":
		globals.Tray = true
	default:
		return false
	}
	return true
}

func extractGlobals(args []string) []string {
	for len(args) > 0 && isGlobalFlag(args[0]) {
		recordGlobalFlag(strings.TrimLeft(args[0], "-"))
		args = args[1:]
	}
	return args
}

// normalizeGlobalFlags records recognized root flags appearing anywhere before
// the first bare "--" and removes them from argv, so `use x --with y
// --dry-run` parses like `--dry-run use x --with y`. Everything after "--" is
// pass-through payload (e.g. `run … -- <child argv>`) and stays verbatim.
func normalizeGlobalFlags(args []string) []string {
	out := make([]string, 0, len(args))
	passthrough := false
	for _, arg := range args {
		if !passthrough && arg == "--" {
			passthrough = true
			out = append(out, arg)
			continue
		}
		if !passthrough && isGlobalFlag(arg) {
			recordGlobalFlag(strings.TrimLeft(arg, "-"))
			continue
		}
		out = append(out, arg)
	}
	return out
}

// tracef prints internal step names to STDERR only when --trace is set —
// stdout must stay clean for machine consumers (no secrets in step lines).
func tracef(format string, args ...interface{}) {
	if globals.Trace {
		cliFprintf(os.Stderr, "[trace] "+format+"\n", args...)
	}
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// printDryRun prints the dry-run plan: JSON mode emits one machine-readable
// line; human mode an informational note on stdout (progress stays on stderr).
func printDryRun(action, detail string, extra map[string]any) {
	if globals.JSON {
		out := map[string]any{"dryRun": true, "action": action}
		for k, v := range extra {
			out[k] = v
		}
		jsonOut(out)
		return
	}
	cliPrintf("[dry-run] %s\n", detail)
}

// runSuperviseChild keeps enabled proxies alive until terminated. This is the
// real headless supervisor body: without it a detached `app` would exit as
// soon as its stdin hit EOF.
func runSuperviseChild(ctx context.Context, a *appView) int {
	dir := supervisorRuntimeDir(a.Root)
	started := [][2]string{} // provider/account pairs we own
	for _, providerID := range a.Providers.IDs() {
		list, lerr := a.Accounts.List(ctx, providerID)
		if lerr != nil {
			continue
		}
		for _, acct := range list {
			cfg, _ := a.Proxy.ProxyConfig(ctx, providerID, acct.Meta.Name)
			if !cfg.Enabled {
				continue
			}
			if _, serr := a.Proxy.StartProxy(ctx, providerID, acct.Meta.Name); serr == nil {
				started = append(started, [2]string{providerID, acct.Meta.Name})
			}
		}
	}
	if mkErr := os.MkdirAll(dir, 0o700); mkErr == nil {
		_ = os.WriteFile(filepath.Join(dir, "ready"), []byte(fmt.Sprint(os.Getpid())+"\n"), 0o600)
	}
	awaitSignal(ctx)
	for _, pair := range started {
		_ = a.Proxy.Stop(context.Background(), pair[0], pair[1])
	}
	_ = os.Remove(filepath.Join(dir, "ready"))
	return int(anyerr.Success)
}

// cmdTray is the explicit `tray` entry (same core as bare `anypick app`).
func cmdTray(ctx context.Context, a *app.App, args []string) int {
	// `tray start|stop` manage the supervisor exactly like `start`/`stop`;
	// any other invocation opens the app.
	if len(args) > 0 {
		switch args[0] {
		case "start":
			return cmdStart(ctx, a, args[1:])
		case "stop":
			return cmdStop(a, args[1:])
		case "status":
			// Route `tray status` to the supervisor status path instead of
			// the app-run protocol.
			return cmdStatus(a, args[1:])
		}
	}
	if cli.WantsHelp(args) {
		cliPrint(`Usage:
  anypick tray                open the menu-bar tray app
  anypick tray start|stop|status
  anypick desktop-service --stdio   (used by the native app; not for humans)

The bare form attaches this process to the tray app over the desktop
protocol and does not return while the app runs. It is not a snapshot
command; use anypick status --json or anypick current <provider> for that.
`)
		return int(anyerr.Success)
	}
	// A non-TTY stdout can never host the desktop protocol: the frames are
	// length-prefixed lines a script cannot read, and a cron job or pipe that
	// ran the documented `anypick tray` used to receive 29KB of base64 on
	// stdout from a process that never returned. Refuse instead of streaming;
	// a human on a terminal still gets the app, which is what the command means.
	if !isatty.IsTerminal(os.Stdout.Fd()) {
		return reportErr(anyerr.Newf(
			"anypick tray opens the tray app and needs a terminal; for a status snapshot use `anypick status --json`",
			"NO_TTY", anyerr.WithExitCode(anyerr.InvalidUsage)))
	}
	return cmdAppRun(ctx, a, args)
}

// cmdStart launches the headless supervisor detached so enabled proxies stay
// alive. Readiness is the `ready` marker the child touches after it finished
// its startup work — a bare pid is not proof the supervisor can do its job.
func cmdStart(ctx context.Context, a *appView, args []string) int {
	if cli.WantsHelp(args) {
		cliPrint(`Usage:
  anypick start
  anypick status [--json]
  anypick stop

Start, inspect, or stop the headless supervisor that keeps enabled proxies alive.
`)
		return int(anyerr.Success)
	}
	if globals.DryRun {
		printDryRun("tray.start", "Would start the AnyPick tray supervisor", nil)
		return int(anyerr.Success)
	}
	dir := supervisorRuntimeDir(a.Root)
	pidFile := filepath.Join(dir, "service.pid")
	if pid := readPID(pidFile); pid != 0 {
		if wantJSON(args) {
			jsonOut(map[string]interface{}{"running": true, "pid": pid})
			return int(anyerr.Success)
		}
		cliPrintf("already running (pid %d)\n", pid)
		return int(anyerr.Success)
	}
	_ = os.Remove(filepath.Join(dir, "ready"))
	pid, err := spawnDetachedService(a.Root, []string{"_supervise"}, pidFile)
	if err != nil {
		return reportErr(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, rerr := os.Stat(filepath.Join(dir, "ready")); rerr == nil && processAlive(pid) {
			break
		}
		if !processAlive(pid) {
			return reportErr(anyerr.Newf(
				"supervisor exited during startup; see "+filepath.Join(dir, "service.log"),
				"SUPERVISOR_START_FAILED"))
		}
		time.Sleep(100 * time.Millisecond)
	}
	if wantJSON(args) {
		jsonOut(map[string]interface{}{"started": true, "pid": pid})
	} else {
		cliPrintf("started supervisor (pid %d)\n", pid)
	}
	return int(anyerr.Success)
}

func cmdStatus(a *appView, args []string) int {
	if cli.WantsHelp(args) {
		cliPrint(`Usage:
  anypick status [--json]
`)
		return int(anyerr.Success)
	}
	pid := readPID(filepath.Join(supervisorRuntimeDir(a.Root), "service.pid"))
	running := pid != 0
	if wantJSON(args) {
		jsonOut(map[string]interface{}{
			"running": running,
			"pid":     pid,
			"trayPid": app.RunningTrayPid(a.Root),
			"surface": surfaceName(),
		})
		return int(anyerr.Success)
	}
	if running {
		cliPrintf("supervisor running (pid %d)\n", pid)
	} else {
		cliPrintln("not running")
	}
	return int(anyerr.Success)
}

func cmdStop(a *appView, args []string) int {
	if cli.WantsHelp(args) {
		cliPrint(`Usage:
  anypick stop [--json]
`)
		return int(anyerr.Success)
	}
	if globals.DryRun {
		printDryRun("tray.stop", "Would stop the AnyPick tray supervisor and proxies", nil)
		return int(anyerr.Success)
	}
	stopped := stopDetached(filepath.Join(supervisorRuntimeDir(a.Root), "service.pid"))
	_ = os.Remove(filepath.Join(supervisorRuntimeDir(a.Root), "ready"))
	if wantJSON(args) {
		jsonOut(map[string]bool{"stopped": stopped})
	} else if stopped {
		cliPrintln("stopped")
	} else {
		cliPrintln("not running")
	}
	return int(anyerr.Success)
}

func supervisorRuntimeDir(root string) string {
	return filepath.Join(root, "runtime", "supervisor")
}

func surfaceName() string { return "cli" }
