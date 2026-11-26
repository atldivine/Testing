# Pi Control — iPhone app for your Raspberry Pi

SwiftUI app (iOS 17+) that talks to `pi_dashboard.py` on the Pi.

**Tabs**
- **Overview** – CPU, temperature, memory, disks, network, uptime, live CPU chart,
  power/throttling, health checks, top processes. Power menu (top right): reboot / shut down.
- **Services** – systemd services and Docker containers. Swipe or long-press → start / stop / restart.
- **Sites** – every site the Pi hosts (folders, nginx/apache, Docker). Tap to open,
  **+** to upload a .zip from Files, swipe → roll back to the previous version.
- **Settings** – Pi address + deploy token (saved in the Keychain), connection test.

## Build & install (xtool, from WSL on Windows)

```bash
cd PiControl
xtool dev                 # builds, signs with your Apple ID, installs on the plugged-in iPhone
xtool dev build --ipa     # just makes the .ipa (in xtool/ folder) if you want the file
```

First time on the phone: Settings → Privacy & Security → **Developer Mode** on,
then Settings → General → VPN & Device Management → trust your Apple ID.
With a free Apple ID the app expires after 7 days — run `xtool dev` again to refresh it.
If xtool says the bundle ID is taken, change `bundleID` in `xtool.yml`.

## Connect it

1. Pi must run the latest `pi_dashboard.py` (has the control + sites API).
2. Get the token on the Pi: `sudo cat /opt/pi-dashboard/deploy-token.txt`
3. In the app → Settings: address `http://192.168.1.5:8088`, paste the token, **Save & test**.
4. For access away from home, install Tailscale on the Pi and iPhone and use the
   Pi's Tailscale name instead, e.g. `http://jevspi:8088`.

## API used

| | |
|---|---|
| `GET /api/stats` | all health/activity data |
| `GET /api/sites` | hosted sites |
| `POST /api/sites/<name>/deploy` | body = .zip, header `Authorization: Bearer <token>` |
| `POST /api/sites/<name>/rollback` | token |
| `POST /api/control` | `{"kind":"service"/"docker"/"system","action":"start/stop/restart/reboot/shutdown","name":"..."}` + token |
