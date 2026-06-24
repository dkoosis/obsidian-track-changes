.PHONY: dev build test e2e release \
        test-mobile test-android test-serious \
        ci-cross ci-all

dev:
	npm run dev

build:
	npm run build

# Standard run: pure-logic unit suite. Fast, no Obsidian.
test:
	npm test

# Desktop e2e against real Obsidian (downloads/launches it the first time).
e2e:
	npm run test:e2e

# --- Periodic serious testing (NOT part of standard CI) ---

# Desktop + desktop-Chrome-emulating-a-phone (mobile code paths, narrow
# viewport). Runs both surfaces against the same specs. No extra tooling.
test-mobile:
	npm run test:e2e:emulate

# The REAL Obsidian Android app via Appium + an Android emulator.
# Prerequisites: Android SDK + an AVD named "obsidian_test" (override with
# ANDROID_AVD=…), or point APPIUM_HOST/APPIUM_PORT at a running Appium server.
test-android:
	npm run test:e2e:android

# Everything LOCAL: unit + (desktop + emulated mobile) + real Android.
# test-mobile already covers the desktop surface, so e2e isn't repeated here.
test-serious: test test-mobile test-android

# --- On-demand cross-platform CI on GitHub (not run on every push) ---
# Standard pushes/PRs only exercise Linux. These fire a manual GitHub run.
# Requires `gh` authed against origin (dkoosis).

# Desktop on all three OSes: Linux + Windows + macOS.
ci-cross:
	gh workflow run test.yaml -f platforms=all
	@echo "triggered — watch: gh run watch \$$(gh run list -w test.yaml -L1 --json databaseId -q '.[0].databaseId')"

# The full Monty: all three desktop OSes + the real Obsidian Android app.
ci-all:
	gh workflow run test.yaml -f platforms=all -f android=true
	@echo "triggered — watch: gh run watch \$$(gh run list -w test.yaml -L1 --json databaseId -q '.[0].databaseId')"

# Tag HEAD with the version in manifest.json and push it. The push triggers
# the release workflow on GitHub, which builds, attests, and publishes.
release:
	@VERSION=$$(node -p "require('./manifest.json').version"); \
	if [ -n "$$(git status --porcelain)" ]; then \
	  echo "working tree not clean — commit or stash first" >&2; exit 1; \
	fi; \
	if git rev-parse "$$VERSION" >/dev/null 2>&1; then \
	  echo "tag $$VERSION already exists" >&2; exit 1; \
	fi; \
	echo "Pushing HEAD and tagging $$VERSION at $$(git rev-parse --short HEAD)..."; \
	git push origin HEAD && \
	git tag -a "$$VERSION" -m "Release $$VERSION" && \
	git push origin "$$VERSION"
