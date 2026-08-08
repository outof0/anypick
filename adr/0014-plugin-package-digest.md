# ADR-0014: Plugin trust pins the whole package, not only the entry module (EXT-02)

- Status: accepted (amends [0012](0012-plugin-trust-boundary.md))
- Date: 2026-08-04

## Context

ADR-0012 pinned a SHA-256 of the plugin **entry module** only, and explicitly
rejected hashing the whole tree because READMEs and lockfiles would force
reflexive `trust`. That trade-off left a hole: an enabled plugin can import a
helper next to `main`, and that helper can change without invalidating the pin.
Once `import()` runs, top-level code in helpers has already executed in a process
that holds credential file handles — verifying only `main` is not enough.

In practice plugins are small, purpose-built directories. The cost of re-trusting
after a legitimate edit is already accepted (every rebuild needs `trust`). The
cost of a silent helper change is credential theft.

## Decision

1. **`digestPluginPackage(root)` is the trust pin.** It walks the plugin root,
   skips VCS/dev dirs (`.git`, `node_modules`, …), sorts relative POSIX paths,
   and hashes `path\\0len\\0bytes` for each file into SHA-256. Manifest and every
   shipped file contribute; `main` alone does not.
2. **`add`, `trust`, and the loader all use the package digest.** The loader
   still verifies *before* `import()`; mismatch yields `PLUGIN_UNTRUSTED` with
   the same recovery path (`plugin trust` / `plugin remove`).
3. **`digestEntry` remains for diagnostics only.** It is not a trust boundary.
4. **Unrelated-file friction is accepted.** A README edit invalidates trust. That
   is cheaper than a helper-module bypass, and the UX already trains users that
   `trust` is the deliberate re-approval step.

## Consequences

- SECURITY.md, CONTRIBUTING, and the plugins guide describe a package digest.
- A regression test must prove that changing a non-entry helper refuses load.
- ADR-0012's rejected alternative "pinning a digest of the whole plugin tree" is
  superseded for the security reason above; the rest of 0012 still stands.

## Rejected alternatives

- **Hash entry + static import graph only.** Incomplete for dynamic `import()` and
  data files read at activate time; graph analysis is fragile across bundlers.
- **Allowlist of hashed paths in the manifest.** Extra author burden and an easy
  way to forget a helper.
