package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/app"
	"github.com/outof0/anypick/go/internal/cli"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/mgmtapi"
	"github.com/outof0/anypick/go/internal/proxy"
)

// cmdServe runs the management API (ADR-0034): a versioned, token-gated
// loopback HTTP surface for third-party tools. The desktop stdio protocol is
// separate and lives in internal/desktop.

func cmdServe(ctx context.Context, a *app.App, args []string) int {
	if len(args) > 0 && args[0] == "token" {
		return cmdServeToken(a, args[1:])
	}
	if cli.WantsHelp(args) {
		cliPrint("usage: anypick serve [--port <n>] [--detach] [--stop]\n" +
			"       anypick serve token [--rotate]\n\n" +
			"Runs the management API on loopback: /health, and /v1/... behind the\n" +
			"token that `anypick serve token` prints.\n" +
			"--detach runs it as a background child; --stop stops that child.\n")
		return int(anyerr.Success)
	}
	fs := fsFor(args)
	port := fs.Int("port", 0, "fixed port (default: auto)")
	detach := fs.Bool("detach", false, "run in a detached child, print endpoint, exit")
	stop := fs.Bool("stop", false, "stop a previously detached instance")
	if err := fs.Parse(reorder(args)); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return int(anyerr.Success)
		}
		return int(anyerr.InvalidUsage)
	}

	if *stop {
		return serveStop(a)
	}
	if *detach {
		return serveDetach(a, *port)
	}
	return serveRun(ctx, a, *port)
}

func servePIDPath(a *app.App) string  { return filepath.Join(a.Root, "serve.pid") }
func serveLockPath(a *app.App) string { return filepath.Join(a.Root, "serve.lock") }

type serveRecord struct {
	PID        int    `json:"pid"`
	Port       int    `json:"port"`
	InstanceID string `json:"instanceId"`
}

func serveRun(ctx context.Context, a *app.App, port int) int {
	daemonLock, lockErr := lock.AcquireFileLock(serveLockPath(a), 0)
	if lockErr != nil {
		if current := readServeRecord(a); serveRecordOwned(current) {
			emitOK(fmt.Sprintf("serve already running (pid %d)", current.PID),
				kv{Key: "ok", Value: true},
				kv{Key: "state", Value: "already running"},
				kv{Key: "pid", Value: current.PID})
			return int(anyerr.Success)
		}
		return reportErr(lockErr)
	}
	defer func() { _ = daemonLock.Release() }()

	if current := readServeRecord(a); serveRecordOwned(current) {
		emitOK(fmt.Sprintf("serve already running (pid %d)", current.PID),
			kv{Key: "ok", Value: true},
			kv{Key: "state", Value: "already running"},
			kv{Key: "pid", Value: current.PID})
		return int(anyerr.Success)
	}
	removeServePID(a)

	// Created before the listener so a tool never finds the API up with no
	// token to present.
	if _, err := mgmtapi.EnsureToken(a.Root); err != nil {
		return reportErr(err)
	}
	instanceID, err := proxy.NewInstanceID()
	if err != nil {
		return reportErr(err)
	}
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	ln, lerr := net.Listen("tcp", addr)
	if lerr != nil {
		return reportErr(lerr)
	}
	port = ln.Addr().(*net.TCPAddr).Port
	addr = fmt.Sprintf("127.0.0.1:%d", port)
	api := &mgmtapi.Server{
		App: a, InstanceID: instanceID, Port: port,
		StartHub: func(c context.Context, name string) (string, int, error) { return startHub(c, a, name) },
		StopHub:  func(c context.Context, name string) error { return stopHubChild(a, c, name) },
	}

	record := &serveRecord{PID: os.Getpid(), Port: port, InstanceID: instanceID}
	if err := writeServeRecord(a, record); err != nil {
		_ = ln.Close()
		return reportErr(err)
	}
	defer removeServeRecord(a, instanceID)

	srv := proxy.ApplyServingLimits(&http.Server{
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       30 * time.Second,
	})
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	if globals.JSON {
		emitOK("",
			kv{Key: "ok", Value: true},
			kv{Key: "addr", Value: "http://" + addr},
			kv{Key: "pid", Value: os.Getpid()})
	} else {
		cliPrintf("anypick-go serve → http://%s  (Ctrl-C to stop)\n", addr)
		cliPrintf("  /health   liveness (no token)\n  /v1/...   management API; token: anypick serve token\n")
	}
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return reportErr(err)
	}
	return int(anyerr.Success)
}

// cmdServeToken prints the management API bearer, creating it on first use,
// or replaces it with --rotate. Printing it is the command's purpose: the one
// sanctioned way a key reaches output (ADR-0034 decision 8).
func cmdServeToken(a *app.App, args []string) int {
	fs := fsFor(args)
	rotate := fs.Bool("rotate", false, "replace the token; the old one stops working at once")
	if err := fs.Parse(reorder(args)); err != nil || fs.NArg() != 0 {
		return usageError("usage: anypick serve token [--rotate]")
	}
	var token string
	var err error
	if *rotate {
		token, err = mgmtapi.RotateToken(a.Root)
	} else {
		token, err = mgmtapi.EnsureToken(a.Root)
	}
	if err != nil {
		return reportErr(err)
	}
	if globals.JSON {
		emitOK(token,
			kv{Key: "ok", Value: true},
			kv{Key: "token", Value: token},
			kv{Key: "rotated", Value: *rotate})
		return int(anyerr.Success)
	}
	cliPrintlnRaw(token)
	return int(anyerr.Success)
}

// serveDetach spawns self as a setsid child (same pattern as proxy children),
// waits for /health, prints the endpoint, exits.
func serveDetach(a *app.App, port int) int {
	if current := readServeRecord(a); serveRecordOwned(current) {
		if globals.JSON {
			emitOK("",
				kv{Key: "ok", Value: true},
				kv{Key: "state", Value: "already running"},
				kv{Key: "pid", Value: current.PID},
				kv{Key: "endpoint", Value: serveEndpoint(current)})
		} else {
			cliPrintf("serve already running (pid %d)\n%s\n", current.PID, serveEndpoint(current))
		}
		return int(anyerr.Success)
	}
	removeServePID(a)

	selfExe, err := os.Executable()
	if err != nil {
		return reportErr(err)
	}
	args := []string{"serve"}
	if port != 0 {
		args = append(args, "--port", strconv.Itoa(port))
	}
	child, err := spawnDetachedChild(selfExe, args, filepath.Join(a.Root, "serve.log"))
	if err != nil {
		return reportErr(err)
	}
	pid := child.Process.Pid
	go func() { _ = child.Wait() }()

	record, err := waitForServeReady(a, pid, 5*time.Second)
	if err != nil {
		if processAlivePath(pid) {
			_ = signalPID(pid)
		}
		return reportErr(err)
	}
	if record.PID != pid {
		if globals.JSON {
			emitOK("",
				kv{Key: "ok", Value: true},
				kv{Key: "state", Value: "already running"},
				kv{Key: "pid", Value: record.PID},
				kv{Key: "endpoint", Value: serveEndpoint(record)})
		} else {
			cliPrintf("serve already running (pid %d)\n%s\n", record.PID, serveEndpoint(record))
		}
		return int(anyerr.Success)
	}
	if globals.JSON {
		emitOK("",
			kv{Key: "ok", Value: true},
			kv{Key: "state", Value: "started"},
			kv{Key: "pid", Value: pid},
			kv{Key: "endpoint", Value: serveEndpoint(record)})
	} else {
		cliPrintf("anypick-go serve detached (pid %d)\n%s\nstop: anypick-go serve --stop\n",
			pid, serveEndpoint(record))
	}
	return int(anyerr.Success)
}

func serveStop(a *app.App) int {
	record := readServeRecord(a)
	if !serveRecordOwned(record) {
		removeServePID(a)
		emitOK("not running",
			kv{Key: "ok", Value: true},
			kv{Key: "state", Value: "not running"})
		return int(anyerr.Success)
	}
	if err := signalPID(record.PID); err != nil {
		return reportErr(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && serveRecordOwned(record) {
		time.Sleep(50 * time.Millisecond)
	}
	if serveRecordOwned(record) {
		return reportErr(anyerr.Newf("serve process did not stop after SIGTERM", "SERVE_STOP_FAILED"))
	}
	removeServeRecord(a, record.InstanceID)
	emitOK(fmt.Sprintf("stopped (pid %d)", record.PID),
		kv{Key: "ok", Value: true},
		kv{Key: "state", Value: "stopped"},
		kv{Key: "pid", Value: record.PID})
	return int(anyerr.Success)
}

func writeServeRecord(a *app.App, record *serveRecord) error {
	return writeJSONFile(servePIDPath(a), record, 0o600)
}

func readServeRecord(a *app.App) *serveRecord {
	var record serveRecord
	raw, err := os.ReadFile(servePIDPath(a))
	if err != nil || json.Unmarshal(raw, &record) != nil {
		return nil
	}
	if record.PID <= 0 || record.Port <= 0 || record.InstanceID == "" {
		return nil
	}
	return &record
}

func serveEndpoint(record *serveRecord) string {
	if record == nil {
		return ""
	}
	return fmt.Sprintf("http://127.0.0.1:%d", record.Port)
}

func serveRecordOwned(record *serveRecord) bool {
	if record == nil || !processAlivePath(record.PID) {
		return false
	}
	client := &http.Client{Timeout: 300 * time.Millisecond}
	resp, err := client.Get(serveEndpoint(record) + "/health")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var health struct {
		OK         bool   `json:"ok"`
		PID        int    `json:"pid"`
		InstanceID string `json:"instanceId"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<10)).Decode(&health); err != nil {
		return false
	}
	return health.OK && health.PID == record.PID && health.InstanceID == record.InstanceID
}

func removeServePID(a *app.App) { _ = os.Remove(servePIDPath(a)) }

func removeServeRecord(a *app.App, instanceID string) {
	if current := readServeRecord(a); current != nil && current.InstanceID != instanceID {
		return
	}
	removeServePID(a)
}

func waitForServeReady(a *app.App, childPID int, timeout time.Duration) (*serveRecord, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if current := readServeRecord(a); serveRecordOwned(current) {
			if current.PID == childPID || !processAlivePath(childPID) {
				return current, nil
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return nil, anyerr.Newf("serve child did not become healthy", "HEALTH_FAILURE")
}

func processAlivePath(pid int) bool {
	if pid <= 0 {
		return false
	}
	return signalProbe(pid) == nil
}

func writeJSONFile(path string, v interface{}, mode os.FileMode) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), mode)
}

func signalProbe(pid int) error {
	if platformProcessAlive(pid) {
		return nil
	}
	return fmt.Errorf("process %d is not running", pid)
}

func spawnDetachedChild(selfExe string, args []string, logPath string) (*exec.Cmd, error) {
	cmd := exec.Command(selfExe, args...)
	var logFile *os.File
	if logPath != "" {
		f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return nil, err
		}
		logFile = f
		cmd.Stdout = f
		cmd.Stderr = f
	}
	if err := startPlatformProcess(cmd); err != nil {
		if logFile != nil {
			_ = logFile.Close()
		}
		return nil, err
	}
	if logFile != nil {
		_ = logFile.Close()
	}
	return cmd, nil
}

func signalPID(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("no pid")
	}
	return terminatePlatformPID(pid)
}
