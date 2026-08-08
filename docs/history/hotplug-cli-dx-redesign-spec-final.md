# Hotplug CLI DX Redesign Specification

**Status:** Canonical implementation specification  
**Revision:** 2.4 — recovery serialization and source-specific planner steps  
**Supersedes:** `hotplug-cli-dx-redesign-spec.md`  
**Product name:** Working name only; naming may change without changing this command contract  
**Audience:** Coding agents and maintainers  
**Scope:** Full implementation, not an MVP

---

# 1. Executive decision

The first redesign correctly identified that Hotplug should expose user intent rather than internal subsystems, but it still introduced too many user-facing abstractions and inconsistent command grammar.

This version makes the normal workflow depend on only two concepts:

```text
Client  = the CLI being configured or launched
Source  = the account or gateway the client should use
```

Examples:

```bash
hotplug use claude --with grok/work
hotplug run claude
hotplug run claude --with grok/work
hotplug current
```

The two primary verbs have one stable distinction:

```text
use  = set the persistent Hotplug-managed default
run  = launch now; an explicit --with override is temporary
```

The relationship grammar is identical for both commands:

```text
<verb> <client> --with <source>
```

Normal users do not manage contexts. Hotplug stores internal bindings. A reusable preset exists only when the user explicitly asks to save one.

---

# 2. What the product promises

Hotplug does not promise that users need to understand no concepts at all. A CLI invocation must identify what is being operated on.

Hotplug promises that users do not need to classify an operation by implementation subsystem:

- auth file;
- profile;
- proxy;
- endpoint protocol;
- environment injection;
- native login;
- client config format.

The user only answers:

1. Which client?
2. Which account or gateway?
3. Should this become the default, or only be used for this launch?

Interactive mode can answer these questions through pickers without requiring command memorization.

---

# 3. Product principles

## P1. Expose domain nouns, hide implementation nouns

User-facing daily nouns:

- client;
- account;
- gateway.

Internal nouns:

- binding;
- transport plan;
- proxy lease;
- client overlay;
- operation journal.

Optional advanced noun:

- preset.

`proxy`, `auth`, and legacy `profile` remain visible only in advanced management and diagnostics.

## P2. One relationship grammar

Persistent:

```bash
hotplug use claude --with grok/work
```

Temporary override:

```bash
hotplug run claude --with grok/work
```

Launch current binding:

```bash
hotplug run claude
```

Do not use `SOURCE --for CLIENT` in primary documentation. It reverses the argument order and creates unnecessary syntax memory.

## P3. No implicit external fallback

`hotplug run <client>` runs only an effective Hotplug binding:

1. explicit temporary `--with`;
2. project binding;
3. global Hotplug binding.

It must not silently use an unmanaged native configuration.

Unmanaged configuration may be inspected by `hotplug current` and diagnosed by `hotplug doctor`, but is never an implicit `run` fallback.

## P4. Bindings are state; presets are explicit convenience

A successful `use` stores a binding. It does not create a hidden context or preset.

A preset is created only through an explicit action:

```bash
hotplug use claude --with grok/work --save work-grok
```

Presets are optional shortcuts, not required workflow objects.

## P5. Deterministic references

Automatic resolution must never guess between resource kinds.

Canonical reference grammar:

```text
provider/account       account
gateway-name           gateway
@preset-name           saved preset
```

Optional fully qualified forms may also be accepted:

```text
account/provider/account
gateway/gateway-name
preset/preset-name
```

Fuzzy matching is permitted only inside an interactive picker and never for direct execution.

## P6. Interactive for exploration, strict for automation

Prompt only when all are true:

- stdin and stderr are TTYs;
- `--json` is absent;
- `--no-input` is absent;
- CI mode is not detected;
- required information is missing.

Otherwise fail with a deterministic error and exact corrective commands.

## P7. Persistent operations are transactional

Every persistent mutation follows:

```text
resolve → validate → plan → preview → execute → verify → commit
```

On failure:

```text
rollback → verify rollback → report
```

## P8. Ephemeral execution leaves no persistent mutation

`run --with` must not leave:

- changed active bindings;
- modified parent-shell variables;
- permanent client configuration;
- temporary overlay files;
- unnecessary temporary proxy processes.

## P9. Auto-proxy is capability-bound

Hotplug automates proxy lifecycle only when:

- the source adapter is proxy-capable;
- the required implementation is built in or installed;
- the client/source compatibility can be verified.

A missing external dependency produces guided setup, not partial mutation and not a false promise of full automation.

---

# 4. User-facing model

## 4.1 Client

A supported AI CLI.

Initial clients:

```text
claude
codex
kiro
```

A client is always the first positional argument for `use` and `run`.

## 4.2 Account

A saved native authentication identity belonging to a provider.

Canonical reference:

```text
<provider>/<account-name>
```

Examples:

```text
codex/personal
grok/work
opencode/team
kiro/company
```

The slash is syntactically significant. A reference containing one slash and beginning with a known provider is resolved as an account.

## 4.3 Gateway

A saved endpoint, credential, protocol declaration, and model configuration.

Examples:

```text
openrouter-work
anthropic-direct
local-litellm
```

Canonical optional qualified form:

```text
gateway/openrouter-work
```

A plain name without `/` or `@` resolves only as a gateway.

## 4.4 Binding — internal

A binding is the actual desired state:

```text
client → source + model + transport policy
```

Example:

```yaml
client: claude
source: grok/work
model: grok-4.5
transport: auto
scope: global
```

Bindings are not manually created, named, listed as contexts, or edited as a separate daily resource.

They are created or replaced by `use` and project-link operations.

## 4.5 Preset — optional and explicit

A preset is a user-named reusable binding specification.

Reference:

```text
@work-grok
```

A preset exists only after an explicit save:

```bash
hotplug use claude --with grok/work --save work-grok
```

A preset does not contain copied credentials. It references a source.

Presets are intentionally absent from the primary noun model and root help except in a short advanced/saved-config section.

---

# 5. Primary command surface

```text
hotplug
├── use <client> [--with <source|@preset> | --current]
├── run <client> [--with <source|@preset>] [-- <client args>]
├── current [client]
├── list [accounts|gateways|clients|presets]
├── add [account|gateway]
├── edit <account|gateway|@preset>
├── remove <account|gateway|@preset>
├── link <client> [--with <source|@preset>]
├── unlink [client]
├── reset [client]
├── doctor [target]
└── completion <shell>
```

Advanced namespaces:

```text
hotplug account ...
hotplug gateway ...
hotplug preset ...
hotplug proxy ...
hotplug auth ...       legacy/advanced
hotplug profile ...    deprecated gateway alias
```

There is no daily:

```text
hotplug add context
hotplug edit context
hotplug list contexts
hotplug context use
```

---

# 6. Global flags

Supported consistently where applicable:

```text
--json
--dry-run
--no-input
-y, --yes
-q, --quiet
-v, --verbose
--reveal
--no-color
--trace
```

Rules:

- `--json` disables prompts and decorative terminal output.
- `--dry-run` completes resolution and planning but performs no mutation or child launch.
- `--no-input` forbids prompts.
- `--yes` skips destructive confirmation; it does not supply missing required values.
- `--quiet` outputs only essential success or machine-required information.
- `--verbose` includes planner and transport details while redacting secrets.
- `--trace` includes internal operation step names but never credentials.
- respect `NO_COLOR`.
- no spinner or cursor control when output is not a TTY.

---

# 7. Root command

## 7.1 `hotplug`

In a TTY, open a lightweight interactive launcher.

```text
Hotplug

What do you want to do?

› Run a client
  Change a client default
  Add an account
  Add a gateway
  View current setup
  Link this project
  Diagnose a problem
```

The launcher asks intent questions using plain language:

```text
Which client?
› Claude
  Codex
  Kiro

What should Claude use?
› Grok · work account
  Anthropic · direct gateway
  OpenRouter · team gateway
```

It must not ask the user to choose between auth, profile, and proxy.

In a non-TTY, print concise usage and exit with code 2 when no command is supplied.

---

# 8. `hotplug use`

## 8.1 Purpose

Set or change a persistent Hotplug-managed binding for a client.

## 8.2 Canonical syntax

```bash
hotplug use <CLIENT> \
  [--with <SOURCE|@PRESET> [--model MODEL] [--save NAME] | --current]
```

Interactive forms:

```bash
hotplug use
hotplug use claude
```

Examples:

```bash
hotplug use claude --with grok/work
hotplug use codex --with codex/personal
hotplug use codex --with openrouter-work
hotplug use claude --with @work-grok
hotplug use claude --with grok/work --model grok-4.5
hotplug use claude --with grok/work --save work-grok
hotplug use claude --current
hotplug use claude --with grok/work --dry-run
```

`--current` is the explicit non-interactive form for re-applying the stored global binding. It is mutually exclusive with `--with`, `--model`, and `--save`.

## 8.3 Optional native-account shorthand

This shorthand may be supported:

```bash
hotplug use codex/personal
```

It is valid only when:

- the provider is also a supported client;
- the account is a native source for that same client;
- no client inference ambiguity exists.

Equivalent:

```bash
hotplug use codex --with codex/personal
```

The shorthand may appear in examples for native same-provider switching, but the canonical grammar remains client-first.

Do not infer Claude or Codex for a cross-client account such as `grok/work`.

## 8.4 Behavior

With `--with`:

1. resolve client;
2. resolve source or preset deterministically;
3. expand a preset into a concrete binding snapshot if present;
4. validate client/source compatibility;
5. validate credentials;
6. determine transport capability;
7. resolve and snapshot model behavior;
8. construct a persistent activation plan;
9. show the plan when `--dry-run`, verbose, or confirmation is required;
10. execute transactionally;
11. verify effective client state;
12. commit the global binding snapshot;
13. optionally save a preset only when `--save` is supplied;
14. update recent-use metadata.

With `--current`:

1. load the stored global Hotplug binding for the client;
2. copy its executable binding specification exactly;
3. ignore preset provenance for resolution;
4. re-validate and re-apply the snapshot transactionally;
5. do not read the current contents of the originating preset.

Example after editing a preset:

```bash
# Re-applies the existing binding snapshot
hotplug use claude --current

# Resolves and applies the latest preset revision
hotplug use claude --with @work-grok
```

A binding is always authoritative over its provenance. `originPreset` or equivalent metadata must never be dereferenced by `use --current`.

## 8.5 No source supplied

TTY behavior for:

```bash
hotplug use claude
```

is deterministic:

1. when a global binding already exists, re-validate and re-apply that binding snapshot;
2. do not open a source picker;
3. do not re-resolve an originating preset;
4. when no global binding exists, open a compatible-source picker.

This TTY shorthand is equivalent to `hotplug use claude --current` only when a global binding exists.

Non-TTY behavior remains strict:

```text
A source or --current is required.

Specify a source:
  hotplug use claude --with grok/work
  hotplug use claude --with openrouter-work

Or re-apply the stored global binding:
  hotplug use claude --current

Exit code: 2
```

Missing required input is an invalid-usage error (`2`), never an ambiguity error (`5`).

## 8.6 Success output

```text
✓ Claude now uses grok/work

  Model      grok-4.5
  Transport  managed proxy · 127.0.0.1:8080
  Scope      global default
```

Do not say that a context was created.

## 8.7 Idempotency

Using the already effective binding:

- validates lightweight state;
- does not rewrite unchanged files;
- does not restart a healthy compatible proxy;
- exits 0;
- prints `Already active`.

---

# 9. `hotplug run`

## 9.1 Purpose

Launch a client using its effective Hotplug binding, with an optional process-scoped override.

## 9.2 Syntax

```bash
hotplug run <CLIENT> [--with <SOURCE|@PRESET>] [--model MODEL] [--] [CLIENT_ARGS...]
```

Examples:

```bash
hotplug run claude
hotplug run claude --with grok/work
hotplug run codex --with openrouter-work
hotplug run claude --with @work-grok
hotplug run codex --with openrouter-work -- --model gpt-5
```

## 9.3 No client supplied

TTY:

```bash
hotplug run
```

opens a client picker. The picker marks clients with and without effective bindings.

Non-TTY:

```text
A client is required.

Try:
  hotplug run claude
  hotplug run codex

Exit code: 2
```

A missing required client is always an **invalid-usage** error with exit code `2`. It is not an ambiguity or state-conflict error and must never use exit code `5`.

There is no concept of a globally “active client”.

## 9.4 Effective binding resolution

For `hotplug run <CLIENT>` without `--with`:

1. project binding for that client;
2. global Hotplug binding for that client;
3. error.

No unmanaged-native fallback.

Example:

```text
No Hotplug source is configured for Claude.

Set a persistent default:
  hotplug use claude --with grok/work

Or run once:
  hotplug run claude --with grok/work

Existing native Claude configuration was detected, but Hotplug will not use it implicitly.
```

## 9.5 Explicit temporary override

For:

```bash
hotplug run claude --with grok/work
```

resolution is:

1. explicit source/preset;
2. optional explicit model;
3. no project/global source fallback.

The explicit plan is process-scoped.

## 9.6 Process behavior

The implementation must:

1. resolve and validate the plan;
2. refresh credentials only when the source adapter supports safe refresh;
3. start or reuse an eligible managed proxy;
4. create child-only environment or isolated client configuration;
5. spawn the client with inherited stdin/stdout/stderr;
6. forward signals;
7. propagate the child exit code;
8. remove temporary state;
9. release temporary proxy leases;
10. leave global and project bindings unchanged.

## 9.7 Isolation preference

Use in this order:

1. child environment variables, only when the client adapter has a tested environment-overlay implementation;
2. isolated temporary client home/config;
3. transactional patch-and-restore only when unavoidable and explicitly supported by the adapter.

## 9.7.1 Initial client-adapter reconciliation

The current Claude Code, Codex, and Kiro client adapters primarily write persistent configuration. They must not claim environment-overlay support merely because the client accepts some environment variables.

The implementation target for the initial three client adapters is:

```ts
{
  supportsEnvironmentOverlay: false,
  supportsIsolatedHome: true,
  supportsPersistentConfig: true
}
```

This is a required **post-refactor capability state**, not permission to set `supportsIsolatedHome: true` before the isolation methods exist.

Therefore, ephemeral `run` uses an isolated temporary client runtime:

1. create an owner-only temporary directory;
2. ask the client adapter for its explicit isolation manifest;
3. copy only the allowlisted files/directories from live client state;
4. patch the copied configuration with the resolved source/model/transport;
5. point the child process at that temporary home/config through client-specific environment or launch arguments;
6. launch the child;
7. forward signals and propagate its exit code;
8. delete the temporary runtime after success, failure, SIGINT, or SIGTERM.

Do not recursively copy an entire user home. Do not let generic orchestration code discover files by scanning a home directory.

### Required isolation-manifest contract

Each client adapter must explicitly describe what may be copied.

```ts
interface IsolatablePath {
  /**
   * Absolute live path resolved by the adapter.
   */
  sourcePath: string;

  /**
   * Relative destination inside the isolated runtime.
   * Must not contain `..` or escape the runtime root.
   */
  destinationPath: string;

  kind: 'file' | 'directory';

  /**
   * Missing required paths fail runtime creation.
   * Missing optional paths are skipped.
   */
  required: boolean;
}

interface IsolatedClientRuntime {
  directory: string;
  environment: Record<string, string>;
  cleanup(): Promise<void>;
}

interface ClientAdapter {
  readonly capabilities: ClientCapabilities;

  listIsolatablePaths(
    liveState: ClientLiveState
  ): Promise<readonly IsolatablePath[]>;

  createIsolatedRuntime(
    plan: ResolvedClientPlan,
    paths: readonly IsolatablePath[]
  ): Promise<IsolatedClientRuntime>;

  applyPersistent(
    plan: ResolvedClientPlan
  ): Promise<PersistentApplyResult>;
}
```

`listIsolatablePaths` is mandatory for every adapter that reports `supportsIsolatedHome: true`.

Rules:

- paths are adapter-owned static/config-derived allowlist entries, not results of broad filesystem crawling;
- every destination is validated to remain inside the temporary root;
- copied files preserve only the permissions required by the child and never become more permissive than the source;
- secrets not required by the child are excluded;
- symlinks are rejected or resolved under an explicit adapter policy that prevents escaping the allowlist;
- the adapter may generate a required file directly instead of copying it, but it must still describe that behavior in its isolation implementation and tests.

An adapter may report `supportsIsolatedHome: true` only when both `listIsolatablePaths` and `createIsolatedRuntime` are implemented and covered by cleanup, signal, permission, symlink, path-traversal, and concurrent-run tests.

Pure environment overlay may be added later per client. It is not required for the initial implementation and must remain `false` until implemented and tested.

Patch-and-restore requires:

- inter-process lock;
- exact backup;
- restoration on success, failure, SIGINT, SIGTERM, and process shutdown;
- concurrent-edit detection;
- integration tests.

For the initial Claude Code, Codex, and Kiro adapters, isolated runtime is the required ephemeral path. They must not silently patch the live persistent config for `run --with`.

# 10. `hotplug current`

## 10.1 Purpose

Show the effective Hotplug-managed state and separately report unmanaged configuration.

## 10.2 Syntax

```bash
hotplug current [CLIENT] [--json]
```

`hotplug status` remains a compatibility alias.

## 10.3 Human output

```text
Claude
  Hotplug source  grok/work
  Model          grok-4.5
  Scope          project · ~/code/acme
  Transport      managed proxy · 127.0.0.1:8080
  Health         ready

Codex
  Hotplug source  codex/personal
  Model          default · intentionally omitted
  Scope          global
  Auth           valid · refreshable
  Health         ready

Kiro
  Hotplug source  not configured
  External       native configuration detected
```

A migrated binding whose model cannot be reconstructed is valid and must be explicit:

```text
Claude
  Hotplug source  openrouter-work
  Model          unknown · migrated legacy state
  Scope          global
  Health         configuration observed
```

Do not render an unknown migrated model as blank or `—`, because that conflates it with an intentional omission.

The labels must prevent users from confusing external config with a Hotplug binding.

## 10.4 JSON schema

```json
{
  "schemaVersion": 2,
  "clients": [
    {
      "client": "claude",
      "binding": {
        "managed": true,
        "scope": "project",
        "source": {
          "kind": "account",
          "ref": "grok/work"
        },
        "model": {
          "mode": "explicit",
          "id": "grok-4.5"
        }
      },
      "transport": {
        "capability": "managed_builtin_proxy",
        "protocol": "anthropic",
        "status": "running",
        "endpoint": "http://127.0.0.1:8080"
      },
      "externalConfigurationDetected": false,
      "health": "ready"
    }
  ]
}
```

For migration-only unknown state:

```json
{
  "model": {
    "mode": "unknown",
    "reason": "legacy_migration"
  }
}
```

No ANSI output in JSON.

# 11. `hotplug list`

## 11.1 Syntax

```bash
hotplug list [accounts|gateways|clients|presets] [FILTER] [--json]
```

Alias:

```bash
hotplug ls
```

## 11.2 Default view

```text
Active bindings

  Claude   grok/work             project
  Codex    codex/personal        global

Saved

  5 accounts
  3 gateways
  2 presets

Use:
  hotplug list accounts
  hotplug list gateways
  hotplug list presets
```

Do not list internal binding IDs or hidden contexts.

## 11.3 Presets

Presets are visible because the user explicitly created them.

```bash
hotplug list presets
```

```text
@work-grok
  Client  claude
  Source  grok/work
  Model   grok-4.5
```

---

# 12. `hotplug add account`

## 12.1 Goal

Adding accounts must not require knowledge of `stash`, local auth-file locations, token snapshots, or server-side logout behavior.

## 12.2 Syntax

Interactive:

```bash
hotplug add account
hotplug add account codex
```

Explicit automation:

```bash
hotplug add account codex --current --name personal
hotplug add account codex --new --name work
```

Flags:

```text
--current      save the currently live provider login
--new          preserve the current login and launch a new login flow
--name NAME
```

`--current` and `--new` are mutually exclusive.

## 12.3 Why explicit modes are required for automation

`hotplug add account codex` is ambiguous when:

- a live login already exists;
- it may or may not already be saved;
- the user might want to capture it or add another account.

TTY interaction:

```text
Codex is currently logged in as personal@example.com.

What do you want to do?

› Add another account
  Save the current account
  Cancel
```

Non-TTY interaction is forbidden:

```text
Choose how to add the Codex account.

Save the current login:
  hotplug add account codex --current --name personal

Add another login:
  hotplug add account codex --new --name work

Exit code: 2
```

## 12.4 `--current` flow

1. detect current live identity;
2. validate auth structure;
3. reject if no live login;
4. infer or accept name;
5. snapshot account;
6. verify snapshot can be read;
7. do not change live login.

## 12.5 `--new` flow

1. detect and snapshot current live auth exactly;
2. save an unsaved current identity or keep an operation backup;
3. clear or relocate only local live auth;
4. never call remote logout/revoke;
5. launch the official provider login command;
6. validate that a new identity was created;
7. save the new account;
8. make it live unless a future explicit flag requests restoration;
9. on failure, restore the exact original live auth;
10. verify restoration.

The words `stash` and `save` may appear in advanced account documentation, but not as required steps in onboarding.

---

# 13. `hotplug add gateway`

## 13.1 Syntax

```bash
hotplug add gateway
hotplug add gateway openrouter-work \
  --provider openrouter \
  --endpoint https://openrouter.ai/api/v1 \
  --api-key-env OPENROUTER_API_KEY \
  --model anthropic/claude-sonnet-4
```

## 13.2 Wizard

Ask:

1. provider/template;
2. endpoint;
3. API key source;
4. default model;
5. optional model aliases;
6. connection test;
7. optionally configure a client now.

The final optional action is expressed as a normal binding:

```text
Use this gateway for a client now?
```

If yes, execute the equivalent of:

```bash
hotplug use claude --with openrouter-work
```

## 13.3 Key handling

- secret input is masked;
- allow environment-variable references;
- do not pass keys in process arguments;
- preserve existing secure-storage behavior;
- never reveal keys in plans or JSON unless existing explicit reveal policy permits it.

---

# 14. Presets

## 14.1 Creation

Only explicit:

```bash
hotplug use claude --with grok/work --save work-grok
```

or advanced:

```bash
hotplug preset save work-grok \
  --client claude \
  --with grok/work \
  --model grok-4.5
```

There is no automatic preset/context creation on every `use` or `run`.

## 14.2 Use

```bash
hotplug use claude --with @work-grok
hotplug run claude --with @work-grok
```

A preset includes its client. If the positional client conflicts:

```text
Preset @work-grok is for Claude, not Codex.

Try:
  hotplug run claude --with @work-grok

No configuration was changed.
Exit code: 2
```

Preset/client mismatch is invalid argument composition, not a capability conflict. It must always exit with code `2`.

## 14.3 Management

Advanced:

```bash
hotplug preset list
hotplug preset show work-grok
hotplug preset edit work-grok [options]
hotplug preset rename work-grok work
hotplug preset remove work-grok
```

Generic management also works:

```bash
hotplug edit @work-grok
hotplug remove @work-grok
```

### 14.3.1 Edit syntax

Interactive:

```bash
hotplug edit @work-grok
hotplug preset edit work-grok
```

opens a form prefilled from the existing preset.

Explicit:

```bash
hotplug preset edit work-grok \
  [--client CLIENT] \
  [--with SOURCE] \
  [--model MODEL | --clear-model] \
  [--transport auto|direct|proxy]
```

Rules:

- omitted fields preserve their current value;
- `--model` and `--clear-model` are mutually exclusive;
- changing the client or source requires a fresh compatibility and transport validation;
- editing is transactional and leaves the previous preset unchanged on validation or persistence failure;
- presets never contain copied credentials;
- preset rename changes only the preset name and does not rename its source;
- invalid edits exit with code `2`; missing referenced sources exit with code `3`; capability conflicts exit with code `5`.

### 14.3.2 Preset edits do not mutate active bindings

A preset is a template, not a live indirection.

When a preset is used, Hotplug resolves it into a concrete binding snapshot. Editing the preset later affects future `use`, `run --with`, or `link --with` operations only. It must not silently change existing global or project bindings.

Bindings may store preset ID, name, and revision as diagnostic provenance, but resolution and execution use only the copied binding specification. Provenance is never a runtime foreign key.

To apply an edited preset to the current default:

```bash
hotplug use claude --with @work-grok
```

To re-apply the existing binding without adopting preset edits:

```bash
hotplug use claude --current
```

Editing, renaming, or deleting a preset must not change or invalidate a project binding created from that preset.

# 15. Deterministic resolution

## 15.1 Resolution table

| Input | Resolution |
|---|---|
| `grok/work` | account `grok/work` |
| `account/grok/work` | account `grok/work` |
| `openrouter-work` | gateway `openrouter-work` |
| `gateway/openrouter-work` | gateway `openrouter-work` |
| `@work-grok` | preset `work-grok` |
| `preset/work-grok` | preset `work-grok` |

## 15.2 Rules

1. input beginning `@` resolves only as preset;
2. input beginning `preset/` resolves only as preset;
3. input beginning `gateway/` resolves only as gateway;
4. input beginning `account/` resolves only as account;
5. `<known-provider>/<name>` resolves only as account;
6. plain input resolves only as an exact gateway name;
7. when a plain input has no exact gateway match but an exact preset with that name exists, return `RESOURCE_NOT_FOUND` and suggest the qualified preset form; do not auto-resolve it;
8. no direct fuzzy execution;
9. no cross-kind ambiguity error is possible under this grammar.

Example:

```text
Gateway `work-grok` was not found.

A preset with that name exists.
Did you mean:
  hotplug use claude --with @work-grok

No configuration was changed.
Exit code: 3
```

The suggestion is permitted only for an exact preset-name match. Do not suggest a fuzzy preset match in non-interactive execution.

## 15.3 Duplicate prevention

- account name unique within provider;
- gateway name globally unique;
- preset name globally unique;
- gateway and preset names may be equal because `@` disambiguates them;
- `/` and leading `@` are reserved from gateway names;
- preset names are stored without the leading `@`.

## 15.4 Interactive search

A picker may fuzzy-search across all compatible sources and presets because the selected result has a concrete typed ID.

The fuzzy string must never be re-parsed as a direct command reference.

---

# 16. Project binding

Project scope must not depend on a first-class context.

## 16.1 Syntax

```bash
hotplug link <CLIENT>
hotplug link <CLIENT> --with <SOURCE|@PRESET> [--model MODEL]
hotplug unlink [CLIENT]
```

Examples:

```bash
# Link the current global Claude binding into this project
hotplug link claude

# Create a project-specific binding directly
hotplug link claude --with grok/work

# Remove it
hotplug unlink claude
```

## 16.2 Project root

1. nearest Git root;
2. otherwise current working directory.

Store project bindings in Hotplug’s database. Do not write secrets or Hotplug config into the repository.

## 16.3 `hotplug link <client>` without `--with`

`hotplug link <client>` without `--with` resolves a snapshot in this order:

1. current global Hotplug binding for that client;
2. existing project binding for the same project root and client;
3. error when neither exists.

When a global binding exists, copy its executable specification into project scope.

When no global binding exists but a project binding already exists, re-validate and re-apply that project snapshot idempotently. This does not change its source or re-resolve any preset provenance.

For an explicit preset:

```bash
hotplug link claude --with @work-grok
```

Hotplug must resolve the preset once and store a concrete project-binding snapshot. It must not store a live preset reference required for execution.

Editing, renaming, or deleting the preset later must not modify or invalidate the project binding.

## 16.4 Precedence

For `run <client>`:

1. explicit `--with`;
2. project binding;
3. global binding;
4. error.

---

# 17. `hotplug reset`

## 17.1 Purpose

Remove Hotplug-managed configuration for a client while preserving external/native configuration unless Hotplug has an exact tracked backup to restore.

## 17.2 Syntax

```bash
hotplug reset [CLIENT] [--dry-run]
```

## 17.3 Rules

- no client in TTY: picker;
- no client in non-TTY: usage error;
- remove global binding;
- optionally ask whether project bindings should also be removed;
- remove only Hotplug-managed config blocks;
- restore exact tracked original state where available;
- never invent a replacement config;
- stop a proxy only when no binding or active lease needs it.

---

# 18. `hotplug doctor`

## 18.1 Purpose

Diagnose broadly. Auto-fix narrowly.

## 18.2 Syntax

```bash
hotplug doctor [TARGET] [--fix] [--json]
```

## 18.3 Diagnostic scope

Doctor may report:

- missing executables;
- invalid auth structure;
- account expiry;
- gateway reachability;
- model incompatibility;
- proxy health;
- occupied ports;
- stale locks/PIDs;
- mismatched Hotplug binding and client configuration;
- external configuration;
- missing optional external proxy dependency;
- leftover temporary overlays;
- unsafe file permissions;
- incomplete operation journal;
- project bindings referencing deleted sources.

## 18.4 Hard allowlist for `--fix`

`doctor --fix` may perform only these actions:

1. delete a stale Hotplug-owned lock after verifying the owner process is absent;
2. delete a stale Hotplug-owned PID record after verifying the process is absent or unrelated;
3. stop a Hotplug-owned orphan proxy only when:
   - no active global/project binding references it;
   - no live lease references it;
   - ownership marker matches;
4. delete a Hotplug-owned temporary overlay only when:
   - no live process references it;
   - ownership marker and age checks pass;
5. repair permissions only on Hotplug-owned files and directories;
6. rebuild derived local caches, indexes, and completion metadata;
7. complete or roll back an operation journal only when the journal contains a verified exact rollback plan.

## 18.5 Explicitly forbidden auto-fixes

`doctor --fix` must never:

- modify a native provider auth file;
- switch or clear a live account;
- create, change, or delete an active binding;
- modify an unmanaged client configuration;
- revoke a token;
- refresh a token;
- replace an API key;
- change a gateway endpoint;
- assign a different source or model;
- import an external config;
- delete a user-created account, gateway, or preset;
- reassign ports for a live non-orphan proxy;
- install external executables or packages.

For forbidden items, doctor reports an exact manual command.

Example:

```text
Claude has conflicting native authentication variables.

Doctor will not modify native Claude authentication.

Review:
  hotplug current claude --verbose

Reset only Hotplug-managed configuration:
  hotplug reset claude
```

## 18.6 Confirmation

Even allowlisted fixes:

- show the exact plan;
- require confirmation unless `--yes`;
- in JSON/non-TTY require `--yes`;
- journal every mutation.

---

# 19. Proxy capability model

## 19.1 Capability states

Each source/client transport combination resolves to one of:

```text
direct
managed_builtin_proxy
managed_external_proxy
external_manual_proxy
unsupported
```

### direct

No proxy required.

### managed_builtin_proxy

Hotplug contains and owns the proxy implementation.

Example: built-in Grok/OpenCode proxy support where already implemented.

### managed_external_proxy

Hotplug can locate, launch, monitor, and stop an installed external executable through an adapter.

Example: Kiro only if a supported `kirolink`/`kiro-proxy` executable is installed and the adapter contract is implemented.

### external_manual_proxy

The source requires an external proxy but Hotplug cannot safely own its lifecycle.

Hotplug must stop before mutating the client and provide setup guidance.

### unsupported

No verified compatible path.

## 19.2 Automation promise

Revised acceptance rule:

> Normal workflows require no manual proxy lifecycle commands when the selected source/client combination is `managed_builtin_proxy` or an available `managed_external_proxy`.

Do not claim universal auto-proxy support.

## 19.3 Missing dependency behavior

Example:

```text
Kiro through grok/work requires an external compatibility proxy.

Hotplug did not find a supported proxy executable.

Install/configure one, then verify:
  hotplug doctor kiro

No client configuration was changed.
Exit code: 7
```

The exact installation command may be shown only when maintained by the adapter and verified for the current platform.

A missing required external executable always exits with code `7`. An installed but incompatible transport is a capability conflict and exits with code `5`.

## 19.4 No partial activation

If transport cannot be satisfied:

- do not update binding;
- do not write client config;
- do not leave a port reservation;
- roll back credential refresh side effects where possible;
- return a capability error.

## 19.5 Kiro external-proxy discovery contract

The Kiro provider adapter must remove all developer-machine absolute paths, including repository paths under a specific user home and hardcoded package-manager installation paths.

The adapter must discover `kirolink` or `kiro-proxy` in this order:

1. an explicit Hotplug adapter configuration path, when configured;
2. the current process `PATH`;
3. package-manager bin directories derived at runtime from environment/configuration, such as `PNPM_HOME` or an npm/pnpm global-bin query;
4. platform-conventional user-local executable directories maintained in one adapter-owned list.

Rules:

- never embed `/Users/<name>/...`, `~/workspace/...`, or another developer-specific source-tree path;
- canonicalize and validate the discovered path;
- verify that the executable or Node entry point exists and is readable/executable;
- probe version/help output with a bounded timeout before classifying it as managed;
- when the target is a JavaScript entry point rather than an executable bin, launch it through the resolved Node executable with an argument array;
- cache a successful detection only for the current process or with an invalidatable filesystem fingerprint;
- include the selected path in verbose diagnostics, but never include secrets.

Capability result:

```text
detected and probe succeeds  → managed_external_proxy
not detected                 → external_manual_proxy
detected but probe fails      → external_manual_proxy + diagnostic
```

When automatic Kiro transport requires the missing executable, activation follows §19.3 and exits `7` before any client or binding mutation.

---

# 20. Capability interfaces

## 20.1 Source-adapter capability contract

Transport is a property of a resolved **source used with a client**, not only of an account provider.

Both account sources and gateway sources implement the same transport contract.

```ts
type TransportCapability =
  | 'direct'
  | 'managed_builtin_proxy'
  | 'managed_external_proxy'
  | 'external_manual_proxy'
  | 'unsupported';

interface SourceCapabilities {
  sourceKind: 'account' | 'gateway';

  /**
   * Provider/catalog identity, for example grok, opencode,
   * openrouter, litellm, local, or custom.
   */
  provider: string;

  /**
   * Clients for which this source can perform native/direct
   * activation without a compatibility proxy.
   *
   * This field is compatibility metadata only.
   * It must never be used to infer a missing CLI argument.
   */
  nativeClients: ClientId[];

  protocols: Array<'openai' | 'anthropic'>;
  canRefresh: boolean;
  supportsModelDiscovery: boolean;
}

interface SourceAdapter {
  readonly sourceRef: ResourceRef;
  readonly capabilities: SourceCapabilities;

  transportFor(clientId: ClientId): TransportCapability;
}
```

Examples:

- `grok/work` resolves to an account-source adapter;
- `codex/personal` resolves to an account-source adapter;
- `openrouter-work` resolves to a gateway-source adapter;
- `local-litellm` resolves to a gateway-source adapter.

The activation planner first resolves a concrete source, obtains its `SourceAdapter`, then calls:

```ts
resolvedSource.adapter.transportFor(clientId)
```

The planner must not classify transport from a provider name, resource kind, endpoint string, or generic boolean.

### 20.1.1 Account-provider adapters

Existing auth providers may implement or produce account-source adapters:

```ts
interface AccountProvider {
  // Existing provider identity/auth/account methods remain.

  adapterFor(account: SavedAccount): SourceAdapter;
}
```

Grok, OpenCode, Kiro, and Codex/native-auth must expose account-source adapters implementing `transportFor`.

### 20.1.2 Gateway-source adapters

Every gateway must also resolve to a source adapter.

```ts
interface GatewaySourceAdapter extends SourceAdapter {
  readonly sourceRef: GatewayResourceRef;
}
```

Gateway implementations include catalog and custom sources such as:

- OpenRouter;
- Anthropic/OpenAI direct gateways;
- LiteLLM;
- local endpoints;
- custom OpenAI-compatible endpoints;
- custom Anthropic-compatible endpoints.

A compatible direct gateway generally returns `direct`. A gateway requiring a managed local compatibility layer returns the corresponding managed capability. An incompatible protocol/client pair returns `unsupported`.

Gateway classification must consider the saved gateway's declared protocols and endpoint metadata. It must not assume all gateways are direct merely because they are gateways.

### 20.1.3 Required legacy-interface refactor

The legacy provider-level flag:

```ts
readonly supportsProxy: boolean;
```

is too coarse and must be removed.

It cannot distinguish:

- direct native activation for one client;
- a built-in proxy for another client;
- an installed external proxy;
- a missing external dependency;
- a direct gateway;
- a gateway/client protocol mismatch;
- an unsupported client/source pair.

All production declarations and reads of `supportsProxy` must be deleted. There must be one transport source of truth: `SourceAdapter.transportFor(clientId)`.

## 20.2 Client capability contract

```ts
interface ClientCapabilities {
  id: ClientId;
  acceptedProtocols: Array<'openai' | 'anthropic'>;
  supportsEnvironmentOverlay: boolean;
  supportsIsolatedHome: boolean;
  supportsPersistentConfig: boolean;
}
```

A capability may be `true` only when its corresponding adapter path is implemented and tested.

The initial post-refactor Claude Code, Codex, and Kiro values are defined in §9.7.1.

## 20.3 Concrete resolved source and transport

```ts
interface ResolvedSource {
  ref: ResourceRef;
  kind: 'account' | 'gateway';
  adapter: SourceAdapter;
}
```

Planner output uses a concrete transport type distinct from capability classification:

```ts
interface ResolvedTransport {
  capability: TransportCapability;
  protocol: 'openai' | 'anthropic';
  endpoint?: string;
  managedProxy?: {
    provider: string;
    account?: string;
    port: number;
    leaseId: string;
  };
  externalExecutable?: {
    name: string;
    path: string;
  };
}
```

`TransportCapability` describes what the resolved source adapter can support for the requested client. `ResolvedTransport` describes the exact endpoint, executable, process lease, and protocol selected for one activation plan.

Commands and planners do not hardcode account-provider or gateway matrices.

# 21. Binding data model

## 21.1 Model selection

`undefined` must not represent both an intentional omission and an unrecoverable migrated value.

```ts
type ModelSelection =
  | { mode: 'explicit'; id: string }
  | { mode: 'omitted' }
  | {
      mode: 'unknown';
      reason: 'legacy_migration' | 'external_import';
    };
```

Semantics:

- `explicit`: Hotplug resolved and stored a concrete model ID;
- `omitted`: Hotplug intentionally leaves model selection to a verified client/source default;
- `unknown`: an older effective model could not be reconstructed exactly.

New `use`, `link`, preset-save, and preset-edit operations may create only `explicit` or `omitted`. `unknown` is reserved for migration/import.

## 21.2 Binding specification

```ts
interface BindingSpec {
  client: ClientId;
  source: ResourceRef;
  model: ModelSelection;
  transportPolicy: 'auto' | 'direct' | 'proxy';
  clientOptions: Record<string, unknown>;
}
```

The executable specification contains no preset pointer.

## 21.3 Provenance

```ts
type BindingProvenance =
  | { kind: 'direct' }
  | {
      kind: 'preset_snapshot';
      presetId: string;
      presetNameAtSnapshot: string;
      presetRevisionAtSnapshot: number;
    }
  | {
      kind: 'global_binding_snapshot';
      globalBindingUpdatedAt: string;
    }
  | {
      kind: 'legacy_migration';
      sourceConfidence: 'exact';
      modelConfidence: 'exact' | 'omitted' | 'unknown';
      importedAt: string;
    };
```

Provenance is diagnostic metadata only. Planners, executors, `run`, `use --current`, and project-binding resolution must never dereference it.

Deleting a preset must not cascade to bindings. Use `ON DELETE SET NULL` for an optional diagnostic foreign key, or store non-relational provenance.

## 21.4 Global binding

```ts
interface GlobalBinding {
  client: ClientId;
  spec: BindingSpec;
  provenance: BindingProvenance;
  managedConfigRevision?: string;
  createdAt: string;
  updatedAt: string;
}
```

One global binding per client.

## 21.5 Project binding

```ts
interface ProjectBinding {
  projectRoot: string;
  client: ClientId;
  spec: BindingSpec;
  provenance: BindingProvenance;
  createdAt: string;
  updatedAt: string;
}
```

One project binding per project root and client.

## 21.6 Saved preset

```ts
interface SavedPreset {
  id: string;
  name: string;
  revision: number;
  spec: Omit<BindingSpec, 'model'> & {
    model:
      | { mode: 'explicit'; id: string }
      | { mode: 'omitted' };
  };
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
}
```

No credentials are duplicated. Every successful preset edit increments `revision`.

## 21.7 No context record

Do not create a generic `ContextRecord` table or service for ordinary activation.

If an earlier unreleased implementation created context records, migrate explicit named records to presets and discard unreferenced hidden cache records after backup.

# 22. Activation planner

All `use`, `run`, `link`, and reset operations use structured planners.

```ts
interface ActivationRequest {
  mode: 'persistent' | 'ephemeral' | 'project';
  client: ClientId;
  source?: ResourceRef;
  preset?: string;
  model?: string;
}

interface ActivationPlan {
  mode: 'persistent' | 'ephemeral' | 'project';
  client: ClientId;
  resolvedSource: ResolvedSource;
  transport: ResolvedTransport;
  steps: PlanStep[];
  rollback: RollbackStep[];
  warnings: PlanWarning[];
}
```

Possible steps:

```text
ResolveSource
ExpandPreset
ValidateCompatibility
ValidateCredential
RefreshCredential
InspectClientState
ResolveTransport
ValidateExternalDependency
AllocateProxyLease
StartProxy
WaitForHealth
WriteNativeAuth
WriteClientConfig
CreateEnvironmentOverlay
CreateTemporaryClientHome
VerifyEffectiveState
CommitGlobalBinding
CommitProjectBinding
SpawnChild
ReleaseLease
RestoreTemporaryState
```

### Step-emission rules

- `CreateEnvironmentOverlay` may be emitted only when the selected client adapter reports `supportsEnvironmentOverlay: true`.
- `CreateTemporaryClientHome` may be emitted only when the adapter reports `supportsIsolatedHome: true`.
- for the initial Claude Code, Codex, and Kiro adapters, ephemeral plans emit `CreateTemporaryClientHome` and must not emit `CreateEnvironmentOverlay`;
- `WriteNativeAuth` may be emitted only for an **account source** whose account/source adapter explicitly requires mutation of a live native-auth state, such as switching a native Codex login;
- gateway sources must never emit `WriteNativeAuth`;
- an account source served through a proxy or isolated client runtime also skips `WriteNativeAuth` unless its adapter separately declares native-auth activation as required;
- persistent plans use `WriteClientConfig` only through an adapter with `supportsPersistentConfig: true`;
- a plan must fail before execution when no supported isolation/mutation path exists;
- capability flags, source kind, and emitted steps must be asserted in planner unit tests.

## 22.1 Dry run

```text
Plan: Claude ← grok/work

1. Validate Grok account
2. Resolve Anthropic-compatible transport
3. Reuse managed proxy on 127.0.0.1:8080
4. Configure Claude
5. Verify endpoint health
6. Save as Claude global binding

No changes were made.
```

---

# 23. Transactions, locks, and recovery

## 23.1 File mutation

- exact backup before mutation;
- sibling temporary file;
- preserve permissions;
- atomic replace;
- verify parse and effective behavior;
- retain backup until commit.

## 23.2 Database sequencing

External state verification must pass before binding commit.

If database commit fails after external mutation:

- rollback external state;
- verify rollback;
- journal failure.

## 23.3 Locks

Scoped locks for:

- each provider live auth file;
- each client config;
- proxy process/port state;
- database migration;
- patch-and-restore run overlays.

Report owner PID where known.

## 23.4 Operation journal

```ts
interface OperationJournalEntry {
  id: string;
  type: string;
  state:
    | 'planned'
    | 'executing'
    | 'verifying'
    | 'committed'
    | 'rolling_back'
    | 'rolled_back'
    | 'failed';

  /**
   * Canonical serializable references such as:
   * - account/grok/work
   * - gateway/openrouter-work
   * - client/claude
   * - project/<canonical-root>/claude
   */
  affectedResources: string[];

  /**
   * Exact filesystem backups required for rollback.
   */
  backupPaths: string[];

  startedAt: string;
  updatedAt: string;
}
```

Operation journals store only serializable resource references, operation parameters, ownership markers, and backup paths. They must never serialize:

- `SourceAdapter` or client-adapter instances;
- functions or closures;
- child-process handles;
- in-memory proxy objects;
- unresolved filesystem objects.

Startup recovery re-resolves adapters from the stored canonical `ResourceRef` and client ID through the current registries.

Recovery rules:

- re-resolution must be exact and deterministic;
- recovery must verify that the resolved source still represents the same stable resource identity recorded by the operation;
- if a source, adapter, executable, or capability can no longer be resolved exactly, do not continue forward execution;
- exact file rollback from recorded backups may still proceed when it does not require source re-resolution;
- otherwise mark the operation `failed` and provide a doctor/recovery instruction;
- never substitute another gateway, account, provider adapter, or transport capability.

Startup recovery must never silently choose a new binding or edit native auth. Only exact recorded rollback/commit completion is automatic.

---

# 24. Help and error design

## 24.1 Root help

```text
Hotplug — use your AI accounts and gateways with any supported CLI

Usage:
  hotplug <command> [options]

Common:
  use       Set what a client uses by default
  run       Launch a client
  current   Show effective Hotplug bindings
  list      List accounts and gateways
  add       Add an account or gateway
  reset     Remove Hotplug-managed configuration

Projects:
  link      Set a project-specific client source
  unlink    Remove a project binding

Troubleshooting:
  doctor    Diagnose setup; auto-fix only safe Hotplug-owned state

Examples:
  hotplug use claude --with grok/work
  hotplug use claude --current
  hotplug run claude
  hotplug run codex --with openrouter-work
  hotplug current

Advanced:
  account
  gateway
  preset
  proxy
```

## 24.2 Error contract

Every usage or resolution error includes:

1. what failed;
2. what Hotplug did not do;
3. exact corrective command.

Example:

```text
Gateway `work` was not found.

Accounts use provider/name:
  hotplug use claude --with grok/work

Gateways use their saved name:
  hotplug use claude --with openrouter-work

No configuration was changed.
```

## 24.3 Agent-safe prompting

Prompts disabled when:

- no TTY;
- CI;
- `--json`;
- `--no-input`.

No interactive command may hang in these conditions.

---

# 25. Streams, JSON, and exit codes

## 25.1 Streams

- structured success data: stdout;
- errors: stderr;
- progress uses stderr when stdout is JSON/data;
- child streams inherited unchanged.

## 25.2 Exit codes

```text
0    success
1    operational failure
2    invalid usage or validation, including a missing required client
3    resource not found, including a missing gateway with an exact `@preset` suggestion
4    authentication/login required
5    capability or state conflict
6    health/verification failure
7    required external dependency missing
130  cancellation/SIGINT
```

After successful setup, `run` exits with the child exit code.

## 25.3 JSON errors

```json
{
  "error": {
    "code": "NO_ACTIVE_BINDING",
    "message": "No Hotplug source is configured for Claude.",
    "client": "claude",
    "suggestions": [
      "hotplug use claude --with grok/work",
      "hotplug run claude --with grok/work"
    ],
    "mutated": false
  }
}
```

---

# 26. Legacy migration

## 26.1 Command mapping

| Existing command | Preferred |
|---|---|
| `hotplug status` | `hotplug current` |
| `hotplug whoami` | `hotplug current` / `hotplug account current` |
| `hotplug switch codex personal` | `hotplug use codex --with codex/personal` |
| `hotplug save codex work` | `hotplug add account codex --current --name work` |
| `hotplug stash codex` | hidden inside `hotplug add account codex --new` |
| `hotplug refresh codex` | `hotplug account refresh codex` |
| `hotplug apply openrouter-work -c codex` | `hotplug use codex --with openrouter-work` |
| `hotplug profile create ...` | `hotplug add gateway ...` |
| `hotplug profile edit ...` | `hotplug edit gateway/...` |
| `hotplug profile reset --client claude` | `hotplug reset claude` |
| manual proxy commands | advanced; automated only when capability allows |

## 26.2 Compatibility

During the compatibility major:

- legacy commands continue to work;
- warnings go to stderr;
- JSON stdout remains clean;
- scripts can suppress deprecation warnings;
- low-level behavior remains compatible.

## 26.3 Database migration

Add:

- global bindings;
- project bindings;
- saved presets;
- operation journal;
- proxy leases;
- recent-use metadata.

Do not add hidden contexts.

Keep existing profiles internally and expose them as gateways until a safe schema rename is justified.

Back up SQLite before migration. Migrations must be idempotent.

## 26.4 Importing legacy applied state

Migration observes existing state. It must not rewrite client configuration merely to make it fit the new model.

## 26.4.1 Legacy profile records are gateways

Legacy `RuntimeProfile` records represent API endpoint/key/model configurations. They migrate as gateway resources regardless of the profile's catalog `provider` value.

Examples:

```text
RuntimeProfile.name     = openrouter-work
RuntimeProfile.provider = openrouter
```

becomes:

```text
Gateway.name = openrouter-work
Binding.source = gateway/openrouter-work
```

The catalog provider identifies gateway behavior. It does not make the profile a native account source.

A legacy `ClientState.profileName` therefore maps exactly as:

```text
ClientState.profileName → Gateway.name → gateway/<profileName>
```

Migration must not inspect `RuntimeProfile.provider` and reinterpret the profile as `grok/<name>`, `opencode/<name>`, or another account reference.

## 26.4.2 Legacy profile to per-client bindings

The legacy `GlobalConfig.activeProfile` value is not sufficient to identify one target client. A single profile may have been applied to multiple clients.

Migration must:

1. migrate every valid legacy `RuntimeProfile` to a gateway;
2. enumerate every persisted `ClientState`;
3. for each client whose `ClientState.profileName` exactly identifies a migrated gateway, create one `GlobalBinding` for that client;
4. set that binding source to `gateway/<profileName>`;
5. allow one legacy profile to produce multiple global bindings;
6. preserve client-specific configuration and model evidence independently for each binding;
7. use `GlobalConfig.activeProfile` only as profile metadata or consistency evidence;
8. never create a binding solely for `defaultClient` from `activeProfile`;
9. when no `ClientState` identifies a client exactly, create no guessed binding from `activeProfile` alone.

Example:

```text
ClientState[claude].profileName = openrouter-work
ClientState[codex].profileName  = openrouter-work
```

migrates to:

```text
GlobalBinding[claude] → gateway/openrouter-work
GlobalBinding[codex]  → gateway/openrouter-work
```

Each binding may have a different model state after evidence reconstruction.

## 26.4.3 Legacy native-account state

Native account bindings are separate from legacy profiles.

An account-based binding may be migrated only from exact account/auth metadata that identifies all of:

- client;
- provider;
- saved account identity or saved-account record.

Examples of acceptable evidence include a legacy per-client active-account record, an exact Hotplug-owned native-auth marker, or an adapter fingerprint that uniquely matches one saved account.

`GlobalConfig.activeProfile`, `RuntimeProfile.provider`, and `ClientState.profileName` are not account evidence.

If the legacy switch implementation did not persist an exact client-to-account association:

- do not guess an account binding;
- preserve the live native auth file;
- report the client as external/native or unmanaged;
- allow the user to capture it later through `hotplug add account --current` and `hotplug use`.

## 26.4.4 Exact-evidence rules

Create a binding only when its source can be identified exactly from one of:

1. `ClientState.profileName` matching one migrated gateway;
2. exact legacy per-client account metadata;
3. an exact Hotplug-owned configuration marker;
4. an endpoint mapped to one unique Hotplug-owned proxy/source;
5. an adapter fingerprint that exactly matches one saved account or gateway.

If the source cannot be identified exactly:

- create no Hotplug binding;
- report the client as external/unmanaged;
- preserve configuration untouched.

## 26.4.5 Model reconstruction

Resolve the model independently for each client binding from:

1. old Hotplug per-client apply metadata;
2. an explicit model in the effective client configuration;
3. a Hotplug-tracked environment/config overlay.

When the exact model cannot be reconstructed:

```ts
model: {
  mode: 'unknown',
  reason: 'legacy_migration'
}
```

Do not substitute the gateway's current default model. It may have changed since the legacy configuration was applied.

When the old configuration can be proven to have intentionally omitted model selection, store:

```ts
model: { mode: 'omitted' }
```

A binding with `model.mode === 'unknown'` is a valid partial migration, not corrupt data.

`hotplug current` must render it as:

```text
Model  unknown · migrated legacy state
```

`hotplug use <client>` in TTY, `hotplug use <client> --current`, and `hotplug run <client>` must not fail solely because the migrated model is unknown when the client/source adapter verifies that omission is safe. In that case, preserve the unknown state and execute without injecting a model.

When omission is not verifiably safe, exit with code `5` and require an explicit model:

```text
The migrated Claude binding does not contain a known model.

Choose one explicitly:
  hotplug use claude --with openrouter-work --model anthropic/claude-sonnet-4

No configuration was changed.
Exit code: 5
```

Migration must not create a preset automatically.

# 27. Security requirements

- never invoke remote logout/revoke during local account add/switch unless explicitly requested by a future feature;
- do not place secrets in process arguments;
- use protected environment or owner-only temporary files;
- redact tokens, keys, authorization headers, and secret query parameters;
- `--reveal` does not reveal unrelated child output or internal logs;
- bind managed proxies to loopback by default;
- require explicit advanced confirmation for non-loopback hosts;
- spawn executable plus argument array, never shell-concatenated commands;
- validate imported auth and gateway files before storage;
- preserve restrictive permissions;
- `doctor --fix` follows the hard allowlist only.

---

# 28. Testing strategy

## 28.1 Unit tests

Required:

- client-first grammar;
- account/gateway/preset reference parser;
- zero cross-kind ambiguity;
- native-account shorthand constraints;
- source/client compatibility;
- every account-source and gateway-source adapter implements `transportFor(clientId)` and no production code reads `supportsProxy`;
- gateway adapters classify direct, managed, and unsupported protocol/client paths;
- `nativeClients` is never used for missing-client inference;
- Kiro executable detection order and classification;
- client capabilities cannot report isolated/environment support without implemented adapter methods;
- every isolated-home adapter returns a validated explicit isolation manifest;
- isolation manifests reject path traversal, unsafe symlinks, and destinations outside the temp root;
- initial client plans emit `CreateTemporaryClientHome` and not `CreateEnvironmentOverlay`;
- gateway-source plans never emit `WriteNativeAuth`;
- native-account plans emit `WriteNativeAuth` only when the source adapter explicitly requires live-auth activation;
- operation journals contain canonical resource references and no adapter/runtime instances;
- startup recovery re-resolves source adapters from stored `ResourceRef` values;
- no unmanaged fallback;
- binding precedence;
- TTY `use <client>` re-applies an existing global snapshot and opens a picker only when none exists;
- non-TTY `use <client>` without `--with` or `--current` exits `2`;
- `use --current` never dereferences preset provenance;
- `link <client>` resolves global, then existing project snapshot, then error;
- preset expansion and client mismatch exits `2`;
- missing-`@` exact preset suggestion without implicit preset resolution;
- preset edit validation and field-preservation semantics;
- preset edits do not mutate existing global/project bindings;
- missing required client always exits `2`;
- dry-run planning;
- secret redaction;
- doctor fix allowlist;
- transport capability states and `ResolvedTransport` construction;
- explicit, omitted, and unknown model states;
- exit-code mapping.

## 28.2 Integration tests

Required:

1. configure Claude with Grok using one `use`;
2. configure a native Codex account;
3. `run claude` uses a project binding before the global binding;
4. `run claude` errors with no Hotplug binding despite detected native config;
5. explicit `run --with` leaves persistent bindings unchanged;
6. child exit-code propagation;
7. SIGINT and SIGTERM cleanup;
8. add the current live account;
9. add another account while preserving the original;
10. failed login restores original auth;
11. create a gateway and use it;
12. create a preset only with explicit `--save`;
13. gateway and preset may share a base name and resolve deterministically;
14. a missing gateway with an exact preset-name match suggests `@name`, exits `3`, and does not execute it;
15. editing a preset preserves omitted fields and does not mutate active bindings;
16. editing, renaming, or deleting a preset does not change or invalidate a project binding snapshot;
17. TTY `use claude` re-applies the global binding without resolving preset provenance;
18. non-TTY `use claude` without `--with` or `--current` exits `2`;
19. `use claude --current` re-applies the stored snapshot after its origin preset changes;
20. `link claude` uses the global binding when present;
21. `link claude` falls back to the existing project snapshot when no global binding exists;
22. `link claude` errors when neither global nor project binding exists;
23. preset/client mismatch exits `2`;
24. project link stores a binding snapshot and no runtime preset dependency;
25. every resolved account and gateway exposes a `SourceAdapter`;
26. Grok/OpenCode/Kiro/Codex account-source adapters classify transport through `transportFor`;
27. OpenRouter/LiteLLM/custom gateway adapters classify transport through `transportFor`;
28. no production source/provider adapter exposes or reads `supportsProxy`;
29. Kiro discovery finds a fake executable from `PATH`;
30. Kiro discovery has no hardcoded developer-home or repository path;
31. missing Kiro executable classifies as `external_manual_proxy` and activation exits `7` before mutation;
32. built-in proxy starts automatically;
33. an installed supported external proxy is managed through its adapter;
34. an installed but incompatible transport exits `5`;
35. unsupported client/source path produces a capability error;
36. Claude Code, Codex, and Kiro ephemeral runs use isolated temporary client runtimes;
37. each isolated runtime copies only the adapter isolation manifest;
38. isolation manifest path traversal and unsafe symlink attempts fail before child launch;
39. isolated runtime uses owner-only permissions and is deleted after normal exit;
40. isolated runtime is deleted after SIGINT and SIGTERM;
41. parallel ephemeral runs do not modify the live client config;
42. initial ephemeral plans emit `CreateTemporaryClientHome` and not `CreateEnvironmentOverlay`;
43. a gateway-source activation plan never emits `WriteNativeAuth`;
44. a native Codex account switch emits `WriteNativeAuth` only through its account-source adapter contract;
45. an account served through a managed proxy skips `WriteNativeAuth` when native activation is unnecessary;
46. operation-journal JSON contains canonical resource refs and no serialized adapter/runtime object;
47. startup recovery re-resolves the exact source adapter from the journal resource ref;
48. startup recovery refuses forward execution when the original source or adapter cannot be resolved exactly;
49. exact file rollback can complete from recorded backups without serializing an adapter;
50. doctor fixes a stale Hotplug-owned lock;
51. doctor refuses native-auth modification;
52. orphan-proxy fix checks ownership, bindings, and leases;
53. reset removes only Hotplug-managed state;
54. a legacy command produces the equivalent binding;
55. one legacy `RuntimeProfile` becomes one gateway resource;
56. `ClientState.profileName` maps to `gateway/<profileName>`;
57. one legacy gateway profile referenced by two `ClientState` records creates two global bindings;
58. `GlobalConfig.activeProfile` alone does not create a guessed default-client binding;
59. `RuntimeProfile.provider` is never interpreted as a native account source;
60. account binding migration requires exact per-client account metadata;
61. migration with an exact source and missing model creates `model.mode = "unknown"`;
62. migration never substitutes the gateway's current default for an unknown legacy model;
63. migration with a non-exact source leaves the client external and creates no binding;
64. `current` human and JSON output distinguish `unknown` from `omitted`;
65. migration is idempotent;
66. JSON contains no ANSI output or deprecation warning;
67. concurrent mutations are locked.

## 28.3 PTY tests

- root launcher;
- `use` source picker;
- `run` client picker;
- add-account choice between current/new;
- masked secret input;
- cancellation code 130;
- no prompt under CI/non-TTY.

## 28.4 Golden tests

Snapshot:

- root help;
- use/run help;
- no-binding error;
- missing-dependency error;
- deterministic not-found errors;
- dry-run plan;
- current output;
- doctor report and fix plan;
- deprecation warnings.

---

# 29. Revised acceptance criteria

## 29.1 Daily DX

- Claude can be persistently configured with one predictable command:

  ```bash
  hotplug use claude --with grok/work
  ```

- The same relationship uses the same syntax for temporary execution:

  ```bash
  hotplug run claude --with grok/work
  ```

- The configured binding launches with:

  ```bash
  hotplug run claude
  ```

- No ordinary workflow requires knowledge of auth/profile/proxy subsystems.
- No ordinary workflow requires creating or managing contexts.
- A preset exists only after explicit `--save`.
- Editing a preset changes future use only and never silently rewrites active global or project bindings.
- `use <client>` in a TTY re-applies the existing global snapshot; it opens a picker only when no global binding exists.
- `use <client> --current` is the explicit automation-safe re-apply form and never dereferences preset provenance.
- `link <client>` resolves global binding, then an existing project snapshot, then errors.
- project bindings remain valid after their origin preset is edited, renamed, or deleted.
- preset/client mismatch exits `2`; missing required external dependency exits `7`.
- A missing `@` is suggested only after an exact preset-name match and never triggers implicit execution.
- `run` never silently falls back to unmanaged configuration.
- Account, gateway, and preset references are deterministically distinguishable.
- `current` clearly separates Hotplug-managed and external state.
- migrated bindings distinguish unknown model state from intentional omission.
- adding another account does not require the word `stash`.

## 29.2 Automation

- every interactive flow has a complete explicit equivalent;
- no prompt occurs in CI/non-TTY;
- errors include exact corrective invocations;
- JSON is stable and ANSI-free;
- persistent changes support dry-run;
- `run` propagates child exit codes;
- initial Claude Code, Codex, and Kiro ephemeral runs use tested isolated temporary client runtimes;
- every isolated runtime is built from an explicit adapter-owned isolation manifest;
- initial ephemeral plans do not emit environment-overlay steps;
- capability flags never advertise an execution path that is not implemented.
- gateway plans never emit native-auth mutation steps.
- operation journals are data-only and startup recovery re-resolves adapters from canonical resource references.

## 29.3 Proxy behavior

- built-in proxy-capable combinations require no manual proxy lifecycle commands;
- installed, adapter-supported external proxies can be managed automatically;
- every account and gateway source classifies transport through `SourceAdapter.transportFor(clientId)`;
- the legacy `supportsProxy` flag no longer exists or influences planning;
- Kiro external executables are discovered dynamically and no developer-machine paths remain;
- missing or manual-only external proxies produce guidance before mutation;
- unsupported combinations are explicit.

## 29.4 Safety

- persistent failures roll back;
- temporary runs leave no persistent state;
- server-side tokens are not revoked by account onboarding;
- secrets are redacted;
- concurrent mutations are locked;
- `doctor --fix` cannot modify auth, credentials, bindings, or unmanaged client config;
- legacy commands remain functional during migration.

---

# 30. Coding-agent execution prompt

```text
Implement the canonical redesign in hotplug-cli-dx-redesign-spec-final.md.

This specification supersedes the earlier context-first redesign.

Core contract:

1. The normal user model has Client and Source only.
2. Source is an Account or Gateway.
3. Binding is internal state.
4. Preset is optional and exists only after explicit --save.
5. Canonical grammar is:
     hotplug use <client> --with <source>
     hotplug run <client> [--with <source>]
6. `run <client>` resolves only project then global Hotplug bindings.
   It must never fall back to unmanaged native configuration.
7. Account refs are provider/name.
   Plain names are gateways.
   @name is a preset.
   When a plain gateway name is missing but an exact preset exists, suggest @name and exit 3; never auto-resolve it.
8. Presets are editable templates.
   Global and project bindings are concrete snapshots.
   Preset provenance is diagnostic only.
9. In a TTY, `use <client>` re-applies an existing global binding.
   When none exists, it opens a compatible-source picker.
10. In non-TTY mode, `use <client>` requires `--with` or `--current`; missing input exits 2.
11. `link <client>` without `--with` resolves global binding, then existing project snapshot, then errors.
12. Preset/client mismatch is invalid usage and exits 2.
13. Remove context management and do not create hidden context records.
14. `hotplug add account` hides stash/save mechanics and supports explicit --current/--new modes.
15. Replace legacy `Provider.supportsProxy` with a source-level adapter contract:
      SourceAdapter.transportFor(clientId): TransportCapability
16. Both account sources and gateway sources implement `SourceAdapter`.
    Include Grok, OpenCode, Kiro, Codex/native-auth, OpenRouter, LiteLLM, local, and custom gateways.
17. `nativeClients` is direct-activation compatibility metadata only.
    Never use it to infer a missing client argument.
18. Remove every production declaration/read of `supportsProxy`.
19. Remove Kiro developer-machine hardcoded paths.
    Detect kirolink/kiro-proxy through configured path, PATH,
    runtime-derived package-manager bins, and platform-local locations.
20. Missing required external executable exits 7 before mutation.
    Installed but incompatible transport exits 5.
21. `doctor --fix` implements only the hard allowlist.
22. Implement isolated temporary client runtimes for Claude Code, Codex, and Kiro.
23. Every isolated-home adapter implements `listIsolatablePaths` and `createIsolatedRuntime`.
    The manifest is explicit, validated, path-traversal safe, and symlink safe.
24. Initial capabilities are:
      supportsEnvironmentOverlay=false
      supportsIsolatedHome=true
      supportsPersistentConfig=true
    Set isolatedHome=true only after implementation and tests exist.
25. Initial ephemeral plans emit CreateTemporaryClientHome only.
    They must not emit CreateEnvironmentOverlay or patch live persistent config.
26. Legacy RuntimeProfile records migrate as gateways.
    ClientState.profileName maps to gateway/<profileName>.
27. One gateway profile referenced by N ClientState records creates N GlobalBindings.
    Do not infer a default-client binding from GlobalConfig.activeProfile alone.
28. Never reinterpret RuntimeProfile.provider as an account source.
    Account bindings require exact separate per-client account/auth metadata.
29. Legacy migration preserves unknown model state and never guesses a current gateway default.
30. Preserve legacy commands during the compatibility period.
31. Reuse existing auth, proxy, profile, client, refresh, SQLite, and file-mutation code.
32. Implement transactions, rollback, locks, operation journals,
    project/global bindings, presets, and proxy leases.
33. Use TransportCapability for classification and ResolvedTransport for the concrete plan.
34. Emit `WriteNativeAuth` only for account-source adapters that explicitly require live native-auth mutation.
    Gateway sources must never emit it.
35. Keep operation journals data-only.
    Store canonical ResourceRef/client identifiers and backup paths, never adapter instances or runtime handles.
    Startup recovery re-resolves adapters exactly from those references.
36. Add every unit, integration, PTY, golden, migration, signal,
    executable-detection, isolation-manifest, journal-recovery, and concurrency test in the specification.
37. Update README, help, completion, and migration documentation.
38. Do not reduce the scope to an MVP.

Begin with:
- repository assessment;
- exact current-command-to-redesign mapping;
- inventory of every Provider/supportsProxy declaration and read;
- inventory of account and gateway source types;
- gateway adapter design for catalog and custom gateways;
- inventory of hardcoded executable paths;
- client-by-client isolation manifest and temporary-runtime plan;
- exact RuntimeProfile, ClientState, and GlobalConfig migration mapping;
- database migration proposal;
- file-by-file implementation plan;
- compatibility and rollback risks.

Then implement phase by phase and run typecheck/tests after each phase.
```

# 31. Final mental model

```text
Claude is the client.
grok/work is the source.
use makes it the default.
run launches it.
```

```bash
hotplug use claude --with grok/work
hotplug run claude
```

Everything involving auth snapshots, API profiles, protocol conversion, proxy lifecycle, ports, environment variables, and configuration files is Hotplug’s responsibility.

Bindings are concrete snapshots. Presets are editable templates. Provenance never changes runtime semantics.

Capabilities are executable contracts, not descriptive booleans: an adapter may advertise a path only when that path is implemented, detectable, and tested.

Transport classification belongs to the resolved source—account or gateway—not to a provider-wide flag.

Operation journals persist identities and rollback data, never executable adapter objects.
