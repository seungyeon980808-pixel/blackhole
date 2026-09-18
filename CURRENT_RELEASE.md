# Current release baseline

Updated: 2026-09-19 KST

## Android 0.9.0 / code 25

Implemented:

- Persistent user opt-in for PTT readiness
- Best-effort sticky foreground service recreation without automatic recording
- Explicit stop disables restoration even when the service instance is absent
- System-bar inset handling for native scrolling screens
- Existing reminder, Calendar, sync, DB, WAV, and approval boundaries retained

Verified:

- Android host wiring: 45 cases / 376 assertions
- PTT lifecycle harness: 39 assertions
- System-bar inset harness: 28 assertions
- Manual Java/D8/APK pipeline and same-signature update were previously exercised with the private toolchain
- Galaxy S25 screen-off physical-button recording passed in the verified environment
- Installed operational APK SHA-256: `488e687dd9c6ec3f536a1d18e2876ef39e539913190456a8dfce864158b72025`
- Public-placeholder source rebuilt successfully on 2026-09-15; its local verification APK SHA-256 was `92135cb75de8f2e35799c226edc2915d4caa0b4285a56a22709663de30b9132f` and is not an install/update deliverable

Not guaranteed or still separate:

- Reboot and force-stop automatic microphone foreground-service recovery
- Natural long-duration Doze and OEM process reclaim
- Actual sound, vibration, and heads-up observation
- Posted-notification cleanup through a currently reachable UI path
- Network-failure recovery regression

No APK, signing material, user DB, WAV, OAuth token, or private device evidence is committed.

## Windows Desktop 0.1.1

Implemented:

- Read-only Tauri shell
- Local fixture/cache model
- 23-column Items contract
- Approval-document workspace with fixed navigation, review queue, and detail surface
- Explicit non-live data state
- Quick capture panel that writes raw Markdown to the local Google Drive sync Inbox

Verified locally:

- UI tests: 5/5
- TypeScript/Vite build
- Acceptance checks
- Major text/background contrast at least 5.26:1
- Quick capture connected/unavailable states and bounded message capture tests
- Native Tauri build with `YA_INBOX_PATH` override and Inbox write command tests

Verified in GitHub Actions:

- Rust tests
- NSIS installer build
- MSI installer build
- CI run: https://github.com/seungyeon980808-pixel/ya/actions/runs/34576134317

Installer hashes from the successful CI artifacts:

- NSIS EXE: `1c7c9ce5aaa7ea53f30dc51441e280729ad2d4e82c7a939f5aa1f432e80b0776`
- MSI: `fa920cfc9e1a924882da49fe2b1f940cde24044808bcdfd9890e2904ce4f1f6b`

Blocked:

- Actual Windows install, launch, remove, WebView2, SmartScreen, and 100/125/150% scaling checks
- Live Google read-only OAuth/cache validation
- Wiki provider selection and integration
- Android-to-Inbox capture: real OAuth configuration, Drive folder ID, and scope have not been supplied

Quick capture boundary:

- Desktop writes only raw Markdown files to the local Drive sync folder. It does not call the Google Drive API, write Wiki pages, move Inbox files, or delete processed originals.
- The default macOS discovery is `~/Library/CloudStorage/GoogleDrive-*/내 드라이브/1. 개인작업/Inbox`; set `YA_INBOX_PATH` when the local sync layout differs.

## Branch map

- `main`: older public Android baseline
- `desktop/windows-0.1.1-visibility`: Desktop 0.1.1 only
- `handoff/codex-20260915`: combined continuation baseline
