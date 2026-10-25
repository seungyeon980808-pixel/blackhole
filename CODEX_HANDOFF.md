# Codex handoff

Updated: 2026-09-15 KST

## Start here

Use branch `handoff/codex-20260915`. It combines the public-safe Android 0.9.0 source and the Windows Desktop 0.1.1 source in one working tree.

```sh
git clone https://github.com/seungyeon980808-pixel/blackhole.git
cd blackhole
git switch --track origin/handoff/codex-20260915
```

This branch is the continuation baseline. Do not start from `main`, which remains at the older public Android snapshot, or from `desktop/windows-0.1.1-visibility`, which does not contain Android 0.9.0.

## Current product boundaries

### Android

- Package: `com.malhaedwo.pttprobe`
- Version: 0.9.0 / code 25
- Manual Java/D8 build, minSdk 31, targetSdk 35
- Persistent PTT is opt-in. Explicit stop disables automatic restoration.
- Foreground-service recreation is best effort. Reboot and force-stop restoration are not guaranteed.
- Approval records are authoritative. Notifications and Calendar records are derived only after approval.
- Existing DB, WAV, OAuth state, and signing continuity must be preserved.

The 0.9.0 public-safe snapshot was imported from the verified local implementation commit `e20fd29`, without its private Git history, production configuration, device logs, or user-data evidence.

### Windows Desktop

- Version: 0.1.1
- Tauri 2 + Vanilla TypeScript + Vite
- Current function: read-only approval-document workspace using fixture/local cache contracts
- Google OAuth and live records are intentionally not connected
- The UI must visibly distinguish fixture, cached, and future connected states
- Windows CI produced NSIS and MSI installers; actual Windows install/remove/WebView2/scaling checks remain open

Relevant files:

- `desktop/src/domain.ts`: shared item model and 23-column contract
- `desktop/src/bridge.ts`: Tauri/web boundary
- `desktop/src/fixtures.ts`: non-production sample data
- `desktop/src/ui.ts`: view rendering
- `desktop/src/styles.css`: visual system
- `desktop/src-tauri/src/`: cache and command layer
- `desktop/DESIGN.md`: approved design principles

## Next proposed milestone: LLM Wiki read-only context

The Wiki provider is not selected yet. Confirm the exact service and API before implementation.

### First vertical slice

1. Add a provider-neutral `WikiSource` interface under `desktop/src/wiki/`.
2. Implement a fixture source and local cache before any network connection.
3. Add read-only article search and article retrieval.
4. Show related Wiki context in the item detail area, not as a new generic dashboard.
5. Display connection state and cache freshness beside every result.
6. Link from a result to its canonical Wiki page.
7. Add unit tests for offline, stale-cache, empty, and provider-error states.

Suggested states:

- `fixture`
- `cached`
- `connected-read-only`
- `error`

### Data boundary

Allowed inputs:

- Explicitly approved public or team Wiki pages
- Search text intentionally entered by the user
- Non-sensitive item categories or tags after approval

Forbidden inputs:

- WAV or transcript originals without explicit approval
- SQLite DB or backups
- OAuth tokens, authorization codes, PKCE verifiers, cookies, or signing data
- Raw device logs or screenshots containing personal records
- Automatic Wiki writes, edits, or publication in the first milestone

### Completion condition

The first Wiki milestone is complete only when fixture and cache modes work offline, every result shows provenance/state/freshness, no writes are possible, tests cover error states, and a sensitive-data scan is clean.

## Design workflow

The user rejected generic template-like concepts. Do not begin with a polish-only pass because that preserves the incumbent frame.

1. Read `desktop/DESIGN.md` and the real information architecture.
2. Produce three structurally different visual directions before implementation.
3. Keep motion low and information density appropriate for a document-review desktop app.
4. Wait for explicit direction selection.
5. Implement one selected direction, then audit accessibility, keyboard operation, scaling, and empty/error states.

## Verification commands

```sh
bash tests/wiring/run.sh
bash tests/insets/run.sh
bash tests/ptt/run.sh

cd desktop
npm ci
npm test
npm run build
npm run acceptance
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

See `CURRENT_RELEASE.md` for what has and has not been verified. Do not convert a blocked gate into a passing claim.
