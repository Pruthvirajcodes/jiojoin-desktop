# How calling works on a Jio router

This page describes the voice gateway inside a Jio home router and what a device on the home network sees when it uses the line. JioJoin Desktop talks to this gateway; so do Jio's own phone and set-top-box apps.

It is written from the outside: from what one router logs, answers and stores. Nothing here comes from Jio documentation.

## What this is based on

| | |
| --- | --- |
| Router | Jio AirFiber indoor unit JIDU6911 |
| Firmware | stock release R3.2.6, voice stack "JUICE" 1.5.5 |
| How it was observed | The stock voice program, with its stock configuration, was run on the same router under OpenWrt (see [openwrt-on-jidu6911.md](openwrt-on-jidu6911.md)) with logging turned up. Facts about the stock system around it (start-up, DNS, firewall, watchdogs) come from reading a backup of the stock firmware. An earlier client used the same protocol against the live stock firmware for weeks, which is why we believe the two behave alike. |
| Not covered | Other router models (JioFiber ONTs, other AirFiber units), other firmware releases, and anything on Jio's servers. |

Each statement is marked:

- **Observed** — seen in a log, a reply or a file.
- **Inferred** — concluded from the wording or order of log messages, or from the shape of a file. Could be wrong.

## The short version

1. The router runs one program, the voice gateway, that holds the line's single registration with Jio's phone network (IMS).
2. Devices on the home network never talk to Jio. They talk to the gateway: HTTPS on port 8443 to get an account, SIP over TLS on port 5068 to register and call, RTP to the router for audio.
3. A device is allowed in by a whitelist kept on the router. A new device gets in with a one-time code that Jio texts to the line's registered mobile.
4. The whitelist holds a fixed number of devices (6 on the line we looked at). When it is full, adding a device removes the oldest one.

```
 phone / set-top box / computer                 router                          Jio
 ------------------------------         ----------------------         --------------------
 HTTPS 8443  (get account, OTP)  --->   config server  --- HTTPS --->  config + OTP service
 SIP/TLS 5068 (register, calls)  --->   local registrar
                                        back-to-back agent --- SIP/TLS, IPv6 --->  IMS (P-CSCF)
 RTP  <------------------------------>  media relay   <------- RTP, IPv6 ------->  media
```

## The parts

**Observed**

- One daemon does all of it. Its log uses these names for its parts: config server, config manager, registrar, B2BUA (back-to-back user agent), registration manager, media relay, push list, and an event uploader.
- It is built on the open-source reSIProcate SIP stack and bundles its own OpenSSL 1.1.1 and libcurl.
- The stock firmware is OpenWrt-based. The daemon is started at the end of boot, and helper scripts in the firmware watch it and pass it network events.
- It reads one plain config file. Relevant values:

| Setting | Value |
| --- | --- |
| HTTPS provisioning port | 8443 |
| SIP/TLS port for home devices | 5068 |
| SIP ports used towards the network | 5060 (UDP/TCP), 5061 (TLS) |
| Other listeners | 8080 (HTTP), 7443 (TLS) |
| Media relay ports on the router | 49000–49050 |
| RTP port range expected from devices | 52000–52200 |
| Preferred WAN protocol | IPv6 |
| Simultaneous calls | 2 |
| Codec | AMR / AMR-WB |

- State lives in a handful of files: the line's settings, the config fetched from Jio (an XML document), the whitelist, and a push list for phone apps.

**Inferred**

- The line's number and the address of Jio's config service are delivered to the router by remote management (TR-069). The log has a waiting state for it and can also fall back to saved copies.
- Remote management can also order a "soft reset" or a "hard reset" of the voice state. The hard reset's log text says it clears the whitelist.

## Finding the gateway

**Observed**

- Devices find the gateway by one DNS name, `jiofiber.local.html`, answered by the router itself. The stock firmware has it in its hosts file on the LAN address (factory default `192.168.31.1` on this model) and also publishes it on the router's LAN IPv6 address. The router advertises itself as the IPv6 DNS server.
- There is no mDNS, SSDP or DHCP option involved.
- A device whose DNS does not go through the router (private DNS, a VPN, a second router in between) will not resolve the name. The gateway is still at the default gateway address.

## The certificate

**Observed**

- Ports 8443 and 5068 present the same self-signed certificate: common name `jiofiber.local.html`, 4096-bit RSA, valid for a hundred years, no subject-alternative-name.
- The matching private key is a file in the firmware image, the same on every unit that runs that image.

So TLS to the gateway keeps other devices on the network from reading the traffic, but it cannot prove that the other end is your router. A client can only check that the certificate has the expected name and that the address is a private one.

## Getting an account (port 8443)

The config server speaks a variant of the GSMA RCS auto-configuration protocol: a GET with a long query string, answered with a `wap-provisioningdoc` XML.

**Observed**

- `HEAD /` is answered with `501` and a `Server` header that names the router model and the voice stack version. It changes nothing, which makes it a safe "is this a Jio gateway?" probe.
- The device identifies itself with a MAC-style id in the query. The gateway turns it into a UUID whose last group is that id. This UUID comes back in the XML and is what the device must use as its SIP instance id.
- The server's HTTP is loose: some replies have stray carriage returns and HEAD replies can carry a body. A strict HTTP parser rejects them.

Three cases:

| Request | What the gateway does | Reply |
| --- | --- | --- |
| Plain request from a **whitelisted** device | Looks the UUID up, finds its password. Does not contact Jio. | `200` with the XML |
| Plain request from an **unknown** device | Logs "device not found in whitelist". Does not contact Jio. No text message. | a refusal (exact form not captured) |
| Request with `op_type=add` from an unknown device | Posts a whitelist request to Jio, which texts a code to the line's registered mobile. | `200`, empty body, a `Set-Cookie` header and an `x-amn` header |

Then the code is submitted:

| Request | What the gateway does | Reply |
| --- | --- | --- |
| `GET /?OTP=<code>` with the cookie | Sends the code to Jio and waits (about 2 s). On success it adds the device to the whitelist file and stores its password. | `200` with the XML |

**Observed** — the XML carries the SIP realm and home domain, the user name and public identity (the line's number), a per-device password, the instance UUID, an emergency-routing id, and a local proxy entry. The device registers to the router on port 5068.

**Inferred**

- The per-device password is issued by Jio in the reply to the code and does not change afterwards (one device's whitelist entry was identical three weeks apart).
- `x-amn` is a hint of the mobile number the code went to.
- The log text shows more endpoints (call waiting, call blocking, voicemail, log download). We did not use or probe them.

## The whitelist and its limit

**Observed**

- The whitelist is a small text file: a version counter on the first line, then one line per device with four fields: the UUID, the device id, and two short values.
- The config fetched from Jio contains `maxDevices`. On the line we looked at it is 6.
- With 6 devices present, a 7th was added. The file still had 6 entries afterwards: the first (oldest) one was gone and the new one was at the end. The version counter went up by one. In the same second the gateway told its SIP side that a device had been removed.
- The removed device is not asked and is not told by this router. It simply stops being accepted.

**Inferred**

- Jio's side decides who is dropped. Just before removing the entry the gateway logged that a device was "missing in CCS XML", meaning the list Jio sent back no longer contained it.

What this means in a household: every new device, every reinstall that creates a new device id, uses one of the slots. When they run out, the device that was added longest ago loses the line and needs a new code, which in turn pushes out the next one.

## Registering and calling (port 5068)

**Observed**

- A device registers with SIP over TLS to the router on 5068, using the router as outbound proxy and the values from the XML.
- Every REGISTER is challenged (`401`) and checked on the router against that device's stored password. This happens again on each refresh.
- A registration interval of 3600 s is accepted.
- The router keeps one registration with Jio for the whole line. A device registering does not cause a new registration upstream. Two home devices can be registered at once.
- Right after the gateway starts, it holds a device's REGISTER until its own registration with Jio has succeeded, then answers it. Seen: 26–28 s of waiting on the device side.
- During a call the device's audio goes to the router (first relay port 49000), not to Jio. AMR-WB was negotiated.

**Inferred**

- A device that is not on the whitelist is refused at the challenge step. The exact SIP code was not observed.
- Incoming calls reach every registered device; phone apps are woken by push (the firmware ships push certificates and keeps a push list). A desktop client rings only while it is running and registered. Not tested with two desktop clients.

## Towards Jio

**Observed**

- The gateway uses IPv6 for voice. It finds Jio's entry point with NAPTR and SRV lookups under a regional name of the form `<region>.wln.ims.jio.com` and connects with TLS to port 5061.
- It answers one digest challenge and is registered.
- When the WAN's IPv6 goes down or comes back, firmware hotplug scripts signal the daemon, which de-registers or registers again. An address change is handled as down-then-up.
- It runs `iptables`/`ip6tables` commands to adjust the router's firewall. One was seen at start-up. Per-call media pinholes are expected but were not captured.
- It uploads small event records to Jio. One is sent for a whitelist request and includes the router model, the voice stack version, the line number and how many devices are whitelisted. A failed upload has no effect on calling.

## What a home device sees when things go wrong

| Symptom on the device | What it means |
| --- | --- |
| Connection refused on 8443 and 5068 | The gateway is restarting. It answers again in 10–20 s. |
| 8443 answers but REGISTER hangs for up to half a minute | The gateway is up but not yet registered with Jio. |
| `200` with an empty body and a cookie on a request that asked to be added | A code has been texted; submit it with the cookie. |
| The plain request is refused for a device that used to work | The device is no longer on the whitelist: it was pushed out by a newer device, or the voice state was reset. |
| Name does not resolve | The device's DNS does not go through the router. Use the gateway address. |

## Open questions

- The exact refusal a non-whitelisted device gets, on 8443 and on 5068.
- How a device can give its slot back. The log text shows a de-whitelist operation; its request format is unknown.
- Whether `maxDevices` is the same on every plan.
- What two desktop clients do on one incoming call.
- How much of this holds on JioFiber ONTs and on other firmware releases.
