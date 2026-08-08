# ADR-0002: Account import/export trust boundary (SEC-01)

- Status: accepted (2026-07-20)
- Task: SEC-01 (close the account import/export trust boundary)

## Context

Before SEC-01, `importAccount` did `mkdir(join(root, rel))` with file keys taken
verbatim from an untrusted `.hotplug.json` envelope, and never checked
`payload.meta.provider === requestedProviderId`. A malicious export could either
write a file outside the staging root (path traversal) or forge provider
ownership. The envelope also lacked any version/kind check, so
malformed/corrupt/foreign-version files were accepted or crashed unpredictably.

Fixed decision #1 in the plan ("external data is untrusted") requires that all
inbound material be decoded from `unknown` by a versioned codec and fully
validated *before* any caller mutates state (DB, snapshot, live auth).

## Decision

1. **Versioned codec, pure & I/O-free.** `src/core/account-codec.ts` exposes
   `decodeAccountEnvelope(raw: unknown, expectedProviderId)` and
   `stagedFilePath(stagingRoot, relKey)`. Decoding never touches the
   filesystem, so a rejection leaves no partial state. Envelope must be a
   JSON object with `kind: 'hotplug-account'` and `version: 1`; nothing else
   is accepted, and future versions are refused (not overwritten).
2. **Validate every file key before mutation.** A new pure helper
   `validateImportFileKey(key)` rejects empty keys, NUL bytes, absolute POSIX
   paths, Windows-style absolute paths (`C:\…`, `\\…`), mixed separators
   (`a/b\c`), and any normalized `..` escape. It runs *inside* `decodeFiles`
   (so `prepareSnapshot` is never called for a bad envelope) and *again* in
   `stagedFilePath` as defense-in-depth at write time.
3. **Provider ownership enforced.** `decodeAccountEnvelope` requires
   `meta.provider === expectedProviderId`; a mismatch is `IMPORT_FORMAT`.
4. **Imported proxy defaults to disabled.** Only portable, non-opaque
   `proxy` fields (enabled/port/host/plain options) cross the boundary;
   provider-specific secret/network options are dropped and re-derived by the
   provider on activation.
5. **Controlled error codes.** Malformed/forged/unsafe envelopes throw
   `HotplugError` with `IMPORT_FORMAT` (exit 8) or `IMPORT_LIMIT` (exit 9);
   secret material is never echoed.
6. **Atomic, owner-only export.** `exportAccount` writes to an owner-only
   temp file, `rename`s atomically, and `chmod`s the destination to `0o600`,
   warning the user the artifact contains credentials.

## Consequences

- A malicious envelope can no longer write outside the staging root or create
  a spurious DB row before validation.
- Rejection leaves the DB, current snapshot, active account, and live auth
  exactly as they were (`mutated: false`).
- `src/core/service.ts` `importAccount`/`exportAccount`/`writeFiles` no longer
  trust raw envelope keys.

## Deferred (same lane, later task)

- `DATA-01` builds the staged-replacement snapshot API on top of this codec so
  import becomes fully atomic at the DB transaction level (currently the
  snapshot dir is prepared incrementally; the codec already prevents bad
  writes, but the DB commit is a separate step).
