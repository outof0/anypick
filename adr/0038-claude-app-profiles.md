# 0038: The Claude app gets separate profiles, not a credential swap

- Status: accepted (2026-11-02)
- Related: [0004](0004-atomic-snapshot-save.md), [0009](0009-mutation-coordinator.md),
  [0011](0011-reentrant-provider-scoped-locks.md)

## Context

Claude Code and the Claude desktop app are separate login owners. The CLI reads
the `Claude Code-credentials` Keychain item (or `~/.claude/.credentials.json`)
and `oauthAccount` in `~/.claude.json`. The app keeps an encrypted token cache
in its `config.json` plus session cookies in its Chromium profile. The app has
no multi-account support, so `anypick use claude` changes the CLI and leaves
the app, and its Code tab, on whatever account it had.

Community switchers do one of two things. Most swap the app's login files in
place and relaunch. That works, but it writes the user's only live login, and
at least one such tool documents the app accepting a restored login for Chat
while rejecting it for Code (`session_stale_relogin`). Others run an instance on
a separate Electron user data directory.

Signed builds ignore `CLAUDE_USER_DATA_DIR`. `--user-data-dir` was checked
against app version 4.4212.0: the instance runs on the given folder and starts
signed out.

## Decision

1. **A Claude app profile is one data folder**,
   `<root>/clients/claude/app-profiles/<name>/user-data`, started with
   `open -n -b com.anthropic.claudefordesktop --args --user-data-dir=<folder>`.
   The user signs in inside that window, once.
2. **AnyPick never reads, writes or moves the app's credentials.** The main
   app's data folder is not touched. Inside a profile, the only field
   decoded is the non-secret `lastKnownAccountUuid`, for a signed-in indicator;
   the token cache in the same file is not. A profile
   is not an AnyPick account and is not linked to a saved `claude` account.
3. **The folder is the record.** There is no table: the app owns the contents,
   so a row could only disagree with them. Mutations hold the
   `client-profile/claude-app/<lowercased name>` lock (ADR 0009).
4. **Opening and removal both refuse while an instance is open or starting**;
   removal then deletes the folder and signs nothing out on the server. The app
   leaves no Singleton files in its user data, unlike the Codex app, so nothing
   hands a second instance over to the first, and an open instance is found by
   `--user-data-dir` on the process list. A failed listing refuses too,
   with its own error, because nobody can tell the folder is free. Names
   differing only by case are refused: they are one folder on the default macOS
   filesystem, but two strings on the process list.
   A first launch that fails removes the folder it created, unless another
   instance may be running on it by then.
5. **`CLAUDE_CONFIG_DIR` stays unset.** The Code tab of a profile shares the
   user's `~/.claude` settings and transcripts.
6. **macOS only.** The launch path is `open(1)`, and the Tauri shell serves the
   other platforms, so it has no control for this.

## Consequences

- Several accounts can run side by side, and a damaged profile cannot affect the
  main login: removing the folder is a full recovery.
- A profile starts empty. Connectors and app settings are per profile, and
  AnyPick's backups do not include it.
- The flag and `lastKnownAccountUuid` are undocumented behavior of the app. If
  an update drops the flag, the instance would open on the main account, so the
  profile would stop being separate. If the field moves, the row reads "not
  signed in" although the window works.
- `anypick use claude` remains a Claude Code operation. The two are not
  coordinated.
