// SPDX-License-Identifier: GPL-3.0-only
package posttor

import (
	"syscall"
	"time"
	"unsafe"
)

// CLOCK_BOOTTIME includes suspend and cannot be changed by setting wall time.
// No syscall here sets a clock. Linux is the only supported host.
func bootNow() (time.Duration, error) {
	var value syscall.Timespec
	_, _, errno := syscall.RawSyscall(syscall.SYS_CLOCK_GETTIME, 7, uintptr(unsafe.Pointer(&value)), 0)
	if errno != 0 {
		return 0, errno
	}
	return time.Duration(value.Nano()), nil
}
