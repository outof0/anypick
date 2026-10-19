# AnyPick

**Pick any. Code on.**

AnyPick connects the AI accounts and API keys you already have to the coding
apps you use, including Claude Code, OpenAI Codex, Gemini CLI, and OpenCode.
Save your logins, choose a source for each app, and switch accounts from one
place.

AnyPick writes the app's configuration and runs a local protocol translator
when needed. Supported connections depend on the app and provider; see the
[compatibility matrix](https://github.com/outof0/anypick#supported).

## What you can do

- Save multiple AI accounts and API keys and switch between them.
- Choose a default source for each coding app or a different source per project.
- Connect supported providers through local proxies when protocols differ.
- Manage your setup from the command line or interactive terminal UI.

## Install

Requires Node.js 18 or later. Available for macOS (Apple silicon and Intel),
Linux (x64 and arm64), and Windows (x64 and arm64).

```bash
npm install --global anypick
anypick --help
```

## Get started

For example, save your current Codex login, select it for Codex, and launch:

```bash
anypick add account codex --current --name personal
anypick use codex --with codex/personal
anypick run codex
```

Read the [getting started guide](https://anypick.dev/docs/getting-started/)
for other apps, providers, and project settings.

This package installs the CLI and terminal UI. Desktop apps are available
separately from [GitHub Releases](https://github.com/outof0/anypick/releases/latest).

## How installation works

On first use, the npm launcher downloads the matching native AnyPick CLI
archive, verifies its checksum, and caches the binary locally. Later runs use
that cached binary.

Set `ANYPICK_CACHE_DIR` to choose another cache directory, or `ANYPICK_BIN` to
use a local AnyPick binary.
