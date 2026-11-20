# First run

This takes about five minutes. Keep the phone whose number is registered with your Jio line nearby, because the router texts it a one-time code.

## Before you start

- This computer must be on your JioFiber / AirFiber network (Wi-Fi or LAN), with no VPN.
- **Your line has a device limit.** The router keeps a short list of devices allowed to use the line (6 on the lines we've seen, counting Jio's own phone and TV apps). If the list is full, adding this computer silently removes the device that was added longest ago, which then stops ringing until it is confirmed again.
- Quit the old "JioJoin for Mac" for this test. The two can be registered at the same time, but then both ring and it is hard to tell which one you are testing.

## 1. Install and open

1. Install the build for your OS from [Releases](https://github.com/Pruthvirajcodes/jiojoin-desktop/releases/latest) (see [README.md](README.md#install) for Gatekeeper, AppImage and SmartScreen steps), or from `dist/` if you built from source.
2. Open it. If macOS asks to **find devices on your local network**, choose **Allow**. Without it the app cannot reach the router.

## 2. Set up the line

1. **Jio router found.** The app shows the router's address and model. Click **Continue**.
   If it says it can't find the router, check the network, then type the router's address (often `192.168.29.1`) and click **Try again**.
2. **Name this device.** Keep the suggested name or type one, then click **Continue**. This only asks the router whether it already knows this computer. It cannot send a text.
3. **Confirm it's you.** Click **Request OTP**. The router texts a code to the line's registered mobile. Nothing is sent until you click, and the app never requests a code on its own.
4. Type the code and click **Verify**.
5. **You're all set** shows your number. Click **Start using JioJoin**.

Within a few seconds the bottom-left of the window should read **Connected**. The router sometimes holds a new registration for up to half a minute while it confirms with Jio.

## 3. First test call

1. On **Keypad**, type a mobile number you have to hand and press Return or the green button. Ten digits are enough: the app adds the leading 0 the network wants.
2. macOS asks for the **microphone** on the first call. Choose **Allow**, then place the call again if it did not start.
3. Check both directions of audio for about 20 seconds. Try **Mute**, **Hold**, and a digit on the in-call **Keypad**.
4. Hang up. Then call the landline from that mobile. A small **Incoming call** card appears at the top right. Answer it there or in the main window.
5. Close the window and call again. The app stays in the menu bar, so it should still ring.

## If something goes wrong

- **Not connected, retrying.** The banner gives the reason, and the app retries on its own (5 seconds, doubling to 5 minutes). **Retry now** skips the wait.
- **"Your router doesn't recognise this device."** The router has dropped this computer from its list: someone removed it in JioHome, a newer device took its place, or the router's voice settings were reset. Click **Authorise…** and request a code. If you were just on another network, click **Check again** first.
- **The code isn't accepted.** Click **Send a new code** and use the newest text.
- **One-way or no audio.** Check Settings → Audio (**Test microphone**, **Play test tone**), then try the call again.
- **Getting help.** Settings → Help → **Export…** writes a report with numbers, names and device ids removed. The log is at `logs/app.log` inside the app data folder (on macOS: `~/Library/Application Support/JioJoin Desktop/logs/app.log`) and is redacted the same way.

## Good to know

- Turn on **Settings → General → Open at login**. The router cannot wake a closed app, so calls only ring while JioJoin is running.
- **Sign out** removes your line's details and call history from this computer, but keeps its device ID. If the router still has it on its list, signing in again needs no code and doesn't use up another slot.
- **Linux:** the sign-in is kept in your desktop's keyring (Secret Service, such as GNOME Keyring or KWallet). Without one, it is kept in a file only your user can read, and Settings says so.
- If you rebuild the app yourself, macOS may ask once for your login password so the new build can read its saved sign-in from the keychain. Choose **Always Allow**.
