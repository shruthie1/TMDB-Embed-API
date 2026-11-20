# Install Chitram on a Hisense VIDAA TV

This adds Chitram to the TV's app list as a web app. It opens
`https://chtrm2.vercel.app/?tv=1`.

The kit reuses a community tool,
[trialuser/vidaa-appstore](https://github.com/trialuser/vidaa-appstore), pinned
to commit `8c61a326323e6cc2a5f356c036d41ab6515da053`. Its code is not copied
here. `setup.sh` clones it into `.work/` (git-ignored) and adds our config.

## How it works

VIDAA lets a page install an app only when that page loads from `vidaahub.com`.
The tool runs a small DNS server on the Mac that points `vidaahub.com` at the
Mac. The Mac then serves an install page that lists only Chitram.

## What you need

- A Mac and the TV on the same home Wi-Fi.
- About 10 minutes, and the Mac's admin password (`sudo`).

## Install

1. On the Mac, run the setup. It clones the tool, makes a fresh certificate
   and prints the Mac's IP. It does not start anything.

   ```bash
   cd ~/Documents/Projects/TMDB-Embed-API/tools/vidaa-installer
   ./setup.sh
   ```

   If the IP it prints is wrong, pass the right one: `./setup.sh 192.168.1.20`.

2. Start the installer with the command that setup printed:

   ```bash
   cd .work/vidaa-appstore && sudo .venv/bin/python server.py
   ```

   If macOS asks to allow incoming connections for Python, click Allow.
   Leave this window open.

3. On the TV, open Settings > Network > Network Configuration. Change the
   IP settings to manual, and set DNS to the Mac's IP. Write down the old DNS
   value first.

4. On the TV, open the browser and go to `https://vidaahub.com`.

5. Accept the certificate warning. The certificate is the one setup made on
   your Mac.

6. The page shows "Hisense_installApp is available". Select Install next to
   Chitram. Wait for "successfully installed".

7. Set the TV's DNS back to the old value, or back to automatic (DHCP).

8. Turn the TV fully off and on again: hold the power button, or unplug it for
   30 seconds. Chitram now shows in the app list.

9. On the Mac, stop the installer with Ctrl+C.

While the TV's DNS points at the Mac, the TV has no internet. The installer
answers only `vidaahub.com` and the two hosts the install page needs.

## Uninstall

1. Repeat install steps 2 to 5.
2. Select Uninstall next to Chitram.
3. Repeat install steps 7 to 9.

## Use on the TV

- Arrows move. OK selects.
- Back closes an open panel, then goes back a page. On the home page, Back
  closes Chitram.
- In the player: Play, Pause, Stop, Fast-forward and Rewind keys work. Stop
  leaves the film. Fast-forward and Rewind move 10 seconds.

## Risks

- During the install, the TV trusts a page served from your Mac. Do this only
  on your own home network.
- The certificate warning is expected. Accept it only for `vidaahub.com`, and
  only while the Mac installer is running.
- This uses an undocumented VIDAA function. A firmware update can remove the
  app, or stop the method from working.
- Hisense does not support this. It does not change the firmware, and
  Uninstall removes the app.

## Firmware caveats

- Firmware V0000.08.53A and V0000.09.60A are reported to fail with this method.
  Find your version under Settings > Support > System Info.
- For newer firmware, these projects have workarounds:
  - [NoobyGains/stremio-vidaa-tv](https://github.com/NoobyGains/stremio-vidaa-tv)
    (checked at `9bc0a10158ee108666917007ce6c95a6dc8c7a7c`)
  - [weinzii/vidaa-edge](https://github.com/weinzii/vidaa-edge)
    (checked at `94c3134911cbd4b813eea1f88c56819c0981518b`)
  Use their steps with the app details in `chitram-app.json`.

## Alternative tool: Docker

[arashbehmand/vidaa-custom-app](https://github.com/arashbehmand/vidaa-custom-app),
pinned to `45d88e9529033d08712915fb69ae113f02526454`, does the same with Docker.
It suits a Linux machine better than a Mac. Its compose file uses host
networking. It also finds the server IP from inside the container, which on a
Mac gives the Docker VM's IP and not the Mac's. To use it, copy
`arashbehmand/config.yaml` to `data/web/config.yaml` in that repo.

## Files

- `setup.sh`: clones the pinned tool and writes its config. It starts nothing.
- `config.template.json`: the tool's config. Setup fills in the IPs.
- `chitram-app.json`: the app entry (name, URL, icon).
- `chitram-400.png`: the 400x400 icon, made from `web/public/icons/icon-512.png`.
  The TV loads it from GitHub, so it must stay at this path on `main`.
- `arashbehmand/`: config and icon for the Docker tool.
