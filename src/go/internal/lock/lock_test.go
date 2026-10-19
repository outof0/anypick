package lock

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/outof0/anypick/go/internal/refs"
)

func TestMutationLockPathSanitization(t *testing.T) {
	root := t.TempDir()
	got := MutationLockPath(root, "provider/grok")
	if filepath.Base(got) != "provider__grok.lock" {
		t.Errorf("sanitized = %q", got)
	}
	// Lossy sanitization: two scopes can map to one file — held identity must
	// be the resolved path, not the scope string.
	a := MutationLockPath(root, "client/a:b")
	b := MutationLockPath(root, "client/a_b")
	if a != b {
		t.Errorf("expected lossy collision, %q vs %q", a, b)
	}
}

// Re-entrancy: a nested acquisition of the same scope must re-enter instead of
// self-deadlocking (ADR 0009).
func TestReentrantNestedLocks(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()
	scope := refs.ProviderScope("grok")

	done := make(chan error, 1)
	go func() {
		done <- WithMutationLock(ctx, root, scope, func(inner context.Context) error {
			return WithMutationLock(inner, root, scope, func(mostInner context.Context) error {
				if !Holds(mostInner, root, scope) {
					t.Error("innermost context does not report holding the lock")
				}
				return nil
			})
		})
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("nested WithMutationLock: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("deadlock: nested acquisition did not re-enter")
	}
}

// Sorted multi-scope acquisition: two goroutines taking overlapping scope sets
// in different orders must not deadlock.
func TestSortedAcquisitionNoDeadlock(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()
	sA := "aaa"
	sB := "bbb"

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		errs <- WithMutationLocks(ctx, root, []string{sB, sA}, func(c context.Context) error { return nil }, time.Second)
	}()
	go func() {
		defer wg.Done()
		errs <- WithMutationLocks(ctx, root, []string{sA, sB}, func(c context.Context) error { return nil }, time.Second)
	}()
	wg.Wait()
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("overlapping acquisition failed: %v", err)
		}
	}
}

// Cross-goroutine exclusion: a second holder must wait until release.
func TestExclusiveAcrossGoroutines(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()
	scope := "solo"

	inside := make(chan chan struct{}, 1)
	errs := make(chan error, 1)
	go func() {
		errs <- WithMutationLock(ctx, root, scope, func(c context.Context) error {
			release := make(chan struct{})
			inside <- release
			<-release
			return nil
		})
	}()

	release := <-inside

	acquired := make(chan error, 1)
	go func() {
		acquired <- WithMutationLock(ctx, root, scope, func(c context.Context) error { return nil })
	}()

	select {
	case err := <-acquired:
		t.Fatalf("second holder entered while first still holds: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	close(release)
	if err := <-acquired; err != nil {
		t.Fatalf("second holder failed after release: %v", err)
	}
	if err := <-errs; err != nil {
		t.Fatalf("first holder failed: %v", err)
	}
}

func TestHeldContextNotLeakedToParent(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()
	_ = WithMutationLock(ctx, root, "x", func(inner context.Context) error {
		if !Holds(inner, root, "x") {
			t.Fatal("inner should hold x")
		}
		return nil
	})
	if Holds(ctx, root, "x") {
		t.Fatal("parent context must not observe the released lock")
	}
}

func TestAfterMutationAvoidsProviderProfileLockInversion(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()
	profileScope, providerScope := "client-profile/codex/work", refs.ProviderScope("codex")
	profileHeld, providerHeld := make(chan struct{}), make(chan struct{})
	competitor := make(chan error, 1)
	go func() {
		competitor <- WithMutationLocks(ctx, root, []string{profileScope}, func(c context.Context) error {
			close(profileHeld)
			<-providerHeld
			return WithMutationLocks(c, root, []string{providerScope}, func(context.Context) error { return nil }, time.Second)
		}, time.Second)
	}()
	<-profileHeld
	err := WithMutationLocks(ctx, root, []string{providerScope}, func(c context.Context) error {
		close(providerHeld)
		return AfterMutation(c, func(unlocked context.Context) error {
			return WithMutationLocks(unlocked, root, []string{profileScope, providerScope}, func(context.Context) error { return nil }, time.Second)
		})
	}, time.Second)
	if err != nil {
		t.Errorf("derived profile update: %v", err)
	}
	if err := <-competitor; err != nil {
		t.Errorf("concurrent profile activation: %v", err)
	}
}

func TestAfterMutationNestedCallbacksRunUnlockedAndJoinErrors(t *testing.T) {
	root := t.TempDir()
	mutationErr, firstErr, secondErr := errors.New("mutation"), errors.New("first refresh"), errors.New("second refresh")
	var calls []string
	err := WithMutationLock(context.Background(), root, "provider/codex", func(c context.Context) error {
		if err := WithMutationLock(c, root, "provider/codex", func(nested context.Context) error {
			return AfterMutation(nested, func(unlocked context.Context) error {
				if len(HeldLocks(unlocked)) != 0 {
					t.Error("callback retained enclosing locks")
				}
				calls = append(calls, "first")
				return firstErr
			})
		}); err != nil {
			return err
		}
		if len(calls) != 0 {
			t.Error("nested mutation drained the outer callback queue")
		}
		if err := AfterMutation(c, func(context.Context) error {
			calls = append(calls, "second")
			return secondErr
		}); err != nil {
			return err
		}
		return mutationErr
	})
	for _, want := range []error{mutationErr, firstErr, secondErr} {
		if !errors.Is(err, want) {
			t.Errorf("result %v lost error %v", err, want)
		}
	}
	if len(calls) != 2 || calls[0] != "first" || calls[1] != "second" {
		t.Errorf("callback order = %v", calls)
	}
}
