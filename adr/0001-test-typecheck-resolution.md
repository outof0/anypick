# ADR-0001: Strict typechecking for extensionless TypeScript source

- Status: accepted (2026-07-20)
- Task: BASE-01 (test & package baseline truthfulness)

## Context

Hotplug authors extensionless relative imports in both `src` and `tests`.
`tsconfig.json` deliberately excludes `tests`; its production typecheck uses
`module: ESNext` / `moduleResolution: Bundler`. Vite performs the Node/SSR
build and emits `.js` specifiers in `dist`, while TypeScript emits declarations
whose relative specifiers are rewritten to Node-compatible `.js` paths.

BASE-01 needed `pnpm typecheck` to cover the test suite under `strict` without
imposing a different module-resolution model from source authoring.

## Decision

`tsconfig.test.json` extends `tsconfig.json` but overrides:

- `module: "esnext"` and `moduleResolution: "bundler"`
- `noEmit: true`, `rootDir: "."`, `declaration: false`,
  `declarationMap: false`, `sourceMap: false`
- `include: ["src/**/*", "tests/**/*"]`, `exclude: [..., "tests/consumer"]`

The `bundler` resolution mirrors how Vitest and the Vite Node/SSR build consume
the code, so typechecking validates real contract mismatches without extension
noise. The `tests/consumer/*` standalone fixtures are excluded because they
resolve `hotplug` from an installed tarball, not the workspace.

## Consequences

- `pnpm typecheck` gates both production and test contracts under `strict`.
- Source imports stay extensionless. The Vite build, declaration rewrite, and
  consumer fixtures jointly verify the published Node ESM boundary.
