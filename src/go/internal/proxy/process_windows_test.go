//go:build windows

package proxy

import (
	"os/exec"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestWindowsProcessHelpersRejectInvalidPID(t *testing.T) {
	if processAlive(0) {
		t.Fatal("pid zero must never be considered alive")
	}
	if err := signalPID(0); err == nil {
		t.Fatal("pid zero must be rejected")
	}
}

func TestSignalPIDStopsVerifiedNamedJobMember(t *testing.T) {
	cmd := exec.Command("ping.exe", "-n", "30", "127.0.0.1")
	cmd.SysProcAttr = &windows.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start a Windows child process: %v", err)
	}
	defer func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}()

	name, err := proxyJobName(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	job, err := windows.CreateJobObject(nil, name)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(job)
	process, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION,
		false,
		uint32(cmd.Process.Pid),
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.AssignProcessToJobObject(job, process); err != nil {
		_ = windows.CloseHandle(process)
		t.Skipf("cannot assign child to a job object: %v", err)
	}
	_ = windows.CloseHandle(process)

	if err := signalPID(cmd.Process.Pid); err != nil {
		t.Fatalf("signalPID: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("named job member did not exit after signalPID")
	}
}

func TestSignalPIDLeavesNamedJobAloneWhenTargetIsNotAMember(t *testing.T) {
	target := exec.Command("ping.exe", "-n", "30", "127.0.0.1")
	target.SysProcAttr = &windows.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	if err := target.Start(); err != nil {
		t.Skipf("cannot start the target Windows child process: %v", err)
	}
	waited := false
	defer func() {
		if !waited {
			_ = target.Process.Kill()
			_ = target.Wait()
		}
	}()

	victim := exec.Command("ping.exe", "-n", "30", "127.0.0.1")
	victim.SysProcAttr = &windows.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	if err := victim.Start(); err != nil {
		t.Skipf("cannot start the unrelated Windows child process: %v", err)
	}
	defer func() {
		_ = victim.Process.Kill()
		_ = victim.Wait()
	}()

	name, err := proxyJobName(target.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	job, err := windows.CreateJobObject(nil, name)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(job)
	victimProcess, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION,
		false,
		uint32(victim.Process.Pid),
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.AssignProcessToJobObject(job, victimProcess); err != nil {
		_ = windows.CloseHandle(victimProcess)
		t.Skipf("cannot assign unrelated child to a job object: %v", err)
	}
	_ = windows.CloseHandle(victimProcess)

	if err := signalPID(target.Process.Pid); err != nil {
		t.Fatalf("signalPID: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- target.Wait() }()
	select {
	case <-done:
		waited = true
	case <-time.After(5 * time.Second):
		_ = target.Process.Kill()
		<-done
		waited = true
		t.Fatal("target process did not exit after signalPID")
	}
	if !processAlive(victim.Process.Pid) {
		t.Fatal("signalPID terminated a process in the target's named job instead of the target")
	}
}
