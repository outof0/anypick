# Historical design documents

These are **not** current documentation. They are the design and planning
documents written while `anypick` was being built, kept for provenance: they
explain *why* several decisions were made, and a number of source comments still
cite their section numbers.

Do not treat anything here as a description of how the code works today. The
authoritative sources are, in order:

1. The code itself.
2. [`../../adr/`](../../adr/) — accepted architecture decisions, each with
   context and consequences. Start here for "why is it like this?".
3. [`../../README.md`](../../README.md) — user-facing behaviour and commands.
4. [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) — layering, how to add a
   provider or client, lint policy.

## Contents

| Document | What it is | Status |
| --- | --- | --- |
| `anypick-cli-dx-redesign-spec-final.md` | The original CLI/DX specification. Source of the `§`-numbered references in code comments (e.g. exit codes in `src/utils/errors.ts`). | Largely implemented; superseded in places by ADRs. Despite the `-final` suffix, later plans revised it. |
| `DESIGN.md` | Long-form architecture narrative: layering, stores, registries, adapter contracts. | Mostly accurate in spirit; specifics have drifted. |
| `DESIGN-TUI.md` | TUI screen-by-screen design. Source of the `DESIGN-TUI §n` references in `src/tui/**`. | Mostly implemented. |
| `FRAMEWORK-IMPROVEMENT-PLAN.md` | Proposed framework hardening work. | Partly done, partly obsolete. A proposal, never a description. |
| `OPENCODE-GATEWAY-IMPLEMENTATION-PLAN.md` | Plan for the OpenCode gateway/proxy. | Implemented. |
| `anypick-feature-map.md` | Early feature inventory. | Historical. |

## If you are adding a code comment

Cite an **ADR number**, not a `§` section from these files. ADRs are short,
immutable once accepted, and state their own consequences; a section number in a
76 KB superseded spec sends the next reader on an archaeology expedition. Where
no ADR covers the decision, write the reason inline instead.
