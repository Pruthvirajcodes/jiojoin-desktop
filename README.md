<div align="center">
  <img src="build/icon.png" width="120" alt="JioJoin Desktop">
  <h1>JioJoin Desktop</h1>
  <p>
    Make and receive calls on your Jio fixed line (JioFiber / AirFiber voice) from your computer.<br>
    Talks directly to the voice gateway on your Jio router over the LAN. Beta: used on macOS and Linux; Windows builds exist but have never been run.
  </p>
  <h3><a href="https://github.com/Pruthvirajcodes/jiojoin-desktop/releases/latest">Download the latest release</a></h3>
  <p>
    macOS 12+ · Apple silicon · not notarised<br>
    Linux x64 AppImage · Secret Service keyring<br>
    Windows x64 installer · untested
  </p>
  <p>
    <a href="FIRST_RUN.md">First run</a> ·
    <a href="docs/how-jiojoin-works.md">How it works</a> ·
    <a href="docs/development.md">Development</a> ·
    <a href="https://github.com/Pruthvirajcodes/jiojoin-desktop/releases">All releases</a>
  </p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/06-keypad-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/06-keypad-light.png">
    <img src="docs/screenshots/06-keypad-light.png" width="760" alt="JioJoin Desktop keypad">
  </picture>
</div>

## Install

Download from [Releases](https://github.com/Pruthvirajcodes/jiojoin-desktop/releases/latest). Builds are not signed or notarised.

- **macOS** (Apple silicon, macOS 12+): open the `.dmg` and drag the app to Applications. First launch: right-click → **Open**, or run `xattr -dr com.apple.quarantine "/Applications/JioJoin Desktop.app"`.
- **Linux** (x64): `chmod +x jiojoin-desktop-*.AppImage` and run it. Sign-in is kept in the Secret Service keyring (GNOME Keyring, KWallet) when one is running.
- **Windows** (x64, untested): run the installer and confirm under SmartScreen → **More info**.

Follow [FIRST_RUN.md](FIRST_RUN.md) to set up the line and place a test call. Calls work only on the router's network, and incoming calls ring only while the app is running.

**Device limit:** the router keeps a short whitelist of calling devices (6 on lines seen so far, counting Jio's own apps) and silently drops the oldest when a new one is added. The app never requests an OTP on its own, and keeps its device ID across restarts and sign-out so it does not take a second slot.

## Build from source

```sh
bun install
bun run engine:build
bun run dev
```

Prerequisites, tests, packaging and platform status are in [docs/development.md](docs/development.md).

## Licence

GPL-3.0-or-later. The engine links PJSIP (GPL-2.0-or-later), opencore-amr and vo-amrwbenc (Apache-2.0), and OpenSSL (Apache-2.0). AMR codecs may be patent-encumbered where you live; check before distributing builds.

## Reading

- [FIRST_RUN.md](FIRST_RUN.md) — First-time setup, test call and troubleshooting.
- [docs/how-jiojoin-works.md](docs/how-jiojoin-works.md) — Architecture, router protocol, SIP, audio, recovery and security model.
- [docs/development.md](docs/development.md) — Build prerequisites, dev/test/packaging commands, engine deps and platform status.
- [CONTRIBUTING.md](CONTRIBUTING.md) — Running tests and filing issues safely with redacted diagnostics.
- [docs/jio-firmware-and-calling.md](docs/jio-firmware-and-calling.md) — How the Jio router's voice gateway works (observed on a JIDU6911).
- [docs/openwrt-on-jidu6911.md](docs/openwrt-on-jidu6911.md) — Field report: OpenWrt with Jio calling kept working on a JIDU6911.
- [docs/screenshots](docs/screenshots) — Light and dark UI screenshots.
