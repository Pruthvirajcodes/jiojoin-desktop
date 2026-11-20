# Development

## Requirements

All platforms need [bun](https://bun.sh), a C toolchain, `make`, `perl` and `pkg-config`.

- **macOS**: Xcode Command Line Tools and `pkg-config` (`brew install pkg-config`). Builds target `MACOSX_DEPLOYMENT_TARGET=12.0` by default.
- **Linux**: `build-essential`, `pkg-config` and ALSA headers (e.g. `libasound2-dev`).
- **Windows**: MSYS2 (`MINGW64`) with `base-devel`, `patch`, `tar`, `perl`, `mingw-w64-x86_64-gcc` and `mingw-w64-x86_64-pkgconf`. Run `bash engine/scripts/build-engine.sh` from a MINGW64 shell.

## Commands

```sh
bun install
bun run engine:build     # builds PJSIP, codecs and OpenSSL once, then the C engine
bun run dev              # real app against your router
bun run demo             # simulated router and calls, no network, for UI work
bun run test             # unit tests plus engine SIP tests on loopback
bun run typecheck        # tsc on main and renderer configs
bun run build            # production electron-vite bundle
bun run screenshots      # after `bun run build`: recapture docs/screenshots
bun run package:mac      # macOS arm64 .dmg -> dist/
bun run package:linux    # Linux x64 AppImage -> dist/
bun run package:win      # Windows x64 NSIS installer -> dist/
```

Other engine scripts:

- `bun run engine:deps` — build native dependencies only (`bash engine/scripts/build-deps.sh --force` to rebuild from scratch). Set `JOBS=N` to control parallelism.
- `bun run engine:smoke` — quick smoke test of the compiled engine binary.

## Engine build

The first `bun run engine:build` downloads and compiles pinned, SHA-256-verified releases into `engine/.cache` and `engine/.deps/<target>`, taking several minutes:

- PJSIP 2.17
- opencore-amr 0.1.6 (AMR-NB codec, AMR-WB decoder)
- vo-amrwbenc 0.1.3 (AMR-WB encoder)
- OpenSSL 3.5.9 LTS (every platform)

The compiled binary lands at `engine/dist/<platform>-<arch>/jiojoin-engine` (`.exe` on Windows). Set `JIOJOIN_ENGINE_PATH` to point the app at another binary.

OpenSSL and the codecs are linked statically on every platform, so the engine needs nothing from the host beyond the C library, ALSA on Linux, and standard system DLLs on Windows. CI (`.github/workflows/build.yml`) checks that no Homebrew, system `libssl`/`libcrypto`, or MinGW runtime DLL dependencies leak into the binary.

`engine/patches/pjproject-2.17-jio.patch` is the only patch to PJSIP: it stops `pjsua` from appending a duplicate `+sip.instance` parameter on `REGISTER` once the engine puts that parameter on every `Contact`.

## Tests and demo mode

- `bun run test` never contacts a real router. `tests/engine-sip.test.ts` runs the real compiled engine against a local SIP gateway on `127.0.0.1` and checks the messages it sends.
- `bun run demo` simulates the router and calls with an in-memory vault and a separate data folder (`JioJoin Desktop Demo`), so it never touches a real sign-in or keychain.

## Layout

| Path | Role |
| --- | --- |
| `src/renderer` | React, Tailwind and shadcn/ui frontend; no Node or network access. |
| `src/preload` | Fixed IPC bridge between renderer and main. |
| `src/main` | Electron main process: discovery, provisioning, line state machine, calls, vault, tray and windows. |
| `src/shared` | Shared types, dial-string formatting and log redaction. |
| `engine/` | C calling sidecar (`engine/src/engine.c`), dependency scripts and PJSIP patch. |
| `tests/` | Vitest unit tests and loopback SIP tests. |

## Platform status

| Platform | Engine | App package |
| --- | --- | --- |
| macOS arm64 | Built and tested | `.dmg`, ad-hoc signed, not notarised; macOS 12+ |
| Linux x64 | Built and tested on Arch | AppImage, built on Ubuntu 22.04 for older glibc compatibility |
| Windows x64 | Built in CI, never run | NSIS installer (`.exe`) |

After rebuilding locally on macOS, Keychain may prompt once for your login password so the new ad-hoc binary can read the saved sign-in; choose **Always Allow**.

Pushing a `v*` tag triggers `.github/workflows/build.yml` to build, test and publish all three installers to GitHub Releases.
