# Blackhole agent rules

Read these files before changing code:

1. `CODEX_HANDOFF.md`
2. `CURRENT_RELEASE.md`
3. `README.md`
4. `desktop/DESIGN.md` for Desktop UI work

## Hard safety boundaries

- Never delete the Android app, clear app data, change the package name, rotate signing keys, reboot the device, or change its PIN as part of development.
- Preserve `com.malhaedwo.pttprobe`, DB compatibility, WAV originals, OAuth continuity, and update signing.
- The approved record is the source of truth. Calendar entries and reminders are derived outputs. Do not create them before approval.
- Do not commit a keystore, password, OAuth token/code/verifier, production Google identifier, WAV, DB, backup, screenshot containing personal records, raw device log, or personal filesystem path.
- Keep public configuration placeholders intact. Real configuration belongs outside this repository.
- Desktop and future Wiki integrations start read-only. Never imply fixture or cached data is live.
- Do not change the chosen product design or personal records without explicit approval.
- Do not claim reboot, force-stop, natural Doze, sound, vibration, heads-up, Windows installation, or live OAuth is verified unless new direct evidence exists.

## Engineering workflow

- Make one bounded change at a time with an explicit completion condition.
- Inspect existing behavior before editing. Prefer the smallest implementation that preserves data contracts.
- Run the relevant tests and report exact commands and results.
- Keep installers and generated build output in CI artifacts, not Git.
- Before pushing, inspect `git diff --check`, tracked filenames, and sensitive-value patterns.

## Required checks

Android host checks:

```sh
bash tests/wiring/run.sh
bash tests/insets/run.sh
bash tests/ptt/run.sh
```

Desktop checks:

```sh
cd desktop
npm ci
npm test
npm run build
npm run acceptance
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

The Android APK build additionally requires the private toolchain and original signing material described in `README.md`. Do not create or substitute a signing key.
