//go:build !windows

package browserlogin

import (
	"os/exec"
	"strings"
	"syscall"
)

func isHomeEnvironment(entry string) bool     { return strings.HasPrefix(entry, "HOME=") }
func platformHomeEnvironment(string) []string { return nil }

type unixChildController struct {
	child *exec.Cmd
}

func executableNames(name string) []string { return []string{name} }

func accessibleExecutable(path string) bool {
	const xOK = 0x1
	return syscall.Access(path, xOK) == nil
}

func startIsolatedChild(child *exec.Cmd) (childController, error) {
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := child.Start(); err != nil {
		return nil, err
	}
	return &unixChildController{child: child}, nil
}

func (c *unixChildController) terminate() {
	if c.child.Process == nil {
		return
	}
	_ = syscall.Kill(-c.child.Process.Pid, syscall.SIGTERM)
	_ = c.child.Process.Signal(syscall.SIGTERM)
}

func (c *unixChildController) kill() {
	if c.child.Process == nil {
		return
	}
	_ = syscall.Kill(-c.child.Process.Pid, syscall.SIGKILL)
	_ = c.child.Process.Kill()
}

func (c *unixChildController) close() {}

func processWasSignaled(exitErr *exec.ExitError) bool {
	status, ok := exitErr.Sys().(syscall.WaitStatus)
	return ok && status.Signaled()
}
