# Security Policy

## Supported versions

Security fixes are applied to the latest released minor version of AnyPick. Do not rely on unreleased commits for security patches.

## Reporting a vulnerability

Please report vulnerabilities privately to the maintainers through the repository's security advisory feature. Do not open a public issue for credential exposure, arbitrary file access, proxy authentication bypass, or unsafe account switching.

Include the affected version, a minimal reproduction, impact, and any relevant platform details. Maintainers will acknowledge reports within seven days and coordinate disclosure after a fix is available.

## Security boundaries

AnyPick intentionally handles local credentials and client configuration. It writes only to AnyPick-managed state and explicit adapter-owned paths, and journals compensating actions before mutable activation steps.

## Plugins

AnyPick can load third-party plugins into its own process, where they run alongside code that reads and rewrites live credential files. That boundary is deliberately narrow (see [ADR-0012](adr/0012-plugin-trust-boundary.md)):

- AnyPick never downloads, installs, or updates a plugin. There is no registry and no auto-discovery — you install a local directory by path with `anypick plugin add`.
- Installing does not enable. A plugin is recorded disabled and does not load until you run `anypick plugin enable <name>`, which is the point where you grant in-process execution.
- Enabling pins a SHA-256 digest of the **entire plugin package** (manifest + every shipped file under the plugin directory, excluding VCS/dev dirs). The digest is verified *before* the entry module is imported; if any file changes — not only `main` — the plugin is refused until you review it and run `anypick plugin trust <name>`.
- `ANYPICK_NO_PLUGINS=1` disables plugin loading entirely.

Enabling a plugin is equivalent to trusting its author with every credential AnyPick manages. Treat it the way you would treat installing a shell plugin, not the way you would treat a config change. Report plugin-boundary bypasses — loading without an enable, executing before package-digest verification, a helper-module change that does not invalidate trust, or an entry path escaping the plugin directory — as vulnerabilities.
