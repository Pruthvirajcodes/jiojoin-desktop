# JioJoin Desktop

Make and receive calls on your own Jio fixed-line number (JioFiber / AirFiber voice) from macOS, Windows and Linux.

Your Jio router runs a voice gateway that the JioJoin phone app talks to over your home network. This app speaks the same local protocol, so your computer becomes one more handset on the line. It only works while the computer is on the router's network, and incoming calls ring only while the app is running.

This is an independent interoperability client for a subscriber's own line. It is not made or endorsed by Jio.

![Keypad](docs/screenshots/06-keypad-light.png)

More screens are in [docs/screenshots](docs/screenshots). First-time setup is in [FIRST_RUN.md](FIRST_RUN.md).

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
- The saved sign-in is encrypted with the OS keychain through Electron `safeStorage`. The SIP password is never written to disk: it is fetched for each registration and passed to the engine over stdin.
- Log lines and the diagnostics export pass through a redactor that removes numbers, SIP users, device and instance ids, and any value registered as secret.
- Only an explicit **Request OTP** click, or a refresh for a device that was already authorised, sends the request that can make the router text a code. If the router ever answers a refresh with an OTP challenge, the app stops retrying and asks you.

## Develop

Requirements: [bun](https://bun.sh), a C toolchain, `pkg-config`, and OpenSSL 3 headers (macOS: `brew install openssl@3`; Linux also needs ALSA headers).

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
| macOS arm64 | built and tested | `.dmg`, ad-hoc signed (runs on the machine that built it) |
| Linux x64 | built and tested on Arch | AppImage |
| Windows x64 | CI workflow only, never run | NSIS installer |

The macOS engine links Homebrew's static OpenSSL, so it needs the macOS version it was built on or newer.

## Licence

GPL-3.0-or-later. The engine links PJSIP (GPL-2.0-or-later), opencore-amr and vo-amrwbenc (Apache-2.0), and OpenSSL (Apache-2.0). AMR codecs may be patent-encumbered where you live; that is yours to check before distributing builds.
