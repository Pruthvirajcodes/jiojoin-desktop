# OpenWrt on the Jio AirFiber JIDU6911, with Jio calling kept working

Field report (one JIDU6911 unit, one firmware release, November 2026) on moving from stock Jio firmware to OpenWrt and running Jio's voice gateway ("JUICE") on it so the landline kept working. Not a recipe—read the risk section first.

**You do not need any of this to use JioJoin Desktop.** The app works with a stock Jio router.

Each statement is either **done** (carried out on the unit and checked), **built/inspected only** (never run on hardware) or **not tested**.

## Risks, first

| Risk | What we know |
| --- | --- |
| **Bricking** | A bad image or a wrong boot command can leave the router unreachable. There is no tested way back without a serial console, and we had none: no adapter, no confirmed pinout, no console password. The owner accepted this for the last step. |
| **Losing Wi-Fi calibration** | Each unit's radio calibration lives in two flash partitions (`ART`, `BDF`). Overwrite them and Wi-Fi performance is gone for good. They were never written. Using another unit's calibration files ("donor" data) was deliberately avoided. |
| **NAND read errors** | During the backup, the ECC failure counter of the `BDF` partition went up. It was traced to one padding page outside the data in use (details below). The backup is good, but these are processed reads without the spare-area data, so a byte-exact raw restore is not possible from them. |
| **Losing the stock firmware** | Stock is still on the flash, untouched, in its own slot. But the installed OpenWrt image marks the boot settings read-only, so switching back needs either a rebuilt image or the serial console. **Not tested.** |
| **Losing the phone line** | The voice setup depends on files copied from the stock system and on Jio's servers continuing to accept this router. Jio can no longer manage the voice service remotely (no TR-069 client). What happens when the cached line config expires is **not known**. |
| **Restoring from the backup** | **Never tested.** A backup you have not restored is a hope, not a recovery plan. |
| **Internet service** | AirFiber's internet came up on OpenWrt on this line (VLAN 1015, DHCPv6, 464XLAT). Jio could change that at any time. |

## The hardware

- Qualcomm IPQ9574 family, four Cortex-A73 cores, 512 MiB RAM, 256 MiB NAND (2048-byte pages, 128 KiB erase blocks). Two Wi-Fi 6 radios driven by `ath11k`.
- Stock firmware: an OpenWrt-derived system on a 32-bit ARM Linux 5.4 kernel.
- Flash: 29 partitions. The ones that matter:

| Partition | Size | Role |
| --- | --- | --- |
| `rootfs` | 80 MiB | active stock system (UBI) |
| `rootfs_1` | 80 MiB | the idle second slot |
| `customfs` | 65 MiB | stock data |
| `0:APPSBLENV` | 512 KiB | U-Boot settings, including `bootcmd` |
| `0:ART` | 1 MiB | radio calibration |
| `0:BDF` | 2 MiB | radio board data |
| `MFG`, `Jio-Reserved` | 2 MiB each | factory data |

- Stock boots with `bootcmd=bootipq`.

## Where the OpenWrt build came from

- A community port exists for the sibling model JIDU6811 (the "MaxNet" project). Its board files were the starting point. The 6911 needed its own device profile.
- OpenWrt at a pinned commit, target `qualcommbe/ipq95xx`, Linux 6.18, 64-bit.
- One build fix was needed: an old-kernel compatibility patch for `ath11k` no longer compiles against Linux 6.18 and was removed for this build.
- The build was checked offline before anything touched the router: image hashes, the device-tree compatible string, the memory size, and every protected partition's offset and size against the stock table.
- The community default of open Wi-Fi and the donor calibration files were left out.

## Step 0 — get in, back up, get out (done)

- A community unlock tool gave a temporary root shell on the stock firmware. We do not describe it here. The temporary SSH server and its firewall rule were removed again afterwards.
- Every flash partition was copied off and hashed twice on the router; the copies matched. 35 images in total, plus archives of `/etc`, the overlay and the board-data files, plus the boot environment and flash geometry.
- **ECC note.** While copying `BDF`, its ECC failure count rose from 2 to 4 even though both reads gave the same hash. Reading the partition in three pieces showed the failures all came from page 10, which is past the end of the small filesystem inside (data ends inside page 9). The four board files were also decompressed independently and matched. Conclusion: a padding page that reports errors, not damaged calibration. Nothing was rewritten to "fix" it.
- Limits: these are normal reads through the kernel, so there is no spare-area (OOB) data. No restore was attempted.

## Step 1 — a harmless test of the boot settings (done)

Before writing any OpenWrt, the boot command was rewritten to something that does the same as before, and the router was rebooted. This showed that the bootloader accepts a changed command and still starts stock.

It also showed a side effect: saving the environment from the bootloader stored a different machine id than the one stock had saved. The original environment was put back and its checksum verified. Later boot commands set the original id explicitly before saving.

## Step 2 — one-shot boots from the idle slot (done)

The test image was written to the idle slot (`rootfs_1`) only. The active stock slot was not touched. `ubiformat` exited with an error code on the recorded writes even though the data was good, so each write was verified by reading the kernel and root filesystem back and comparing hashes.

The boot command for a test boot was built so that **it undoes itself before it starts the test image**:

```
setenv bootcmd bootipq; setenv machid <stock id>;
if saveenv; then
    <point U-Boot at rootfs_1>; ubi part rootfs_1;
    ubi read <addr> kernel <size>; bootm <addr>;
else
    bootipq;
fi; reset
```

By the time OpenWrt starts, the saved boot command is already back to stock. Whatever happens next, pulling the power brings back the stock firmware.

The first images ran from RAM with every flash partition read-only, and rebooted themselves back to stock on a timer.

What happened, in order:

| Boot | Result |
| --- | --- |
| RAM image, tests 1–4 | Reached over SSH each time. All partitions read-only. Ethernet, IPv4 and IPv6 internet, then encrypted Wi-Fi with real clients, were checked across the four runs. |
| "v2" image | **Did not come up on the LAN.** Cause: a packaging mistake had copied private `0700` directory permissions into system directories. The router was power-cycled and came back on stock. This is the one time the fallback was needed, and it worked. |
| "v2-fixed" | Up, internet on both protocols, also after forcing the WAN to re-acquire. |
| Persistent image, boot 1 | Up from the idle slot with a writable overlay. A marker file was written. Returned to stock. |
| Persistent image, boot 2 | The marker was still there. Wi-Fi clients online. Returned to stock, and stock's internet was verified again. |

## Step 3 — making OpenWrt the default (done, recovery not tested)

The saved boot command was changed to always load the kernel from `rootfs_1`, with `reset` if that fails. Only `bootcmd` changed; the environment checksum was verified.

- Two normal reboots came back to OpenWrt with settings intact.
- Stock firmware, `customfs`, the calibration partitions and the factory data are untouched. In the installed image only `rootfs_1` is writable; the other 28 partitions are read-only.
- `sysupgrade` is blocked by a guard in the image until a marker file is created by hand.

What this step gave up:

- The power-cycle fallback no longer exists. If the OpenWrt slot ever fails to boot, the command resets and tries again, forever.
- Because the boot settings are read-only from the running system, going back to stock needs the serial console or a rebuilt image. Neither has been tried.

## Recovery paths: used and unused

| Path | Status |
| --- | --- |
| Self-restoring one-shot boot command + power cycle | **Used once for real** (the "v2" image), and exercised on every test boot |
| Timed automatic reboot back to stock (RAM images) | Used on tests 1–4 |
| Putting the original boot environment back | Used after the Step 1 test |
| Rolling back the voice setup (see below) | Used once, live |
| Return to stock after Step 3 | **Not tested** |
| Serial console (UART) | **Not available, not tested** |
| TFTP boot from the bootloader | **Not tested** (needs the console) |
| Restoring any partition from the backup | **Not tested** |

## Internet on AirFiber under OpenWrt (done)

- The WAN carries one tagged network, VLAN 1015. A passive capture saw nothing else, so there is no separate voice VLAN.
- IPv6 comes by DHCPv6 with a delegated prefix. IPv4 is 464XLAT on top of it. The CLAT needed a hook to follow the delegated prefix after a lease renewal.
- Jio's phone network (IMS) is reached over the same IPv6 path.

## Running Jio's voice gateway on OpenWrt

### Why it is not straightforward

- On stock, one closed program provides calling: it serves home devices on ports 8443 and 5068, holds the line's registration with Jio and relays audio. See [jio-firmware-and-calling.md](jio-firmware-and-calling.md).
- It is a 32-bit ARM program. The OpenWrt kernel here is 64-bit and built without 32-bit support, so it cannot run natively. Enabling that means a new kernel and a reflash.
- A plain TCP relay from the router to Jio was tried first. It carries SIP but cannot hand out accounts or do the one-time-code step, so it is not enough.

### What was done instead (done)

The stock program runs unmodified under `qemu-arm` user-mode emulation, in a small private directory tree on the router.

- **Emulator**: a static `qemu-arm` built with the OpenWrt toolchain. OpenWrt's own QEMU package leaves user-mode out. A 2 MiB translation cache keeps memory down.
- **Tree**: only the program, the libraries it loads, its config file, its certificate and key, a busybox for its shell-outs, and its state files. About 18 MiB on flash.
- **Isolation**: a tiny launcher does `chroot`, drops to a dedicated user, sets no-new-privileges, then starts the emulator. Secrets are readable by that user only.
- **Identity files**: the program reads the router's model, serial, firmware version and LAN MAC from files in `/tmp`. They must match the original unit exactly. An early trial had one stray separator character in the serial, and the program's check of its stored password failed.
- **State**: the line's settings, the cached config from Jio and the device whitelist were copied from the stock backup of the same unit. These are the line's credentials. They are tied to this router and must never be published or moved to another device.
- **Shims** for the things it calls on stock:
  - `uci`: answers the few keys it asks for.
  - `ubus`: serves a snapshot of the real WAN status, refreshed every 30 s.
  - `iptables` / `ip6tables`: log the request and do nothing.
- **Firewall**: an nftables rule drops the program's ports on every interface except the LAN bridge and loopback. One static rule lets Jio's IPv6 range reach the media port ranges, in place of the per-call pinholes the program would open on stock.
- **DNS**: the router answers `jiofiber.local.html` with its LAN addresses, and forwards Jio's voice domains to a Jio resolver.
- **Network events**: a hotplug script sends the program the same signals the stock firmware does when the IPv6 WAN goes down, comes up or changes address.
- **Supervision**: a procd service restarts it after a 60 s pause. A guard stops it if its memory grows past 40 MiB or the router's free memory falls under 48 MiB.
- **Logs**: its output goes through a filter that keeps a short, scrubbed event list in `/tmp`. Nothing raw is stored.

### What works

- Registration with Jio: it comes back by itself 25–35 s after a restart, and it came back after a router reboot.
- A simulated WAN IPv6 drop and return (the hook's signals, sent by hand): re-registered in 12 s.
- A desktop client getting its account, registering, and making a call. Audio packets flowed in both directions.
- A new device being added with a one-time code.
- Two desktop clients registered at once.

### What does not, or is unknown

- **Remote management is gone.** Jio cannot update the line's voice settings on this router. Whether the cached config is refreshed when it expires is not known.
- **Jio's phone and set-top-box apps** were not tried against this setup.
- **Speed**: every TLS handshake to the gateway takes about 1.7 s, because its 4096-bit key runs under emulation. A registration takes several seconds.
- **Old libraries**: the program brings OpenSSL 1.1.1, which no longer gets fixes, and it listens on the LAN.
- **Housekeeping**: it leaves a few finished child processes behind per hour until it restarts. About 26 MiB of RAM in use.
- **Licence**: the program, its libraries and its key are Jio's. Run your own copy from your own router. Do not share them.

### Undoing the voice setup (done once)

A rollback script stops and disables the service, removes the tree and the firewall rule, takes out only the DNS and hosts entries it added, and puts the earlier relay back in the state it was in. It was run once on the live router during deployment and restored the previous configuration exactly. It does not touch WAN or Wi-Fi.

## If you are thinking of doing this

- Do the backup, and copy it somewhere else, before anything.
- Get a serial console working first. We did not, and every step after that carried more risk than it needed to.
- Use the idle slot and a self-restoring boot command for as long as you can. Stay there until the image has survived several boots and a power cut.
- Use your own unit's calibration data. Never write to `ART` or `BDF`.
- Expect to lose calling until you have set up the voice gateway, and accept that it may stop working if Jio changes something.
