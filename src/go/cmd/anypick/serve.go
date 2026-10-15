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

	"github.com/outof0/anypick/go/internal/agentbridge"
	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/app"
	"github.com/outof0/anypick/go/internal/cli"
	"github.com/outof0/anypick/go/internal/lock"
	"github.com/outof0/anypick/go/internal/proxy"
)

// cmdServe runs the long-running core: a loopback-only, token-free status
// surface (accounts, proxy liveness) that detached proxies keep serving traffic
// independently. The desktop stdio protocol lives in internal/desktop.

func cmdServe(ctx context.Context, a *app.App, args []string) int {
	if cli.WantsHelp(args) {
		cliPrint("usage: anypick serve [--port <n>] [--detach] [--stop]\n\n" +
			"Runs the local status server: /health, /status, /agents on loopback.\n" +
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
	mux := serveMux(a, instanceID)

	record := &serveRecord{PID: os.Getpid(), Port: port, InstanceID: instanceID}
	if err := writeServeRecord(a, record); err != nil {
		_ = ln.Close()
		return reportErr(err)
	}
	defer removeServeRecord(a, instanceID)

	srv := proxy.ApplyServingLimits(&http.Server{
		Handler:           mux,
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
		cliPrintf("  /health   liveness\n  /status   accounts + proxies\n  /agents   redacted worker manifest\n")
	}
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return reportErr(err)
	}
	return int(anyerr.Success)
}

func serveMux(a *app.App, instanceID string) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		cliFprintf(w, `{"ok":true,"pid":%d,"instanceId":%q}`, os.Getpid(), instanceID)
	})
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(serveStatusSnapshot(r.Context(), a))
	})
	mux.HandleFunc("/agents", func(w http.ResponseWriter, r *http.Request) {
		manifest, manifestErr := agentbridge.Build(r.Context(), agentbridge.Deps{
			Activation: a.Deps,
			Clients:    a.Clients,
			Bindings:   a.BindingSvc,
			Proxy:      a.Proxy,
		})
		if manifestErr != nil {
			http.Error(w, "agent manifest unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(manifest)
	})
	return mux
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

// serveStatusSnapshot aggregates account + proxy state without secrets.
func serveStatusSnapshot(ctx context.Context, a *app.App) map[string]interface{} {
	type acctRow struct {
		Provider string `json:"provider"`
		Name     string `json:"name"`
		Active   bool   `json:"active"`
		Identity string `json:"identity,omitempty"`
		Live     bool   `json:"liveMatch"`
	}
	accountsOut := []acctRow{}
	for _, providerID := range a.Providers.IDs() {
		active, _ := a.Accounts.Active(ctx, providerID)
		list, err := a.Accounts.List(ctx, providerID)
		if err != nil {
			continue
		}
		current, currentErr := a.Accounts.Current(ctx, providerID)
		for _, acc := range list {
			row := acctRow{
				Provider: acc.Meta.Provider, Name: acc.Meta.Name,
				Active: active == acc.Meta.Name, Identity: acc.Meta.Identity,
			}
			if currentErr == nil {
				row.Live = current.IsLiveMatch && row.Active
			}
			accountsOut = append(accountsOut, row)
		}
	}

	type proxyRow struct {
		Provider string `json:"provider"`
		Account  string `json:"account"`
		Running  bool   `json:"running"`
		Endpoint string `json:"endpoint,omitempty"`
	}
	proxiesOut := []proxyRow{}
	for _, providerID := range a.Providers.IDs() {
		list, err := a.Accounts.List(ctx, providerID)
		if err != nil {
			continue
		}
		for _, acc := range list {
			st, err := a.Proxy.StatusContext(ctx, providerID, acc.Meta.Name)
			if err != nil || !st.Running {
				continue
			}
			proxiesOut = append(proxiesOut, proxyRow{
				Provider: providerID, Account: acc.Meta.Name,
				Running: true, Endpoint: st.Endpoint,
			})
		}
	}

	return map[string]interface{}{
		"ok":       true,
		"accounts": accountsOut,
		"proxies":  proxiesOut,
	}
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
