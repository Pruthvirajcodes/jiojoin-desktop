# How JioJoin Desktop works

This document explains how JioJoin Desktop finds your Jio router, gets permission to use your fixed line, registers, places and receives calls, recovers from problems, and keeps your line's credentials safe. It describes the app's behaviour and the router's local interface as seen from the outside. It contains no account data.

## The pieces

```
┌──────────────┐  IPC (fixed method list)  ┌──────────────────┐  JSON lines over stdio  ┌──────────────────┐
│ Renderer     │ ────────────────────────▶ │ Electron main    │ ──────────────────────▶ │ Engine (C, PJSIP)│
│ React UI     │ ◀──── state snapshots ─── │ process          │ ◀────── events ──────── │ SIP, TLS, audio  │
└──────────────┘                           └────────┬─────────┘                         └────────┬─────────┘
                                                    │ HTTPS :8443                                │ SIP/TLS :5068, RTP
                                                    ▼                                            ▼
                                           ┌──────────────────────────────────────────────────────────┐
                                           │ Jio router: voice gateway (provisioning, SIP B2BUA, relay) │
                                           └──────────────────────────────────────────────────────────┘
                                                                        │ IMS (Jio's network)
```

- **Renderer.** Draws one state snapshot pushed by the main process. It can call only a fixed list of methods through the preload bridge. It has no Node.js or network access.
- **Main process.** Owns everything stateful:
  - router discovery
  - the provisioning (sign-in) client
  - the line state machine and retry timer
  - call state and call history
  - the encrypted sign-in vault
  - logging, the tray and windows
- **Engine.** A small C program built on PJSIP 2.17 with OpenSSL and the AMR-NB/AMR-WB codecs. The main process starts it as a child process and exchanges one JSON object per line on stdin and stdout. The engine does SIP signalling, TLS and audio, and nothing else. A crash in native code can't take down the app, and restarting the engine is a complete reset of SIP and audio state.

The router side is Jio's voice gateway. It is the same service Jio's own JioJoin phone app talks to. To your line it looks like a set of extension handsets:
- It hands each authorised device a SIP account.
- It accepts SIP registrations over TLS.
- It relays calls between those devices and Jio's IMS network.

## 1. Finding the router

The app looks for the router in this order:
1. **An address you typed in Settings**, if any.
2. **`jiofiber.local.html`**, the name the Jio router answers in its own DNS.
3. **Your default gateway.**

Every candidate must be a private IPv4 address: 10/8, 172.16/12, 192.168/16, 169.254/16 or 100.64/10. Anything else is ignored.

Each candidate is probed with a TLS connection to port 8443 and an HTTP `HEAD /`:
- The connection is accepted only if the server's certificate names `jiofiber.local.html` (see Security).
- A real gateway answers the probe with `501 Not Implemented` and a `Server` header naming the router model and voice-service version. The app shows these on the first setup screen.

Requests always carry the host name `jiofiber.local.html`, even when the address came from the gateway or from Settings, the same way `curl --resolve` does.

**Common reasons discovery fails:**
- A VPN, or custom or encrypted DNS, so the name doesn't resolve.
- Your own Wi-Fi router or a mesh system in router mode between the computer and the Jio router. The default gateway is then not the Jio router.
- A guest network.

## 2. Signing in: authorising this computer

Each install generates a random identifier in MAC-address form, called the **device ID**. The router keeps a whitelist of device IDs that may use the line.

Provisioning is an HTTPS `GET` to port 8443, shaped like a GSMA RCS auto-configuration request. It carries the device ID, a device name you choose, and a fixed set of client parameters. The router answers in one of three ways:

| Router's answer | Meaning |
| --- | --- |
| `200` with a `wap-provisioningdoc` XML containing the SIP account | This device is authorised. |
| `200` with an empty body, a session cookie and a masked mobile number header | A one-time code was texted to the line's registered mobile. |
| Anything else (including an XML document without an account) | Not authorised, or the router couldn't help right now. |

**Setup steps:**
1. **Name this device.** The app sends the plain request, which can't cause a text. If the router already knows the device, setup finishes here.
2. **Request OTP.** Only this button sends the request with `op_type=add`, which asks the router to whitelist the device. The router texts a code to the mobile number registered with the line, and returns a session cookie.
3. **Verify.** The app sends `GET /?OTP=<code>` with that cookie. On success the router returns the SIP account and the device is whitelisted.

The app then saves the device ID, the device name and the line's display number in the vault (see Security). **The SIP password is never saved.**

## 3. Credentials are fetched again before every new registration

The router expects a provisioning request before each fresh registration. So for every connection attempt the main process:
1. Finds the router again.
2. Fetches the SIP account again over 8443.
3. Passes it to the engine over stdin.

The password lives only in memory for that registration.

The account gives the engine:
- the realm and home domain
- the authentication user and password
- the public identity (your number as a SIP URI)
- the `+sip.instance` UUID the router uses to recognise this device
- the SIP port

Hourly registration refreshes reuse the same credentials and don't refetch.

If the plain refresh comes back with no account, the router no longer has this device on its whitelist. It may have been removed in the JioHome app, pushed out by a newer device (see below), or cleared by a reset of the router's voice state. The app then stops retrying and shows "Your router doesn't recognise this device", with **Authorise…** to request a code and **Check again**. It never sends the `op_type=add` request on its own: a refresh runs unattended, possibly on someone else's Jio network, and that request texts the line's owner. A network change or **Check again** repeats the plain check, which is safe.

### The device limit

The router keeps a fixed number of devices on its whitelist. The number comes from Jio's configuration for the line; on the line we tested it is 6, and it covers Jio's own phone and set-top-box apps too. When the list is full, adding a device silently removes the one that was added longest ago. Every new device ID takes a slot, so reinstalling or signing out and back in can push another device off the line.

## 4. Registration

The engine registers through the router as its outbound proxy:
- **Transport:** TLS to the router's address on port 5068 (by default), with the router's certificate name checked.
- **Registrar:** the home domain. **Authentication:** SIP digest.
- **Contact:** RFC 5626 outbound, with the router's bare-UUID `+sip.instance`, plus the IMS MMTel feature tags. The instance parameter rides on every Contact, because the gateway identifies the device by it on every dialog. A one-line PJSIP patch keeps the parameter from appearing twice on REGISTER.
- **Headers:** `P-Access-Network-Info` on every request, and `P-Preferred-Identity` on calls.
- **Expiry:** 3600 seconds, refreshed by PJSIP.

The router can hold a new registration for up to about half a minute while it confirms its own registration with Jio. The app allows 45 seconds.

### The line state machine

The main process runs the line as a pure reducer. The status bar and tray show its state.

```
signed-out ──sign-in──▶ connecting ──registered──▶ registered
                           │  ▲                        │
                    failed │  │ retry timer / "Retry now" / network change
                           ▼  │                        │ failed / lost connection
                        retrying ◀─────────────────────┘
connecting ──router asks for a code──▶ needs-otp   (no automatic retries from here)
any ──Disconnect──▶ offline          any ──Sign out──▶ signed-out
```

- **Phases.** "Connecting" has three phases: finding the router, refreshing credentials, registering.
- **Backoff.** Failures back off exponentially with jitter: about 5 s doubling to 5 minutes. A line that was up gets one quick retry first.
- **Retries belong to the main process.** PJSIP's own registration retries are turned off, so every retry starts with fresh credentials.
- **Network changes.** A change of local IPv4 address, or waking from sleep, starts a fresh attempt. If a call is in progress, this waits until the call ends.
- **Reasons.** Every failure carries a plain-language reason, shown in the banner. The diagnostics export keeps the technical detail.

## 5. Calls

**Outgoing calls**
- The keypad input becomes the dial string the Jio network expects:
  - Ten-digit numbers get the trunk prefix `0`.
  - `+91` and `0091` become national numbers.
  - Other `+` numbers become `00…`.
  - Short codes, toll-free numbers and `*`/`#` codes go out as typed.
- The request URI is `sip:<dial>@<home domain>;phone-context=<home domain>;user=phone`.
- Ringback is played locally when the network sends `180` without early media.
- SIP failure codes become plain outcomes such as "Busy", "No answer" or "This number doesn't exist".

**Incoming calls**
- The caller is taken from `P-Asserted-Identity`, falling back to `From`.
- The engine answers `180 Ringing` and plays a ringtone, and the app shows a small always-on-top card.
- While you're on a call, a second incoming call is rejected with `486 Busy` and logged as missed.
- Calls ring only while the app is running. The router can't wake a closed app, so "Open at login" matters.

**In-call controls:** mute (local), hold and resume (re-INVITE), and DTMF digits.

## 6. Audio

- **Codecs, in order of preference:** AMR-WB, AMR-NB, PCMU. AMR is octet-aligned, with an explicit mode-set.
- **RTP.** Sent from port 52000 upward on the computer's LAN address, to the router's media relay. SRTP is not used on this LAN link.
- **Clock.** The engine runs a 16 kHz conference bridge with echo cancellation.
- **macOS echo cancellation.** The system voice-processing unit is used when you keep the default devices. It ignores per-device choices, so when you pick a specific microphone or speaker the engine switches to software echo cancellation.
- **Microphone.** Opened only for a call or the Settings level meter.

## 7. Recovery

| Event | What the app does |
| --- | --- |
| Router's voice service restarts | The TLS connection drops, the banner shows "Lost the connection to the router", and retries begin. Once the service is back the app refetches credentials and registers. |
| Registration refused or timed out | Retries with backoff and fresh credentials. The reason is shown in the banner. |
| Registration lost during a call | The call carries on; the app reconnects once it ends. |
| Engine crashes | The call ends as "cut off" and the line retries with a new engine process. |
| Computer sleeps or changes network | A fresh attempt starts (deferred until any call ends). |
| Router forgets this device | The app stops retrying and asks you to confirm the device again. It requests a code only when you click. |
| App quits | The engine is asked to un-register before it exits, so the router stops ringing it. |

## 8. Security model

### The local TLS link
- The router's certificate is self-signed, and its private key ships in every firmware image.
- TLS to the router therefore protects against passive eavesdropping on your LAN. It does **not** prove you are talking to your router.
- The app limits what it trusts as tightly as it can:
  - only private IPv4 addresses
  - only port 8443 for provisioning, and for SIP the port the provisioning reply names (5068 on every router seen so far)
  - only a certificate whose subject name is `jiofiber.local.html`
- No HTTP request and no SIP message is sent until that check has passed. In the provisioning client, the request is written only after the certificate has been checked. In the engine, a certificate check in the transport callback closes the connection before PJSIP sends the queued REGISTER.
- No global TLS setting is changed.

### What someone on your network could do
Because the router can't be authenticated, a device that can redirect your traffic could pose as the router. Ways to do that include ARP spoofing, a rogue DHCP server or spoofed DNS for `jiofiber.local.html`. Such a device would learn this install's device ID.

The device ID is the real credential: the router hands the line's SIP account to any LAN device presenting a whitelisted ID. Jio's own apps have the same exposure. Keep untrusted devices off the network the router serves.

Call audio (RTP) is unencrypted on the LAN.

### What is stored, and where
| Data | Where | Protection |
| --- | --- | --- |
| Device ID, device name, line number | `account.bin` in the app's data folder | Encrypted with the OS keychain (Electron `safeStorage`). On Linux the app asks for the Secret Service keyring (libsecret) on desktops Chromium doesn't recognise, such as Hyprland or Sway; KDE uses KWallet. With no usable keychain it is kept in `account.json`, readable only by your user, because losing the device ID would cost a text and a whitelist slot. Sign-out keeps the device ID. |
| SIP password | Memory only | Fetched for each registration and passed to the engine over stdin, never argv or the environment. |
| Call history | `history.json` | File mode 0600. Removed on sign-out. |
| Settings | `settings.json` | No secrets. |

### Logs and diagnostics
- **Redaction.** Every log line passes through a redactor before it is written. It removes phone numbers (runs of six or more digits), SIP user parts, MAC-style IDs, UUIDs and global IPv6 addresses. It also removes every value registered as secret, including the password, the auth user, the number, the device ID and the instance ID.
- **No SIP message logging.** The engine never logs SIP messages.
- **Export.** **Settings → Help → Export…** writes a plain-text report: app, engine, line and router status, plus the recent log. The redactor runs again over the whole report.

### The app itself
- The renderer runs with context isolation and the Chromium sandbox, without Node, under a strict Content Security Policy.
- Navigation is blocked, and only `https://` links open, in your browser.
- The main process answers only its fixed list of methods, and only from the app's own pages.

## Ports at a glance

| Port | Direction | Purpose |
| --- | --- | --- |
| Router TCP 8443 | App → router | Provisioning (HTTPS) and discovery probe |
| Router TCP 5068 | Engine → router | SIP over TLS |
| Router UDP media relay range | Both | RTP to and from the router |
| Local UDP 52000+ | Router → engine | RTP |
