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

A bare `pnpm build` from the repo root fails: there is no root `package.json`.
The site build lives in this directory; run it here or with `cd docs &&`.

`nimbus/frontmatter-shape` and `nimbus/internal-link` are configured as
**errors** in `astro.config.ts`, so `pnpm lint:docs` fails on a link to a page
that does not exist. Run it after moving or renaming anything.

## Every claim must be verifiable in `../src`

The one rule that matters most. This site has already shipped invented feature
claims that had to be walked back.

- **Capability pairs come from the adapters** in
  `../src/go/internal/transport/`. `claude`, `codex`, `opencode`, `zcode`,
  `dsh`, `commandcode`, `pi` and `omp` may accept a source from a different
  provider.
  `gemini` and `kiro` clients return `unsupported` for anything but their own.
  The workbuddy *client* uses its own login directly, so it is
  `unsupported` everywhere else; a workbuddy *account*
  still serves those borrowing clients through the proxy, and switching the
  app between saved accounts works natively via its session file. `cline` is a
  provider login without a client adapter. `../src/go/internal/client` lists
  what *exists*, not what *is allowed*.
  `internal/transport/adapter_matrix_test.go` holds the exhaustive pairing
  matrix, sweeping the ids from `client.Registry.IDs()`.
- **Binding and switching are different questions.** Binding a client to a
  foreign provider is the narrow list above. Switching which account is live is
  broader, because AnyPick restores the provider's own credential file, so
  anything reading it follows — Claude Code's IDE extensions, or Antigravity on a
  Gemini login. Documented exception: the Codex desktop app keeps its own
  signed-in account and does **not** follow `~/.codex/auth.json`; AnyPick only
  detects the mismatch to suppress the quota readout.
- **Do not invite readers to point third-party tools at a proxy.** The proxies do
  speak standard OpenAI and Anthropic wire formats, but each requires a
  per-instance bearer token (ADR 0006) that never crosses an output boundary
  (AGENTS.md invariant #2). There is no documented way for a user to obtain it.
- CI runs Go tests on `ubuntu-latest` and `windows-latest`, the macOS app job on
  macOS, plus Tauri, docs, and distribution-adapter jobs. Windows is a supported
  build target for the Go engine and the Tauri app; do not claim macOS-only
  support.
- Flags, exit codes, and JSON shapes come from `../src/go/cmd/anypick` and
  `ExitCode` in `../src/go/internal/anyerr/errors.go`. Copy them; do not infer
  them from a sibling command.
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
- `site` and `github` in `astro.config.ts` are set to the production values
  (`https://anypick.dev`, `https://github.com/outof0/anypick`), and the docs
  deployment workflow deploys the built site. They drive canonical URLs, OG
  images, robots.txt, the sitemap, and every header/footer link.
- Deploys are Cloudflare Pages Direct Uploads via `wrangler.jsonc`
  (`pages_build_output_dir = "./dist"`), so `pnpm build` must run first —
  `predeploy` refreshes the published GitHub release manifest, checks types, builds,
  and validates the landing HTML before uploading. `pnpm refresh:downloads` updates
  `src/data/release.json`; offline builds use that checked-in snapshot. Run
  `pnpm check:landing` after building to check all nine landing pages, SEO metadata,
  and installer links.

## Where the authority lives

| Question | Read |
| --- | --- |
| Nimbus mechanics, component registry, audit checklist | `AGENT.md` (this directory) |
| CLI invariants, test commands, lint policy | `../AGENTS.md`, `../CONTRIBUTING.md` |
| *Why* the CLI behaves this way | `../adr/` — cite ADRs by number |
| What we considered and rejected | `history/` — **provenance only, not the spec** |
