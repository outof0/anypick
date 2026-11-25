package provider

import (
	"encoding/hex"
	"fmt"
	"strings"
)

// quoteSecurityCommand quotes one token for a `security -i` line. Claude's
// service name contains spaces. An unquoted space splits the command, and
// the password then lands in the wrong argument.
func quoteSecurityCommand(arg string) string {
	if arg != "" && !strings.ContainsAny(arg, " \t\r\n'\"\\$`!#&|;<>(){}[]*?") {
		return arg
	}
	return "'" + strings.ReplaceAll(arg, "'", `'\''`) + "'"
}

// stdinPasswordUnsafe reports a password that must not be quoted onto a
// security -i line. That parser is not a shell: an apostrophe makes
// add-generic-password exit 0 while leaving the previous item unchanged.
// An embedded CR or LF splits the line. A single trailing newline is
// Claude's credential terminator and stays on stdin.
func stdinPasswordUnsafe(value string) bool {
	body := strings.TrimSuffix(value, "\n")
	return strings.ContainsAny(body, "'\r\n")
}

func darwinAddGenericArgv(service, account, value string) []string {
	return []string{
		"add-generic-password", "-U",
		"-s", service,
		"-a", account,
		"-X", hex.EncodeToString([]byte(value)),
	}
}

// argvPassword is the bytes -X should store. security's stdin writer drops
// one trailing newline, and find-generic-password -w prints a password that
// still contains one as hex. Claude then reads that hex back as the
// credential. A body that itself contains a newline cannot take the stdin
// path, so those bytes stay intact.
func argvPassword(value string) string {
	trimmed := strings.TrimSuffix(value, "\n")
	if trimmed == value || strings.ContainsAny(trimmed, "\r\n") {
		return value
	}
	return trimmed
}

// darwinAddGenericInvocation chooses how to pass value to
// add-generic-password. stdin is the go-keyring -w command when it fits in
// security's 4096-byte line and the password is safe for that parser. Past
// that, args is the argv form. Hex -X on stdin truncates the item and
// security still replaces it, so a rollback that uses the same channel
// corrupts the previous login too.
func darwinAddGenericInvocation(service, account, value string) (stdin string, args []string) {
	if stdinPasswordUnsafe(value) {
		return "", darwinAddGenericArgv(service, account, argvPassword(value))
	}
	command := fmt.Sprintf(
		"add-generic-password -U -s %s -a %s -w %s\n",
		quoteSecurityCommand(service),
		quoteSecurityCommand(account),
		quoteSecurityCommand(value))
	if len(command) <= securityStdinLimit {
		return command, nil
	}
	return "", darwinAddGenericArgv(service, account, value)
}

func writeGenericPassword(service, account, value string) error {
	stdin, args := darwinAddGenericInvocation(service, account, value)
	return runGenericPasswordWrite(stdin, args)
}

func runGenericPasswordWrite(stdin string, args []string) error {
	if stdin != "" {
		return runSecurityStdin(stdin)
	}
	return runSecurityArgs(args)
}
