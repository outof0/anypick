// Package lock provides advisory flock with in-process serialization and
// scoped, sorted, re-entrant coordinator locks (ADR 0009).
package lock

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
	"github.com/outof0/anypick/go/internal/paths"
)

const (
	defaultTimeout = 5 * time.Second
	pollInterval   = 25 * time.Millisecond
)

// Per-path in-process serialization so concurrent goroutines queue in order;
// flock then arbitrates across processes. Different paths never block each other.
var pathMutexes sync.Map

func pathMutex(path string) *sync.Mutex {
	m, _ := pathMutexes.LoadOrStore(path, &sync.Mutex{})
	return m.(*sync.Mutex)
}

// FileLock is an advisory exclusive lock on one file. The lock file persists
// after release (no unlink ⇒ no ABA split).
type FileLock struct {
	path     string
	platform platformFileLock
	mu       *sync.Mutex
	released bool
}

type platformFileLock interface {
	release() error
}

// AcquireFileLock blocks up to timeout acquiring LOCK_EX|LOCK_NB.
// A timeout of 0 tries once without waiting (fail immediately); negative
// means the default (5s). WithMutationLocks translates 0 → default so
// existing callers keep the 5s default — only direct AcquireFileLock callers
// can opt into try-lock with 0.
func AcquireFileLock(path string, timeout time.Duration) (*FileLock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, anyerr.Wrapf(err, "create lock dir", "FS_PATH")
	}
	if timeout < 0 {
		timeout = defaultTimeout
	}
	mu := pathMutex(path)
	// Wait for the in-process mutex with the SAME budget as the flock. Two
	// reasons this matters:
	//
	//   1. The contract above promises "blocks up to timeout"; an unbounded
	//      mu.Lock() silently broke that promise, so a contended path could
	//      hang for the whole test timeout instead of failing.
	//   2. Re-entrancy is carried in the context. A caller that holds the lock
	//      in one context and reaches this function through a fresh
	//      context.Background() cannot be distinguished from a different
	//      goroutine, so it blocks on the mutex it already owns — a deadlock
	//      with no error and no stack that names the cause. Failing after the
	//      timeout turns that into a diagnosable error.
	// A zero timeout means "try once" for the flock, but the in-process mutex
	// is the queue that makes concurrent callers serialize rather than fail.
	// `app.Ready` relies on that for .migrate.lock, so the mutex always gets a
	// real budget; the flock still honours the caller's try-once request.
	mutexBudget := timeout
	if mutexBudget <= 0 {
		mutexBudget = defaultTimeout
	}
	deadline := time.Now().Add(mutexBudget)
	for !mu.TryLock() {
		if !time.Now().Before(deadline) {
			return nil, anyerr.Newf(
				"timed out acquiring the mutation lock for "+path+": it is held by "+
					"another operation in this process. If this call should re-enter a "+
					"lock the caller already holds, the holding context must be passed "+
					"down — re-entrancy is carried in the context (ADR 0009)",
				"MUTATION_LOCK_TIMEOUT")
		}
		time.Sleep(pollInterval)
	}

	platform, err := acquirePlatformFileLock(path, timeout)
	if err != nil {
		mu.Unlock()
		return nil, err
	}
	return &FileLock{path: path, platform: platform, mu: mu}, nil
}

func (l *FileLock) Release() error {
	if l == nil || l.released {
		return nil
	}
	l.released = true // idempotent: double release must not unlock the mutex twice
	err := l.platform.release()
	l.mu.Unlock()
	return err
}

// MutationLockPath resolves a scope to a lock file path. Scope sanitization
// is lossy, which is exactly why held-lock identity is the resolved path.
func MutationLockPath(root, scope string) string {
	var b strings.Builder
	for _, r := range scope {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '.', r == '_', r == '@', r == '/', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	safe := strings.ReplaceAll(b.String(), "/", "__")
	return filepath.Join(paths.LocksDir(paths.Root(root)), safe+".lock")
}

type heldKey struct{}

type afterMutationKey struct{}
type afterMutationQueue struct {
	mu        sync.Mutex
	callbacks []func(context.Context) error
}

// AfterMutation runs derived work after the outermost coordinator releases its
// locks. Acquiring profile locks while a caller still holds a provider lock
// reverses the global acquisition order (ADR 0009).
func AfterMutation(ctx context.Context, fn func(context.Context) error) error {
	if queue, ok := ctx.Value(afterMutationKey{}).(*afterMutationQueue); ok {
		queue.mu.Lock()
		queue.callbacks = append(queue.callbacks, fn)
		queue.mu.Unlock()
		return nil
	}
	return fn(ctx)
}

// HeldLocks returns the resolved lock paths held by ctx.
func HeldLocks(ctx context.Context) map[string]bool {
	if held, ok := ctx.Value(heldKey{}).(map[string]bool); ok {
		return held
	}
	return map[string]bool{}
}

// Holds reports whether ctx already holds scope.
func Holds(ctx context.Context, root, scope string) bool {
	return HeldLocks(ctx)[MutationLockPath(root, scope)]
}

// Require reports an error when ctx does not hold the mutation lock for
// scope. ADR 0009 (CONC-01) promises that correctness never depends on the
// caller locking, but WithMutationLocks is opt-in at the call site: a store
// that mutates outside the coordinator keeps working and simply loses the
// serialization guarantee, which surfaces months later as a rare,
// unreproducible corruption. Stores call Require (or better, self-lock) so the
// mistake is an error instead of a lottery.
func Require(ctx context.Context, root, scope string) error {
	if Holds(ctx, root, scope) {
		return nil
	}
	return anyerr.Newf(
		"mutation lock "+scope+" is not held: wrap this call in lock.WithMutationLock (ADR 0009)",
		"MUTATION_LOCK_NOT_HELD")
}

// WithMutationLock runs fn under one scoped exclusive lock.
func WithMutationLock(ctx context.Context, root, scope string, fn func(ctx context.Context) error) error {
	return WithMutationLocks(ctx, root, []string{scope}, fn, 0)
}

// WithMutationLocks runs fn under scoped exclusive locks: scopes are
// de-duplicated and acquired in sorted order (deadlock freedom across
// overlapping mutations); scopes already held by this context are skipped
// instead of re-acquired. Re-entrancy uses explicit context propagation —
// nested service calls receive the enriched ctx.
// A timeout of 0 means the default (5s); pass -1 or AcquireFileLock(…,0)
// directly for try-lock.
func WithMutationLocks(ctx context.Context, root string, scopes []string, fn func(context.Context) error, timeout time.Duration) (result error) {
	if _, nested := ctx.Value(afterMutationKey{}).(*afterMutationQueue); !nested {
		outer := ctx
		queue := &afterMutationQueue{}
		ctx = context.WithValue(ctx, afterMutationKey{}, queue)
		// Registered before releaseAll's defer, so derived work runs unlocked.
		defer func() {
			queue.mu.Lock()
			callbacks := append([]func(context.Context) error(nil), queue.callbacks...)
			queue.mu.Unlock()
			for _, callback := range callbacks {
				result = errors.Join(result, callback(outer))
			}
		}()
	}
	if timeout == 0 {
		timeout = defaultTimeout
	}
	held := HeldLocks(ctx)

	unique := make(map[string]bool, len(scopes))
	for _, s := range scopes {
		unique[s] = true
	}
	ordered := make([]string, 0, len(unique))
	for s := range unique {
		ordered = append(ordered, s)
	}
	sort.Strings(ordered)

	type pendingLock struct{ scope, path string }
	var pending []pendingLock
	nextHeld := make(map[string]bool, len(held)+len(ordered))
	for p := range held {
		nextHeld[p] = true
	}
	for _, scope := range ordered {
		path := MutationLockPath(root, scope)
		if !held[path] && !nextHeld[path] {
			pending = append(pending, pendingLock{scope, path})
			nextHeld[path] = true // dedupe scopes that sanitize to one file
		}
	}

	if len(pending) == 0 {
		// Every scope is held: publish the set so nested calls re-enter.
		return fn(context.WithValue(ctx, heldKey{}, nextHeld))
	}

	var releaseAll []*FileLock
	defer func() {
		for i := len(releaseAll) - 1; i >= 0; i-- {
			_ = releaseAll[i].Release()
		}
	}()
	for _, pl := range pending {
		fl, err := AcquireFileLock(pl.path, timeout)
		if err != nil {
			return err
		}
		releaseAll = append(releaseAll, fl)
	}
	return fn(context.WithValue(ctx, heldKey{}, nextHeld))
}
