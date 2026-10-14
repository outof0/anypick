# AnyPick — one Go engine, two native front ends.
#
# Layout:
#   src/go/      the engine: CLI, terminal UI, desktop service, proxy, hub
#   src/macos/   the macOS app (SwiftUI)
#   src/tauri/   the Linux and Windows app (Tauri 2 + React)
#   docs/        the documentation site (a separate pnpm project)
#
# Start here:
#   make help          # the target list, grouped (the default goal)
#   make build         # Go CLI -> src/go/bin/anypick-dev
#   make check         # every static gate: seconds, no tool beyond Go and git
#   make review        # check + test: what CODE_REVIEW.md §4 asks for
#   make ci            # the fast half of CI locally: review + lint + test-race
#
# Naming: `make <verb>[-<scope>]`, verb first, scope last (`build-macos`,
# `test-race`, `check-protocol`). A bare verb is the repo-wide action; a scope
# narrows it to one subsystem. No aliases: a second name nobody calls still
# costs every reader of `make help`, and `make check-paths` fails when the
# target list and .PHONY disagree.
#
# Two rules this file does not restate, because AGENTS.md owns them: a target
# earns its place three ways only (automation calls it, a document tells a human
# to run it, or it is the only way to run a distinct action), and gate logic
# lives in Go under src/go/cmd/ rather than in a recipe, where it can be tested
# and cannot be disabled by a comment inside a backslash continuation.
#
# Override on the command line (all `?=`): ARGS, VERSION, PART, ROOT, and GO /
# GOFMT / STATICCHECK when a tool is not on PATH. For example
# `make run ARGS="providers"`.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Resolve the Go toolchain instead of assuming it is on PATH.
#
# On this machine it is not: ~/.zshrc exports a GOROOT and a PATH entry for a
# go@1.21 that is no longer installed, so a bare `go` dies with exit 127. That
# reads exactly like a change that broke the build, and the usual response is to
# run the gate "later" -- which is how a gate quietly stops being run.
# CODE_REVIEW.md §11.1 records this same incident as already having happened
# once, and instructs: fix the bootstrap, not the reminder.
#
# So probe the directories a Go install actually lands in, after PATH. The
# wildcard covers a toolchain fetched by `golang.org/dl`, which unpacks to
# $HOME/sdk/go<version>/bin. A command-line `make GO=...` still wins, because
# `?=` yields to it, and the literal `go` stays as the last resort so the
# go-toolchain message below still names the thing that is missing.
GO_FALLBACKS := $(HOME)/sdk/go*/bin/go /usr/local/go/bin/go /opt/homebrew/bin/go $(HOME)/go/bin/go

GO ?= $(or $(shell command -v go 2>/dev/null),$(firstword $(wildcard $(GO_FALLBACKS))),go)
export GO

# gofmt ships beside go. Derive it from whatever GO resolved to, so a machine
# where the probe found the toolchain still gets a working `make fmt-check`
# rather than a gate that fails for a reason unrelated to formatting.
GOFMT ?= $(if $(findstring /,$(GO)),$(dir $(GO))gofmt,gofmt)
# `go install` puts staticcheck in the pinned GOPATH's bin, which is not always
# on PATH.
STATICCHECK ?= $(HOME)/go/bin/staticcheck

GO_DIR := src/go
MACOS_DIR := src/macos
TAURI_DIR := src/tauri
TAURI_CORE := $(TAURI_DIR)/app
BIN := $(GO_DIR)/bin/anypick-dev

# User-overridable inputs. Command-line assignment wins over these defaults.
ARGS ?=
VERSION ?=
PART ?= patch
ROOT ?=
# Debug for everyday review; `make build-macos CONFIGURATION=Release` produces
# the optimised build the release workflow ships.
CONFIGURATION ?= Debug

# The ambient GOPATH on a developer machine here points at another project's
# module cache, and a shared cache makes anything that shells out to `go build`
# stall in module resolution for minutes (AGENTS.md). It is exported rather than
# passed per command because two builds spawn `go` indirectly: Xcode runs
# src/macos/scripts/bundle-go-helper.sh, and `cargo tauri build` runs
# src/tauri/app/build.rs. Not `?=`: the ambient value is the wrong one.
GOPATH := $(HOME)/go
export GOPATH

.PHONY: help go-toolchain build run sandbox test test-race readme-supported vet fmt fmt-check lint \
        check review ci check-paths check-protocol check-actions check-release check-artifact hooks \
        plan-release set-version bump-version \
        open-macos build-macos test-macos test-macos-ui verify-macos run-macos-dev install-macos \
        install-tauri build-tauri-ui typecheck-tauri-ui test-tauri-ui \
        check-tauri-ui build-tauri run-tauri check-parity screenshots-tauri-ui \
        build-docs check-docs clean

##@ General

help: ## Show this help, grouped by area
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z0-9_.-]+:.*?##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)
	@echo ""

##@ Go engine

# Prerequisite of every target that shells out to Go, so a machine without one
# fails with the fix instead of a bare 127 — which reads exactly like a change
# that broke the build, and the usual response to that is to run the gate
# "later" (CODE_REVIEW.md §1).
go-toolchain:
	@command -v $(GO) >/dev/null 2>&1 || { \
	  echo "go not found on PATH."; \
	  echo "install: https://go.dev/dl"; \
	  echo "or point at one you already have: make GO=/path/to/go/bin/go <target>"; \
	  exit 1; }

build: go-toolchain ## Build the CLI into src/go/bin/anypick-dev
	cd $(GO_DIR) && $(GO) build -o bin/anypick-dev ./cmd/anypick

run: build ## Build, then run a command: make run ARGS="providers"
	$(BIN) $(ARGS)

sandbox: build ## Same, against a throwaway HOME + ANYPICK_HOME
	@HOME=$${TMPDIR:-/tmp}/anypick-sandbox/home \
	 ANYPICK_HOME=$${TMPDIR:-/tmp}/anypick-sandbox/data \
	 sh -c 'mkdir -p "$$HOME" "$$ANYPICK_HOME"; exec $(BIN) $(ARGS)'

test: go-toolchain ## Run the Go suite
	cd $(GO_DIR) && $(GO) test ./... -count=1 -timeout 900s

test-race: go-toolchain ## Run the Go suite under the race detector
	cd $(GO_DIR) && $(GO) test -race ./... -count=1 -timeout 900s

# README's Supported table is generated from the provider and client registries;
# internal/docsync's test fails in `make test` when the two drift.
readme-supported: go-toolchain ## Regenerate README's Supported table from the registries
	cd $(GO_DIR) && ANYPICK_UPDATE_README=1 $(GO) test ./internal/docsync -run TestReadmeSupportedMatchesRegistry -count=1

vet: go-toolchain ## go vet over the engine
	cd $(GO_DIR) && $(GO) vet ./...

fmt: go-toolchain ## Rewrite Go sources with gofmt
	cd $(GO_DIR) && $(GOFMT) -w .

fmt-check: go-toolchain ## Fail if any Go source is not gofmt-clean
	cd $(GO_DIR) && test -z "$$($(GOFMT) -l .)" || { $(GOFMT) -l .; exit 1; }

# `go vet` is the floor, not the ceiling. This fails when the tool is absent
# rather than skipping: a gate that quietly does nothing is worse than no gate,
# because the next person reads "lint: ok" and stops looking.
lint: go-toolchain ## staticcheck over the engine (CODE_REVIEW.md §4)
	@test -x "$(STATICCHECK)" || { \
	  echo "staticcheck not found at $(STATICCHECK)."; \
	  echo "install: go install honnef.co/go/tools/cmd/staticcheck@v0.8.1"; \
	  exit 1; }
	cd $(GO_DIR) && "$(STATICCHECK)" ./...

##@ Gates

# check is the fast floor: every gate that needs nothing beyond Go and git, so
# it can run on every iteration and in the pre-push hook. `lint` is deliberately
# not part of it — it needs a tool this machine may not have — and CI installs
# that tool before running it.
check: fmt-check vet check-paths check-protocol check-actions check-release ## Every static gate that needs only Go and git

# review is CODE_REVIEW.md §4: the static gates plus the test suite, in one
# command. It is what "I reviewed this change" means in this repository.
review: check test ## CODE_REVIEW.md §4: the static gates plus the test suite

# ci is the fast half of CI: CI also builds the apps, the Tauri UI and the docs
# site, which need Xcode, cargo and node. This is what can run anywhere.
ci: review lint test-race ## Fast half of CI locally: review + lint + race (CI also builds the apps and docs)
	@echo "ci gates green."

# The rules live in internal/repocheck, next to the code they check, with tests
# that drive each one with a deliberate break — including the incident that put
# them there (see that package's doc comment). Recipes here stay thin.

check-paths: go-toolchain ## Every cross-file reference resolves (scripts, Xcode, Tauri, CI, docs, git)
	cd $(GO_DIR) && $(GO) run ./cmd/anypick-repocheck paths

# The desktop stdio protocol version is declared once per language. Nothing
# links them, so bumping one and missing the others produces an app that refuses
# its own handshake at runtime while every test stays green — Go only ever
# agrees with itself. See internal/repocheck/protocol.go.
check-protocol: go-toolchain ## All four front ends declare the same protocol version
	cd $(GO_DIR) && $(GO) run ./cmd/anypick-repocheck protocol

check-actions: go-toolchain ## Every workflow action is pinned to a full SHA with a version comment
	cd $(GO_DIR) && $(GO) run ./cmd/anypick-repocheck actions

check-release: go-toolchain ## Every version source agrees with VERSION
	cd $(GO_DIR) && $(GO) run ./cmd/anypick-release check

check-artifact: go-toolchain ## ADR 0020 §8: a built artifact contains no Node runtime
	cd $(GO_DIR) && $(GO) run ./cmd/anypick-artifact node-free $(ROOT)

# Point core.hooksPath at the tracked .githooks/ directory. The hooks enforce
# CODE_REVIEW.md §4 (Conventional Commits) and §7 (risk class, plus an
# independent reviewer for High/Architectural) at commit time — which is the
# only point they can fire here, because this repository pushes straight to main
# and the PR-shaped machinery in .github/ therefore never executes. One command
# per clone, idempotent. Verify with `sh .githooks/test.sh`.
hooks: ## Install the tracked local review gates (.githooks/) into this clone
	@sh .githooks/install.sh

##@ Release

plan-release: go-toolchain ## Print the release the Conventional Commits imply
	cd $(GO_DIR) && $(GO) run ./cmd/anypick-release plan

set-version: go-toolchain ## Set every version source: make set-version VERSION=1.2.3
	cd $(GO_DIR) && $(GO) run ./cmd/anypick-release set $(VERSION)

bump-version: go-toolchain ## Bump every version source: make bump-version PART=major|minor|patch
	cd $(GO_DIR) && $(GO) run ./cmd/anypick-release bump $(PART)

##@ macOS app

open-macos: ## Open the Xcode project
	open $(MACOS_DIR)/AnyPick.xcodeproj

build-macos: ## Build the app unsigned; a build phase bundles the Go helper
	xcodebuild -project $(MACOS_DIR)/AnyPick.xcodeproj -scheme AnyPick \
	  -configuration $(CONFIGURATION) \
	  -destination platform=macOS CODE_SIGNING_ALLOWED=NO build

test-macos: ## Build and unit-test the app and the bundled helper contract
	xcodebuild -project $(MACOS_DIR)/AnyPick.xcodeproj -scheme AnyPick \
	  -destination platform=macOS CODE_SIGNING_ALLOWED=NO test

# XCUITest over the fixture: the ship-acceptance flows through the real
# UI (welcome + checklist, tray first run, empty Accounts -> Add Login).
# Not in test-macos: macOS UI tests need Developer Mode
# (`sudo DevToolsSecurity -enable`) and an Accessibility grant on this Mac.
# CI runs it in the non-blocking `macos-ui` job.
test-macos-ui: ## Drive the onboarding, tray first-run, and add-account flows (XCUITest, fixture)
	xcodebuild -project $(MACOS_DIR)/AnyPick.xcodeproj -scheme AnyPickUITests \
	  -destination platform=macOS CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual \
	  DEVELOPMENT_TEAM= test

verify-macos: build-macos go-toolchain ## Build, then assert ADR 0020 on the built bundle
	@derived="$${DERIVED_DATA_DIR:-$$HOME/Library/Developer/Xcode/DerivedData}"; \
	app="$$(find "$$derived" -type f -path '*/Build/Products/Debug/AnyPick.app/Contents/MacOS/AnyPick' \
	  -exec stat -f '%m %N' {} + | sort -nr | head -n 1 | sed 's/^[0-9]* //')"; \
	app="$${app%/Contents/MacOS/AnyPick}"; \
	test -n "$$app" || { echo "no AnyPick.app under $$derived"; exit 1; }; \
	cd $(GO_DIR) && $(GO) run ./cmd/anypick-artifact node-free "$$app"

# A dev build and the release install share a name and an icon, so opening the
# wrong one is indistinguishable from "my change did nothing" — which is how a
# review came back with the old UI on screen. This installs the build under its
# own bundle id and label and runs it on fixture data, so the surface with the
# change in it is always the one named "AnyPick Dev". The release copy in
# /Applications is never touched.
MACOS_DEV_APP := $(HOME)/Applications/AnyPick Dev.app

run-macos-dev: build-macos ## Build, install as "AnyPick Dev", and run it on fixture data
	@built="$$(find $${DERIVED_DATA_DIR:-$$HOME/Library/Developer/Xcode/DerivedData} \
	  -type f -path '*/Build/Products/Debug/AnyPick.app/Contents/MacOS/AnyPick' \
	  -exec stat -f '%m %N' {} + | sort -nr | head -n 1 | sed 's/^[0-9]* //')"; \
	built="$${built%/Contents/MacOS/AnyPick}"; \
	test -n "$$built" || { echo "no AnyPick.app built; run make build-macos first"; exit 1; }; \
	rm -rf "$(MACOS_DEV_APP)"; \
	cp -R "$$built" "$(MACOS_DEV_APP)"; \
	/usr/libexec/PlistBuddy \
	  -c "Set :CFBundleDisplayName AnyPick Dev" \
	  -c "Set :CFBundleName AnyPick Dev" \
	  -c "Set :CFBundleIdentifier dev.anypick.app.dev" \
	  "$(MACOS_DEV_APP)/Contents/Info.plist"; \
	pkill -f "AnyPick Dev.app/Contents/MacOS" 2>/dev/null || true; \
	open -n --env ANYPICK_MACOS_FIXTURE=ready "$(MACOS_DEV_APP)"; \
	echo "running $(MACOS_DEV_APP) (fixture data; the release app is untouched)"

# The review path is `run-macos-dev`; this is the other loop — putting the build
# into the app you actually launch. It keeps the previous bundle beside it, so
# the install is reversible, and it restarts the app because the running process
# keeps the code it started with.
MACOS_INSTALLED_APP ?= /Applications/AnyPick.app

install-macos: ## Build Release, replace the installed app, restart it (keeps the old bundle)
	@$(MAKE) --no-print-directory build-macos CONFIGURATION=Release
	@set -e; \
	built="$$(find $${DERIVED_DATA_DIR:-$$HOME/Library/Developer/Xcode/DerivedData} \
	  -type f -path '*/Build/Products/Release/AnyPick.app/Contents/MacOS/AnyPick' \
	  -exec stat -f '%m %N' {} + | sort -nr | head -n 1 | sed 's/^[0-9]* //')"; \
	built="$${built%/Contents/MacOS/AnyPick}"; \
	test -n "$$built" || { echo "no Release AnyPick.app built"; exit 1; }; \
	if [ -d "$(MACOS_INSTALLED_APP)" ]; then \
	  backup="$$HOME/Library/Application Support/anypick-installed-backup/AnyPick-$$(date +%Y%m%d-%H%M%S).app"; \
	  mkdir -p "$$(dirname "$$backup")"; \
	  cp -R "$(MACOS_INSTALLED_APP)" "$$backup"; \
	  test -d "$$backup/Contents/MacOS" || { echo "backup incomplete: $$backup"; exit 1; }; \
	  echo "previous install kept at $$backup"; \
	else \
	  echo "nothing installed at $(MACOS_INSTALLED_APP) to back up"; \
	fi; \
	pkill -f "$(MACOS_INSTALLED_APP)/Contents/MacOS" 2>/dev/null || true; \
	for _ in $$(seq 1 30); do pgrep -f "$(MACOS_INSTALLED_APP)/Contents/MacOS" >/dev/null || break; sleep 0.5; done; \
	rm -rf "$(MACOS_INSTALLED_APP)"; \
	cp -R "$$built" "$(MACOS_INSTALLED_APP)"; \
	open "$(MACOS_INSTALLED_APP)"; \
	echo "installed and restarted $(MACOS_INSTALLED_APP)"

##@ Tauri app (Linux / Windows)

# `npm ci` (not `npm install`) so the UI build is reproducible from
# package-lock.json — the same command CI runs.
install-tauri: ## Install the Tauri UI dependencies from the lockfile
	cd $(TAURI_DIR)/ui && npm ci

build-tauri-ui: ## Build the UI bundle into src/tauri/frontend
	cd $(TAURI_DIR)/ui && npm run build

# The visual-parity harness. Renders every destination and dialog from the
# fixture with the real built CSS, so a styling regression is an image rather
# than something to remember. Not a gate: jsdom cannot rasterize, so a diff
# needs Playwright and a real browser.
screenshots-tauri-ui: build-tauri-ui ## Screenshot every pane and dialog to src/tauri/ui/.screenshots
	cd $(TAURI_DIR)/ui && npm run screenshot

typecheck-tauri-ui: ## Typecheck the UI without emitting output
	cd $(TAURI_DIR)/ui && npm run typecheck

test-tauri-ui: ## Run the desktop UI tests (jsdom, no webview needed)
	cd $(TAURI_DIR)/ui && npm run test

check-tauri-ui: typecheck-tauri-ui test-tauri-ui ## Typecheck and test the desktop UI

# ADR 0020 §parity: the macOS app names every control with an
# accessibilityIdentifier and test/parity-map.ts maps each one to its Tauri
# counterpart. That map is the only machine-checkable statement of "the port
# is done", so it gets its own target rather than hiding in the vitest run.
check-parity: ## Report which macOS features have no Tauri counterpart
	cd $(TAURI_DIR)/ui && npm run test -- test/parity.test.ts --reporter=verbose

build-tauri: build-tauri-ui ## Build the packaged desktop app for this platform
	cd $(TAURI_CORE) && cargo tauri build

run-tauri: ## Run the desktop app against the real Go service
	cd $(TAURI_DIR)/ui && npm run build
	cd $(TAURI_CORE) && cargo tauri dev

##@ Docs site (separate pnpm project)

build-docs: ## Build the docs site into docs/dist/
	cd docs && pnpm build

check-docs: ## Typecheck + lint the docs site (astro check, nimbus-docs lint)
	cd docs && pnpm typecheck
	cd docs && pnpm lint:docs

##@ Cleanup

clean: ## Remove generated output (CLI binary, docs build, Tauri UI bundle)
	rm -rf $(GO_DIR)/bin docs/dist $(TAURI_DIR)/frontend
