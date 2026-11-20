# JioJoin Desktop

Make and receive calls on your own Jio fixed-line number (JioFiber / AirFiber voice) from macOS, Windows and Linux.

Your Jio router runs a voice gateway that the JioJoin phone app talks to over your home network. This app speaks the same local protocol, so your computer becomes one more handset on the line. It only works while the computer is on the router's network, and incoming calls ring only while the app is running.

This is an independent interoperability client for a subscriber's own line. It is not made or endorsed by Jio.

![Keypad](docs/screenshots/06-keypad-light.png)

More screens are in [docs/screenshots](docs/screenshots). First-time setup is in [FIRST_RUN.md](FIRST_RUN.md).

**Status: beta, for people comfortable with an unsigned app and a log file.** It has been used on a JioFiber/AirFiber line on macOS and Linux. Windows builds are produced but have never been run.

## Install

Download the build for your system from [Releases](../../releases). None of them are code-signed or notarised.

- **macOS** (Apple silicon, macOS 12 or newer): open the `.dmg` and drag the app to Applications. The first time, right-click the app and choose **Open**, or run `xattr -dr com.apple.quarantine "/Applications/JioJoin Desktop.app"`.
- **Linux** (x64): `chmod +x jiojoin-desktop-*.AppImage` and run it. The sign-in is kept in your Secret Service keyring (GNOME Keyring, KWallet) when one is running.
- **Windows** (x64, untested): run the installer; SmartScreen will ask you to confirm under **More info**.

Then follow [FIRST_RUN.md](FIRST_RUN.md). How the app and the router work is in [docs/how-jiojoin-works.md](docs/how-jiojoin-works.md) and [docs/jio-firmware-and-calling.md](docs/jio-firmware-and-calling.md).

## How it is built

```
React UI (renderer)  ──IPC──  Electron main  ──JSON lines over stdio──  engine (PJSIP, C)
                               │                                         │
                               └─ HTTPS :8443 ─────────  router  ───── SIP/TLS :5068, RTP
```

- **Renderer** (`src/renderer`): React, Tailwind and shadcn/ui. It renders one state snapshot pushed from the main process and calls a fixed list of methods through the preload bridge. It has no network or Node access.
- **Main** (`src/main`): finds the router, fetches the line's SIP account, runs the registration state machine with backoff, and owns call state, history, tray and windows.
- **Engine** (`engine/`): a small C program on PJSIP 2.17 with OpenSSL TLS and the AMR-NB / AMR-WB codecs. The main process spawns it and exchanges one JSON message per line. A native crash cannot take the app down, and restarting the process is a complete reset.

### What the router needs

| Step | Detail |
| --- | --- |
| Discovery | Resolve `jiofiber.local.html`; fall back to the default gateway while still sending that host name. A manual address can be set in Settings. |
| Sign-in | HTTPS on port 8443, a GSMA RCS auto-configuration style query. A new device is confirmed with an OTP texted to the line's registered mobile. Credentials are refreshed before every registration. |
| SIP | TLS to port 5068 as outbound proxy, digest auth, RFC 5626 with the router's bare-UUID `+sip.instance`, IMS feature tags, and `P-Access-Network-Info` on every request. |
| Media | AMR-WB, then AMR-NB, then PCMU. Octet-aligned AMR with a mode-set. RTP from port 52000 on the LAN address. |

`engine/patches/pjproject-2.17-jio.patch` is the only change to PJSIP: it stops a duplicate `+sip.instance` on REGISTER once the engine puts that parameter on every Contact.

### Security notes

- The router's certificate is self-signed and its private key ships in every firmware image, so TLS to the router gives confidentiality on the LAN, not authentication. The app accepts it only for a private IPv4 address, only on those two ports, and only when the certificate names `jiofiber.local.html`. Nothing is sent before that check, and no global TLS setting is changed.
- The saved sign-in (the device ID the router whitelists, the device name and the line's number) is encrypted with the OS keychain through Electron `safeStorage`. Where no keychain is usable it is kept in a file only the user can read, because losing the device ID costs the owner a text and another device its place on the line. The SIP password is never written to disk: it is fetched for each registration and passed to the engine over stdin.
- Log lines and the diagnostics export pass through a redactor that removes numbers, SIP users, device and instance ids, and any value registered as secret.
- Only an explicit **Request OTP** click sends the request that can make the router text a code. Refreshes use the plain request, which can't. If the router no longer recognises the device, the app stops retrying and asks you.
- The router keeps a short whitelist (6 devices on the lines we've seen) and silently drops the oldest when a new device is added. The app keeps its device ID across restarts and sign-out so it never takes a second slot.

## Develop

Requirements: [bun](https://bun.sh), a C toolchain, `make`, `perl` and `pkg-config` (Linux also needs ALSA headers, for example `libasound2-dev`). The first engine build downloads and compiles pinned, checksummed releases of PJSIP, the AMR codecs and OpenSSL, which takes several minutes.

```sh
bun install
bun run engine:build     # builds PJSIP and the codecs once, then the engine
bun run dev              # the real app against your router
bun run demo             # simulated router and calls, no network, for UI work
bun run test             # unit tests plus engine tests on loopback
bun run typecheck
bun run screenshots      # after `bun run build`: recapture docs/screenshots
bun run package:mac      # or package:linux, package:win
```

The tests never contact a router. `tests/engine-sip.test.ts` runs the real engine against a SIP gateway on `127.0.0.1` and checks the messages it sends.

## Platform status

| Platform | Engine | App package |
| --- | --- | --- |
| macOS arm64 | built and tested | `.dmg`, ad-hoc signed, not notarised; macOS 12 or newer |
| Linux x64 | built and tested on Arch | AppImage, built on Ubuntu 22.04 so it runs on older distributions |
| Windows x64 | built in CI, never run | NSIS installer |

The engine links OpenSSL statically on every platform, so it needs nothing from the system beyond the C library and, on Linux, ALSA.

## Licence

GPL-3.0-or-later. The engine links PJSIP (GPL-2.0-or-later), opencore-amr and vo-amrwbenc (Apache-2.0), and OpenSSL (Apache-2.0). AMR codecs may be patent-encumbered where you live; that is yours to check before distributing builds.
