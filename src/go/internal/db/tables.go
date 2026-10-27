package db

// TableOwners records which package owns the SQL for each table.
//
// The invariant in AGENTS.md used to read "stores own SQL; services never
// embed it", which is not what the code does: persistence lives in one
// package per group of tables (internal/store, internal/journal,
// internal/pools, internal/hub, internal/presets, internal/bindings,
// internal/profile, internal/plugins, internal/modelcache), not in a single
// store package. That is a defensible design — each owner is small and
// cohesive — but the rule as written was untrue, and an untrue rule is
// enforced by nobody.
//
// So the invariant is stated as it actually is: **every table has exactly one
// owning package.** TestTableOwnershipIsDeclaredAndRespected in this package
// reads this map and fails the build when a package reaches into a table it
// does not own, or when a new table appears without an owner.
//
// Adding a table means adding it here in the same change. Adding an entry to
// SharedWith must come with a reason: two packages writing one table is how
// invariants start leaking.
//
// A table is also removed here in the same change that drops it from the
// baseline schema. `client_state` was such a table: it shipped, was declared
// owned by internal/client, and nothing read or wrote it. The baseline no
// longer creates it, so a fresh database never has it, but no migration drops
// it either — an existing ~/.anypick keeps the empty table rather than having
// its data deleted by a release. An inert table costs nothing; an irreversible
// migration on someone's machine costs the project's trust.
type TableOwner struct {
	// Package is the owning package, as an import path relative to src/go.
	Package string
	// SharedWith lists packages that also write this table, each with the
	// reason it is acceptable. Empty is the goal.
	SharedWith map[string]string
	// External marks a table that is not part of AnyPick's own schema — one
	// belonging to a client AnyPick writes credentials for.
	External bool
}

// TableOwners is the registry. Keep it sorted by table name.
var TableOwners = map[string]TableOwner{
	"account_snapshot_files": {Package: "internal/store"},
	"accounts":               {Package: "internal/store"},
	"client_profiles":        {Package: "internal/client"},
	"config": {
		Package: "internal/config",
		SharedWith: map[string]string{
			// internal/hub reads the global config row to resolve quota-guard
			// settings for its routes, and provisions its own HMAC key row
			// (INSERT ... ON CONFLICT DO NOTHING on its namespaced key).
			// All other config writes stay in internal/config.
			"internal/hub": "reads global config; writes only its own HMAC key row",
		},
	},
	"global_bindings":      {Package: "internal/bindings"},
	"meta":                 {Package: "internal/store"},
	"model_catalog_cache":  {Package: "internal/modelcache"},
	"operation_journal":    {Package: "internal/journal"},
	"plugins":              {Package: "internal/plugins"},
	"pools":                {Package: "internal/pools"},
	"presets":              {Package: "internal/presets"},
	"profiles":             {Package: "internal/profile"},
	"project_bindings":     {Package: "internal/bindings"},
	"provider_active":      {Package: "internal/store"},
	"provider_model_roles": {Package: "internal/bindings"},
	"proxy_hub_routes":     {Package: "internal/hub"},
	"proxy_hub_runtime":    {Package: "internal/hub"},
	"proxy_hub_sources":    {Package: "internal/hub"},
	"proxy_hubs":           {Package: "internal/hub"},
	"proxy_leases": {
		Package: "internal/proxy",
		SharedWith: map[string]string{
			// internal/store deletes an account's leases together with its
			// proxy_state row, in one transaction, as the atomic commit point
			// for verified-dead cleanup. Splitting it across a service would
			// reintroduce the partial-failure window ADR 0004 closed.
			"internal/store": "deletes leases with proxy_state in one transaction (ADR 0004)",
		},
	},
	"proxy_state":    {Package: "internal/store"},
	"source_resumes": {Package: "internal/bindings"},
	"usage_events":   {Package: "internal/usagelog"},

	// These are not AnyPick's schema. They are the credential stores of the
	// clients AnyPick integrates with, and internal/provider reads and writes
	// them because that is the integration.
	"auth_kv":     {Package: "internal/provider", External: true},
	"credential":  {Package: "internal/provider", External: true},
	"integration": {Package: "internal/provider", External: true},
	// ItemTable is the VS Code global-state table inside Antigravity's
	// state.vscdb, where the IDE keeps its signed-in Google OAuth token.
	// AnyPick never created it and never writes it: the reader opens it
	// through db.OpenForeign(path, true), which is read-only and
	// query_only, precisely so a discovery pass cannot disturb a running
	// IDE. It is declared here only so the ownership gate can see it.
	"itemtable": {Package: "internal/provider", External: true},
}
