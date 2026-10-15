// Every mutating command prints its plan and exits BEFORE taking any
// mutation lock or touching services (invariant #3): no DB writes, no file
// writes, no journal rows, no spawned processes.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/outof0/anypick/go/internal/anyerr"
)

// kv is one ordered JSON object member. Objects render by insertion order
// and nil members are dropped, so plain-nil values are omitted while
// jsonNull emits an explicit null.
type kv struct {
	Key   string
	Value any
}

// jsonNull distinguishes "present but null" from "omitted".
type jsonNull struct{}

// orderedJSON renders fields in insertion order; map[string]any would
// randomize key order across runs.
func orderedJSON(fields []kv) string {
	var b strings.Builder
	b.WriteByte('{')
	first := true
	for _, f := range fields {
		if f.Value == nil {
			continue // nil members vanish from the output
		}
		if !first {
			b.WriteByte(',')
		}
		first = false
		k, _ := json.Marshal(f.Key)
		b.Write(k)
		b.WriteByte(':')
		if _, isNull := f.Value.(jsonNull); isNull {
			b.WriteString("null")
			continue
		}
		v, err := json.Marshal(f.Value)
		if err != nil {
			v = []byte("null")
		}
		b.Write(v)
	}
	b.WriteByte('}')
	return b.String()
}

// printDryRunFields prints the dry-run plan: --json prints
// exactly one {"dryRun":true,"action":…,…} value on stdout; human mode prints
// "[dry-run] <detail>". stdout only — stderr stays free for diagnostics.
func printDryRunFields(action, detail string, fields ...kv) {
	if globals.JSON {
		cliPrintln(orderedJSON(append([]kv{{Key: "dryRun", Value: true}, {Key: "action", Value: action}}, fields...)))
		return
	}
	cliPrintf("[dry-run] %s\n", detail)
}

// strOrNil maps an unset flag to an omitted member.
func strOrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// intOrNil maps an unset numeric flag to an omitted member.
func intOrNil(n int) any {
	if n == 0 {
		return nil
	}
	return n
}

// strOrJSONNull maps "" to an explicit null member.
func strOrJSONNull(s string) any {
	if s == "" {
		return jsonNull{}
	}
	return s
}

// emitResetDryRun renders the reset dry-run result
// ({client, removedGlobal, dryRun:true}): --json prints the whole object;
// gateway reset prefixes [dry-run], plain reset describes the global binding.
func emitResetDryRun(clientID string, removedGlobal, gatewayStyle bool) {
	if globals.JSON {
		cliPrintln(orderedJSON([]kv{
			{Key: "client", Value: clientID},
			{Key: "removedGlobal", Value: removedGlobal},
			{Key: "dryRun", Value: true},
		}))
		return
	}
	if gatewayStyle {
		cliPrintf("[dry-run] reset %s\n", clientID)
		return
	}
	if removedGlobal {
		cliPrintf("Would remove global binding for %s\n", clientID)
	} else {
		cliPrintf("No global binding for %s\n", clientID)
	}
}

// errDeclined marks an interactive "n" answer: nothing happened, exit 0.
var errDeclined = errors.New("confirmation declined")

// confirmDelete guards destructive commands: --yes short-circuits;
// otherwise a non-TTY stdin/stdout refuses with CONFIRMATION_REQUIRED and
// exit code 2 WITHOUT consuming stdin, and a real TTY gets a y/N prompt.
func confirmDelete(label string, yes bool) error {
	if yes {
		return nil
	}
	if globals.NoInput || !isTTY(os.Stdin) || !isTTY(os.Stdout) {
		return anyerr.Newf(
			fmt.Sprintf("Deleting %s requires --yes in non-interactive mode.", label),
			"CONFIRMATION_REQUIRED",
			anyerr.WithExitCode(anyerr.InvalidUsage),
			anyerr.WithMutated(false))
	}
	var output = os.Stdout
	if globals.JSON {
		output = os.Stderr
	}
	cliFprintf(output, "Delete %s? [y/N] ", label)
	answer, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	answer = strings.ToLower(strings.TrimSpace(answer))
	if answer != "y" && answer != "yes" {
		if !globals.JSON {
			cliFprintln(output, "Cancelled.")
		}
		return errDeclined
	}
	return nil
}

// emitOK prints one JSON object under --json, otherwise the human line
// unless --quiet. Invariant 7: stdout stays a single JSON value in JSON mode.
func emitOK(human string, fields ...kv) {
	if globals.JSON {
		cliPrintln(orderedJSON(fields))
		return
	}
	if !globals.Quiet && human != "" {
		cliPrintln(human)
	}
}
