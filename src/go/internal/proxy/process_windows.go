//go:build windows

package proxy

import (
	"fmt"
	"os"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
)

func ownPID() int { return os.Getpid() }

func proxyJobName(pid int) (*uint16, error) {
	return windows.UTF16PtrFromString("AnyPick-PID-" + strconv.Itoa(pid))
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	status, err := windows.WaitForSingleObject(handle, 0)
	return err == nil && status == uint32(windows.WAIT_TIMEOUT)
}

func signalPID(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("no pid")
	}
	name, err := proxyJobName(pid)
	if err != nil {
		return err
	}
	job, jobErr := windows.CreateJobObject(nil, name)
	if jobErr == nil {
		contains, queryErr := proxyJobContainsPID(job, pid)
		if queryErr == nil && contains {
			termErr := windows.TerminateJobObject(job, 1)
			_ = windows.CloseHandle(job)
			if termErr == nil || !processAlive(pid) {
				// StopProxy waits for the matching health instance to disappear.
				// Returning here avoids racing the job's process teardown with a
				// second TerminateProcess call, which can report ERROR_ACCESS_DENIED
				// after the job has already started exiting.
				return nil
			}
		} else {
			_ = windows.CloseHandle(job)
		}
	}
	// Terminate the recorded main process as well. The caller has already
	// verified its per-instance /health echo. A missing or empty named job is
	// not evidence of ownership, so the verified PID remains the fallback.
	process, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		if !processAlive(pid) {
			return nil
		}
		return err
	}
	defer windows.CloseHandle(process)
	if err := windows.TerminateProcess(process, 1); err != nil && processAlive(pid) {
		return err
	}
	return nil
}

type proxyJobPIDListHeader struct {
	NumberOfAssignedProcesses uint32
	NumberOfProcessIDsInList  uint32
}

func proxyJobContainsPID(job windows.Handle, pid int) (bool, error) {
	const capIDs = 4096
	buf := make([]byte, int(unsafe.Sizeof(proxyJobPIDListHeader{}))+capIDs*int(unsafe.Sizeof(uintptr(0))))
	if err := windows.QueryInformationJobObject(
		job,
		windows.JobObjectBasicProcessIdList,
		uintptr(unsafe.Pointer(&buf[0])),
		uint32(len(buf)),
		nil,
	); err != nil {
		return false, err
	}
	header := (*proxyJobPIDListHeader)(unsafe.Pointer(&buf[0]))
	assigned := header.NumberOfAssignedProcesses
	listed := header.NumberOfProcessIDsInList
	if assigned > capIDs || listed > capIDs || listed > assigned {
		return false, fmt.Errorf("job process list truncated: assigned %d listed %d", assigned, listed)
	}
	if listed == 0 {
		return false, nil
	}
	ids := unsafe.Slice((*uintptr)(unsafe.Add(unsafe.Pointer(&buf[0]), unsafe.Sizeof(proxyJobPIDListHeader{}))), listed)
	want := uintptr(pid)
	for _, id := range ids {
		if id == want {
			return true, nil
		}
	}
	return false, nil
}
