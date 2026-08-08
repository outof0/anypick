# Hotplug — Product Feature Scope

**Source of truth:** product direction confirmed by the owner  
**TUI scope:** native accounts, account rotation, and account-backed proxies

---

## 1. What Hotplug is

Hotplug manages multiple native logins for local AI tools.

It lets a user:

- save the currently logged-in account as a local snapshot;
- add another login without revoking the previous one;
- switch which saved account is live in the provider's native auth files;
- preserve refreshed tokens before switching away;
- refresh saved or live credentials when supported;
- expose supported accounts through a local compatibility proxy;
- inspect and repair Hotplug-owned operational state.

```text
official tool login
       ↓
live native auth ← hotplug → saved account snapshots
       ↓                         ↓
native tool                optional local proxy
```

---

## 2. First-class objects

### Provider

A native tool/auth provider such as:

- Codex;
- Grok;
- OpenCode;
- Kiro;
- Gemini.

Each provider owns the location and format of its native auth files.

### Live login

The credential material currently present in the provider's native filesystem location.
This is what the official tool will use now.

### Saved account

A named local snapshot of a provider login. Saved accounts are isolated per provider and
contain opaque provider-owned auth files plus display metadata.

### Active account record

Hotplug's pointer to the saved account expected to correspond to live auth. Live identity
and active record can drift, so the TUI must show them separately when they do not match.

### Proxy

Optional operational state attached to an account/provider that supports it:

- enabled/disabled;
- host and port;
- running/stopped;
- endpoint, PID, compatibility, logs.

Proxy is not a top-level resource independent from accounts.

---

## 3. Core workflows

### Save current login

```text
detect live auth → choose account name → snapshot native files → mark active if first
```

### Add another login

```text
save current login → clear local auth without server logout → user logs in with official
tool → detect new live auth → name and save snapshot
```

Hotplug does not automate the official login flow.

### Hotplug account

```text
choose provider → choose saved target → save refreshed previous live auth → stop previous
proxy → restore target snapshot → update active record → start target proxy when enabled →
verify live identity
```

### Refresh

- refresh live auth and sync it into the active snapshot;
- refresh one saved snapshot;
- refresh every saved account for a provider.

Only providers with refresh support expose this action.

### Proxy control

- enable and optionally start for an account;
- allocate a free port when omitted;
- reject explicit port collisions;
- configure host/port;
- start, stop, restart, disable;
- inspect status and logs;
- restart the appropriate proxy during account rotation.

### Account maintenance

- inspect metadata and timestamps;
- export/import snapshots;
- remove an account, stopping its proxy first;
- diagnose missing auth, stale processes, permissions, and incomplete Hotplug operations.

---

## 4. Explicitly outside the TUI product surface

Even if related code currently exists in the repository, this TUI does not present:

- launching Claude/Codex/Kiro clients;
- client bindings;
- project/global routes;
- API gateways;
- presets;
- model selection;
- client configuration management.

Those concepts must not influence the TUI navigation or terminology.

---

## 5. TUI success criteria

Within seconds, the user can answer:

- Which account is live for each provider?
- Which saved accounts are available?
- Does live auth match Hotplug's active record?
- Which proxy is running and on what endpoint?
- What exactly happens if I hotplug to another account?
- How do I safely add another official login?

