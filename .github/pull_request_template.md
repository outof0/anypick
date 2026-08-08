<!--
Keep PRs focused: one logical change per PR (see CONTRIBUTING.md).
-->

## What and why

<!-- What changes, and what problem it solves. Link an issue if there is one. -->

## Checklist

- [ ] `pnpm check` passes locally (format + lint + typecheck + test)
- [ ] Tests added or updated for behavior changes
- [ ] Commit subjects follow Conventional Commits — they are what the release
      notes are generated from (see CONTRIBUTING.md)
- [ ] Docs updated under `docs/src/content/docs/` if user-facing behavior changed

## If this touches credentials, activation, or proxies

<!-- Delete this section if it does not apply. -->

- [ ] Any new capability pairing is backed by `transportFor` in
      `src/sources/account-adapters.ts` (only `claude` and `codex` accept a
      source from another provider)
- [ ] No proxy secret can reach stdout, stderr, or `--json` output
- [ ] New activation behavior is expressed as `ActivationPlan` steps, so the
      executor and rollback stay in sync
- [ ] New persisted mutations run under a scoped mutation lock owned by the
      service, not by the caller (ADR 0009)
- [ ] An ADR is added for a load-bearing design decision (existing accepted ADRs
      are superseded, never edited)
