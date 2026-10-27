package proxy

import (
	"testing"

	"github.com/outof0/anypick/go/internal/testgate"
)

// TestMutatingMethodsTakeContext enforces the deadlock-trap invariant: every
// persisted mutation takes ctx as its first argument and has no ctx-less form.
// A wrapper that starts from context.Background() cannot see a coordinator
// lock its caller holds, so it re-acquires and waits out the lock budget.
// Reads (Get/List*) keep their ctx-less form for source compatibility, not
// because every read is lock-free: a store read that re-materializes a snapshot
// takes the provider lock, and a display path must use the cached read instead
// (AGENTS.md, the ctx-less mutation trap).
func TestMutatingMethodsTakeContext(t *testing.T) {
	testgate.CheckNoCtxlessMutations(t, ".", map[string]string{
		// http.ResponseWriter fixes these signatures. Each entry names the one
		// type it exempts, because the key is Type.Method: a bare method name
		// would exempt Write and WriteHeader on every type in this package,
		// which is how a comment came to name four implementations while the
		// code exempted all of them. A new type that streams a response adds
		// its own line here, and having to is the point.
		//
		// The heartbeat and reap trio is named with its reasons in
		// unguardedLeaseMutations (coordinator_test.go), which is scoped to
		// LeaseStore rather than allowlisted here.
		"StatusRecorder.WriteHeader": "http.ResponseWriter implementation; writes a response status, not persisted state",
		"captureWriter.Write":        "http.ResponseWriter implementation; writes a response body, not persisted state",
		"captureWriter.WriteHeader":  "http.ResponseWriter implementation; writes a response status, not persisted state",
		"degenerateTap.Write":        "http.ResponseWriter implementation; writes a response body, not persisted state",
		"degenerateTap.WriteHeader":  "http.ResponseWriter implementation; writes a response status, not persisted state",
		"logWriterFunc.Write":        "http.ResponseWriter implementation; writes a response body, not persisted state",
		"usageMeter.Write":           "http.ResponseWriter implementation; passes a response body through, not persisted state",
		"usageMeter.WriteHeader":     "http.ResponseWriter implementation; passes a response status through, not persisted state",
	})
}
