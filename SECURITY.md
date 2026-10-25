# Security and public-repository policy

This repository is public. Production configuration and personal data must remain outside Git.

## Never commit

- `*.jks`, `*.keystore`, private keys, signing passwords, or replacement signing material
- OAuth access/refresh tokens, authorization codes, PKCE verifiers, cookies, or client secrets
- Production account email, spreadsheet/document IDs, deployed Apps Script URLs, or private redirect configuration
- WAV/audio, transcripts containing personal content, SQLite DB/WAL/SHM files, backups, or migration snapshots
- Raw Logcat, UI hierarchy XML, personal screenshots, device serials, or personal filesystem paths
- Generated APK/MSI/EXE artifacts

OAuth client IDs are not passwords, but this project treats operating Google identifiers as private configuration and keeps placeholders in the public branch.

## Public placeholders

The checked-in source must retain values such as:

- `YOUR_GOOGLE_OAUTH_CLIENT_ID`
- `YOUR_SPREADSHEET_ID`
- `owner@example.invalid`
- `https://example.invalid/blackhole/privacy`

A local configured copy may replace them, but that copy must not be committed.

## LLM Wiki boundary

The initial Wiki integration is read-only. It may retrieve explicitly approved Wiki pages and cache non-sensitive article metadata locally. It must not upload recordings, transcripts, databases, tokens, logs, screenshots, or unapproved record content. Every result must show provider, connection state, and cache freshness.

## Pre-push checks

At minimum:

```sh
git diff --check
git status --short
git ls-files | grep -Ei '\.(jks|keystore|p12|pem|wav|mp3|m4a|db|sqlite|apk|msi|exe|log)$' && exit 1 || true
git grep -nEi '(access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization: bearer|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)'
```

Review every match. Source symbols that implement token handling are expected; literal credentials are not.
