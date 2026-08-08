# ADR-0008: Crash backups live in an owner-only recovery dir (TXN-01)

- Status: accepted (2026-07-20)
- Task: TXN-01 (durable write-ahead recovery)

## Context

The activation journal (`operation_journal` in SQLite) is already persistent and
the recovery engine (`recoverIncompleteOperations`) already restores overwritten
client config files from recorded `backupPaths` at startup and in doctor. But the
backups themselves were written to the **system temp directory**
(`mkdtemp(join(tmpdir(), 'hotplug-backup-…'))`) with **basename-only** destination
filenames. Two problems:

1. **Not owner-only / not durable.** System temp is world-readable by default and
   is routinely cleaned (reboots, tmpwatch). A crash recovery that depends on a
   file in `/tmp` can silently find it gone — exactly when it is needed.
2. **Collision risk.** Two managed targets that share a basename (e.g. both
   `~/.claude/settings.json` and `~/.config/settings.json`, or two concurrent
   activations) clobber each other's backup because the destination was only the
   basename.

The journal already satisfies the "durably persist the backup manifest before
commit" requirement: `executeActivationLocked` records `backupPaths` into the
journal entry at `verifying` state, before the binding commit, and recovery trusts
those paths. The storage location was the remaining gap.

## Decision

1. **Owner-only recovery directory inside the Hotplug root.** Backups are stored
   under `<hotplugRoot>/recovery/clients/<clientId>/` (created with mode `0o700`),
   not the system temp dir (`src/core/paths.ts` `recoveryDir` /
   `clientRecoveryDir`). They survive crashes and are never world-readable.
2. **Collision-free hashed filenames.** Each backup filename is
   `sha1(<absolute target>)[0:16]-<basename>`, so two targets with the same
   basename — or concurrent activations — write distinct files. The basename is
   kept for human readability.
3. **`src=>dest` manifest unchanged.** The backup entry format consumed by
   `recoverIncompleteOperations` is unchanged (`src` = recovery file, `dest` =
   the live file to restore), so the existing recovery engine works without
   modification. The manifest is still durably persisted in the journal entry.

## Consequences

- Crash backups survive a reboot and are confined to the owner's Hotplug root.
- Two managed files named identically across directories never clobber each
  other's backup (`tests/txn-recovery.test.ts`).
- Recovery restores the exact prior file from the owner-only backup on a
  simulated crash + restart.
- Temp-dir leftover `hotplug-backup-*` dirs are no longer produced.

## Rejected alternatives

- **Keep `tmpdir` but add a random subdir per activation.** Still not durable
  across tmp cleanup and not owner-only; only moves the collision risk down a
  level. The Hotplug root is the correct home for Hotplug's own recovery data.
- **Namespace backups by basename + counter.** Counter collisions under
  concurrency and still no per-target identity; hashing the absolute path is
  collision-free by construction.
