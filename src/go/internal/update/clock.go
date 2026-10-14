package update

import "time"

// Clock is injected so throttle and testing hooks stay deterministic.
type Clock interface {
	Now() time.Time
}

// RealClock uses the wall clock.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

// FixedClock always returns the same instant.
type FixedClock struct{ T time.Time }

func (c FixedClock) Now() time.Time { return c.T }

// OffsetClock returns base.Now() + Offset.
type OffsetClock struct {
	Base   Clock
	Offset time.Duration
}

func (c OffsetClock) Now() time.Time {
	base := c.Base
	if base == nil {
		base = RealClock{}
	}
	return base.Now().Add(c.Offset)
}
