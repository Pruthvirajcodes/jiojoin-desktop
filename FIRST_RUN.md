# First run

This takes about five minutes. Keep the phone whose number is registered with your Jio line nearby, because the router texts it a one-time code.

## Before you start

- This computer must be on your JioFiber / AirFiber network (Wi-Fi or LAN), with no VPN.
- Quit the old "JioJoin for Mac" for this test. The two can be registered at the same time, but then both ring and it is hard to tell which one you are testing.

## 1. Install and open

1. macOS: open the `.dmg` from `bun run package:mac` (in `dist/`) and drag **JioJoin Desktop** to Applications. Linux: run the AppImage from `bun run package:linux`.
2. Open it. If macOS asks to **find devices on your local network**, choose **Allow**. Without it the app cannot reach the router.

## 2. Set up the line

1. **Jio router found.** The app shows the router's address and model. Click **Continue**.
   If it says it can't find the router, check the network, then type the router's address (often `192.168.29.1`) and click **Try again**.
2. **Name this device.** Keep the suggested name or type one, then click **Continue**. This only asks the router whether it already knows this computer. It cannot send a text.
3. **Confirm it's you.** Click **Request OTP**. The router texts a code to the line's registered mobile. Nothing is sent until you click.
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
- **The code isn't accepted.** Click **Send a new code** and use the newest text.
- **One-way or no audio.** Check Settings → Audio (**Test microphone**, **Play test tone**), then try the call again.
- **Getting help.** Settings → Help → **Export…** writes a report with numbers, names and device ids removed. The log is at `~/Library/Application Support/JioJoin Desktop/logs/app.log` and is redacted the same way.

## Good to know

- Turn on **Settings → General → Open at login**. The router cannot wake a closed app, so calls only ring while JioJoin is running.
- **Sign out** removes the saved sign-in and call history from this computer. Signing in again needs a new code.
- If you rebuild the app yourself, macOS may ask once for your login password so the new build can read its saved sign-in from the keychain. Choose **Always Allow**.
