# Contributing

## Build and test

```sh
bun install
bun run engine:build
bun run typecheck
bun run test
```

`bun run test` never contacts a router (`tests/engine-sip.test.ts` runs the real engine against a local SIP gateway on `127.0.0.1`). Use `bun run demo` for UI work without a router or keychain. Requirements and packaging commands are in [docs/development.md](docs/development.md).

## Reporting issues

1. Export a diagnostics report from **Settings → Help → Export…** (or attach `logs/app.log` from the app data folder).
2. Include your OS, architecture, router model, and whether the router runs stock firmware.
3. Open an issue on [GitHub Issues](https://github.com/Pruthvirajcodes/jiojoin-desktop/issues).

**Never post real phone numbers, OTPs, MAC addresses, device IDs, SIP credentials, or unredacted packet captures.** Diagnostics exports and `app.log` are redacted automatically, but review them before posting.
