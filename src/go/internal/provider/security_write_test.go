package provider

import (
	"encoding/hex"
	"errors"
	"strings"
	"testing"
)

func TestClaudeKeychainEncodingDoesNotMoveASecretOntoArgv(t *testing.T) {
	const account = "test-user"
	raw := `{"claudeAiOauth":{"accessToken":"test-token"},"fixture":"` + strings.Repeat("é", 650) + `"}`
	pretty := raw[:1] + "\n  " + raw[1:]
	for _, tc := range []struct {
		name, credential, original string
	}{
		{"plain text", raw, raw},
		{"hex of multiline JSON", pretty, hex.EncodeToString([]byte(pretty))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if !legacyClaudeCredentialFitsStdin(account, tc.original) {
				t.Fatal("test credential did not fit the legacy stdin buffer")
			}
			stdin, args, err := claudeKeychainWriteInvocation(account, tc.credential, tc.original)
			if err == nil || stdin != "" || args != nil {
				t.Fatal("encoding should refuse the write before moving the credential onto argv")
			}
		})
	}
}

func TestDarwinAddGenericPasswordUsesStdinPasswordWhenItFits(t *testing.T) {
	stdin, args := darwinAddGenericInvocation("Claude Code-credentials", "erik", "short-secret\n")
	if args != nil {
		t.Fatalf("short secret took argv: %v", args)
	}
	if len(stdin) > securityStdinLimit {
		t.Fatalf("stdin is %d bytes, limit %d", len(stdin), securityStdinLimit)
	}
	if strings.Contains(stdin, " -X ") {
		t.Fatalf("stdin used -X: %s", stdin)
	}
	if !strings.Contains(stdin, "-s 'Claude Code-credentials'") {
		t.Fatalf("service with a space was not quoted: %s", stdin)
	}
	if !strings.Contains(stdin, " -w ") {
		t.Fatalf("stdin is not a -w write: %s", stdin)
	}
}

func TestDarwinAddGenericPasswordUsesArgvWhenStdinWouldTruncate(t *testing.T) {
	value := strings.Repeat("A", securityStdinLimit)
	stdin, args := darwinAddGenericInvocation("Claude Code-credentials", "erik", value)
	if stdin != "" {
		t.Fatalf("oversized value stayed on stdin (%d bytes)", len(stdin))
	}
	if len(args) < 2 || args[len(args)-2] != "-X" {
		t.Fatalf("argv = %v, want a trailing -X", args)
	}
	decoded, err := hex.DecodeString(args[len(args)-1])
	if err != nil || string(decoded) != value {
		t.Fatalf("argv hex did not round-trip the full secret: %v len=%d", err, len(decoded))
	}
	for _, arg := range args[:len(args)-1] {
		if strings.Contains(arg, value[:24]) {
			t.Fatal("plaintext secret leaked into argv")
		}
	}
}

func TestDarwinAddGenericPasswordKeepsATrailingNewlineOnStdin(t *testing.T) {
	value := "{\"claudeAiOauth\":{}}\n"
	stdin, args := darwinAddGenericInvocation("Claude Code-credentials", "erik", value)
	if args != nil {
		t.Fatalf("trailing newline took argv: %v", args)
	}
	if !strings.Contains(stdin, "-w ") {
		t.Fatalf("stdin is not a -w write: %s", stdin)
	}
}

func TestDarwinAddGenericPasswordUsesArgvWhenPasswordHasApostrophe(t *testing.T) {
	value := "o'brien\n"
	stdin, args := darwinAddGenericInvocation("Claude Code-credentials", "erik", value)
	if stdin != "" {
		t.Fatalf("apostrophe stayed on stdin: %s", stdin)
	}
	if len(args) < 2 || args[len(args)-2] != "-X" {
		t.Fatalf("argv = %v, want a trailing -X", args)
	}
	decoded, err := hex.DecodeString(args[len(args)-1])
	if err != nil || string(decoded) != "o'brien" {
		t.Fatalf("argv hex = %q, want the password without the trailing newline security would drop: %v", decoded, err)
	}
}

func TestDarwinAddGenericPasswordUsesArgvWhenPasswordHasEmbeddedNewline(t *testing.T) {
	value := "line1\nline2\n"
	stdin, args := darwinAddGenericInvocation("Claude Code-credentials", "erik", value)
	if stdin != "" {
		t.Fatalf("embedded newline stayed on stdin: %s", stdin)
	}
	decoded, err := hex.DecodeString(args[len(args)-1])
	if err != nil || string(decoded) != value {
		t.Fatalf("argv hex did not round-trip: %v %q", err, decoded)
	}
}

func TestSecurityFailureHidesKeychainItemBody(t *testing.T) {
	err := securityFailure(
		errors.New("security reported a keychain error"),
		[]byte("SecKeychainItemCreateFromContent (o'brien): The specified item already exists. returned -25299"))
	if strings.Contains(err.Error(), "brien") || strings.Contains(err.Error(), "o'") {
		t.Fatalf("keychain item body leaked into error: %v", err)
	}
	if !strings.Contains(err.Error(), "refused") {
		t.Fatalf("error = %v, want the refusal reason", err)
	}
}
