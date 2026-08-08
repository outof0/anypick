# Working on the AnyPick docs site

The site people read to decide whether to install AnyPick, plus the reference
they check when it misbehaves. A wrong sentence here is worse than a bug: it
tells someone to trust a pairing the CLI rejects.

`AGENT.md` in this directory is the nimbus-docs template's own authoring guide —
file layout, frontmatter shape, `<Render />`, the component registry. Read it for
mechanics. This file is the AnyPick-specific part. `../AGENTS.md` covers the CLI.

## Commands

This is a **separate pnpm project** with its own lockfile. Your working directory
does not persist between tool calls, so prefix every command:

```bash
cd docs && pnpm install
cd docs && pnpm dev          # localhost:4321
cd docs && pnpm build        # → dist/, includes the pagefind index
cd docs && pnpm typecheck    # astro check
cd docs && pnpm lint:docs    # nimbus-docs lint
```

A bare `pnpm build` from the repo root builds the **CLI**, not the site — you
will happily test stale `dist/` output and believe it.

`nimbus/frontmatter-shape` and `nimbus/internal-link` are configured as
**errors** in `astro.config.ts`, so `pnpm lint:docs` fails on a link to a page
that does not exist. Run it after moving or renaming anything.

## Every claim must be verifiable in `../src`

The one rule that matters most. This site has already shipped invented feature
claims that had to be walked back.

- **Capability pairs come from `transportFor`** in
  `../src/sources/account-adapters.ts`. Only `claude` and `codex` can be bound to
  a source from a different provider; `gemini` and `kiro` return `unsupported`
  for anything but their own. `../src/clients/index.ts` lists what *exists*, not
  what is *allowed*.
- **Binding and switching are different questions.** Binding a client to a
  foreign provider is the narrow list above. Switching which account is live is
  broader, because AnyPick restores the provider's own credential file, so
  anything reading it follows — Claude Code's IDE extensions, or Antigravity on a
  Gemini login. Documented exception: the Codex desktop app keeps its own
  signed-in account and does **not** follow `~/.codex/auth.json`; AnyPick only
  detects the mismatch to suppress the quota readout.
- **Do not invite readers to point third-party tools at a proxy.** The proxies do
  speak standard OpenAI and Anthropic wire formats, but each requires a
  per-instance bearer token (ADR 0006) that `publicProxyHandle` strips from all
  output. There is no documented way for a user to obtain it.
- CI runs on `ubuntu-latest` only. Do not claim Windows support.
- Flags, exit codes, and JSON shapes come from `../src/cli/commands.ts` and
  `ExitCode` in `../src/utils/errors.ts`. Copy them; do not infer them from a
  sibling command.
- `TuiFrame.astro` renders **real captured frames**. Never hand-write plausible
  TUI output — the layout is checked against the running app.

## Styling

- Docs pages use nimbus theme tokens: `bg-background`, `text-foreground`,
  `text-muted-foreground`, `bg-card`, `border-border`, `border-border-strong`,
  `text-primary`. They are `--nb-*` oklch variables mapped through `@theme` in
  `src/styles/globals.css`. Dark mode is `[data-mode="dark"]` on `<html>`, set by
  the inline script in `BaseLayout.astro` — do not add a second mechanism.
- `src/pages/index.astro` is the exception. The landing page is always dark and
  uses the AnyPick primary (`#7C3AED`) plus its semantic tokens directly. Keep it
  self-contained rather than bending the documentation tokens for one page.
- `.oxfmtrc.json` at the repo root ignores `docs/**` and `*.md`. Do not run
  oxfmt or oxlint here.

## Traps that have cost real time

- **Astro trims whitespace between a newline and an inline element.** Writing
  `switch of\n<code>~/.codex/auth.json</code>` renders as `of~/.codex/auth.json`.
  Use the continuation form: `<code\n  class="...">…</code\n>`. Check the built
  HTML, not the source.
- **Do not "fix" `base: "."` in `src/content.config.ts`.** Nimbus derives page
  URLs from `entry.id`, and ids are relative to `base`. Basing on `src/content`
  and globbing `docs/**` is what puts pages at `/docs/*` while leaving `/` free
  for the landing page. Files still live in `src/content/docs/`.
- `site` and `github` in `astro.config.ts` are **placeholders** — no repo exists
  yet. They drive canonical URLs, OG images, robots.txt, the sitemap, and every
  header/footer link. Replace both before any deploy.
- Deploys are Cloudflare Pages Direct Uploads via `wrangler.jsonc`
  (`pages_build_output_dir = "./dist"`), so `pnpm build` must run first —
  `predeploy` chains `astro check && astro build` for exactly that reason.

## Where the authority lives

| Question | Read |
| --- | --- |
| Nimbus mechanics, component registry, audit checklist | `AGENT.md` (this directory) |
| CLI invariants, test commands, lint policy | `../AGENTS.md`, `../CONTRIBUTING.md` |
| *Why* the CLI behaves this way | `../adr/` — cite ADRs by number |
| What we considered and rejected | `history/` — **provenance only, not the spec** |
