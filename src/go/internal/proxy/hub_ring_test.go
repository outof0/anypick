package proxy

import (
	"context"
	"testing"

	"github.com/outof0/anypick/go/internal/config"
)

// A hub pool source keeps one ring between requests, so its round-robin
// position advances. It used to be rebuilt per request and always started at
// the first member.
func TestHubPoolRingIsReusedUntilThePoolChanges(t *testing.T) {
	database, err := openPoolTestDB(t)
	if err != nil {
		t.Fatal(err)
	}
	svc := newPoolTestService(t, database, mapResolver{})
	defer svc.Close()
	ctx := context.Background()
	first, err := svc.HubPoolRing(ctx, "deepseek")
	if err != nil {
		t.Fatal(err)
	}
	again, err := svc.HubPoolRing(ctx, "deepseek")
	if err != nil {
		t.Fatal(err)
	}
	if first != again {
		t.Fatal("the hub ring was rebuilt for an unchanged pool")
	}
	pool, err := svc.Pools.GetContext(ctx, "deepseek")
	if err != nil {
		t.Fatal(err)
	}
	pool.Strategy = "round-robin"
	if err := svc.Pools.Set(ctx, *pool); err != nil {
		t.Fatal(err)
	}
	changed, err := svc.HubPoolRing(ctx, "deepseek")
	if err != nil {
		t.Fatal(err)
	}
	if changed == first || changed.Strategy != "round-robin" {
		t.Fatal("a changed pool kept serving through the old ring")
	}
}

// A changed quota-guard policy reaches the next hub request. The pools are
// restarted on a policy change, but a hub keeps its rings; without the policy
// in the cache key the old cooldown kept applying until the hub restarted.
func TestHubPoolRingFollowsAQuotaGuardChange(t *testing.T) {
	database, err := openPoolTestDB(t)
	if err != nil {
		t.Fatal(err)
	}
	svc := newPoolTestService(t, database, mapResolver{})
	defer svc.Close()
	policy := config.QuotaGuardPolicy{Enabled: true, CooldownMinutes: 30}
	svc.QuotaGuardPolicy = func(context.Context) config.QuotaGuardPolicy { return policy }
	ctx := context.Background()
	first, err := svc.HubPoolRing(ctx, "deepseek")
	if err != nil {
		t.Fatal(err)
	}
	policy.CooldownMinutes = 5
	changed, err := svc.HubPoolRing(ctx, "deepseek")
	if err != nil {
		t.Fatal(err)
	}
	if changed == first {
		t.Fatal("the hub ring kept the guard built under the previous policy")
	}
}
