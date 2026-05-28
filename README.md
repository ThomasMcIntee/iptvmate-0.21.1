# IPTVmate - IPTV Player Application

![IPTVmate icon](https://raw.githubusercontent.com/ThomasMcIntee/iptvmate/electron/src/assets/icons/favicon.256x256.png "IPTV player application")

[![Release](https://img.shields.io/github/release/thomasmcintee/iptvmate.svg?style=for-the-badge&logo=github)](https://github.com/thomasmcintee/iptvmate/releases)
[![Pre-release](https://img.shields.io/github/v/release/thomasmcintee/iptvmate?include_prereleases&label=pre-release&logo=github&style=for-the-badge)](https://github.com/thomasmcintee/iptvmate/releases)
![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/thomasmcintee/iptvmate/build-and-test.yaml?style=for-the-badge&logo=github)
[![Releases](https://img.shields.io/github/downloads/thomasmcintee/iptvmate/total?style=for-the-badge&logo=github)](https://github.com/thomasmcintee/iptvmate/releases)
[![Codecov](https://img.shields.io/codecov/c/github/thomasmcintee/iptvmate?style=for-the-badge)](https://codecov.io/gh/thomasmcintee/iptvmate)
[![Telegram](https://img.shields.io/badge/telegram-iptvmate-blue?logo=telegram&style=for-the-badge)](https://t.me/iptvmate)
[![Bluesky](https://img.shields.io/badge/bluesky-iptvmate-darkblue?logo=bluesky&style=for-the-badge)](https://bsky.app/profile/iptvmate.bsky.social)

🌐 **[Website](https://thomasmcintee.github.io/iptvmate/)** | [Telegram channel for discussions](https://t.me/iptvmate) | [Buy me a coffee](https://ko-fi.com/thomasmcintee) | [GitHub Sponsors](https://github.com/sponsors/thomasmcintee)

**iptvmate** is a video player application that provides support for IPTV playlist playback (m3u, m3u8). The application allows users to import playlists using remote URLs or by uploading files from the local file system. Additionally, it supports EPG information in XMLTV format which can be provided via URL.

The application is a cross-platform, open-source project built with Electron and Angular.

⚠️ Note: iptvmate does not provide any playlists or other digital content. The channels and pictures in the screenshots are for demonstration purposes only.

![iptvmate: Channels list, player and epg list](./iptv-dark-theme.png)

## Features

- M3u and M3u8 playlist support 📺
- Xtream Code (XC) and Stalker portal (STB) support
- External player support - MPV, VLC
- Add playlists from the file system or remote URLs 📂
- Automatic playlist updates on application startup
- Channel search functionality 🔍
- EPG support (TV Guide) with detailed information
- TV archive/catchup/timeshift functionality
- Group-based channel list
- Favorite channels management
- Global favorites aggregated from all playlists
- HTML video player with HLS.js support or Video.js-based player
- Internationalization with support for 16 languages:
  - Arabic
  - Moroccan arabic
  - English
  - Russian
  - German
  - Korean
  - Spanish
  - Chinese
  - Traditional chinese
  - French
  - Italian
  - Turkish
  - Japanese
  - Dutch
  - Belarusian
  - Polish  
- Custom "User Agent" header configuration for playlists
- Light and Dark themes
- Docker version available for self-hosting

## Screenshots

|                 Welcome screen: Playlists overview                 | Main player interface with channels sidebar and video player  |
| :----------------------------------------------------------------: | :-----------------------------------------------------------: |
|       ![Welcome screen: Playlists overview](./playlists.png)       |   ![Sidebar with channel and video player](./iptv-main.png)   |
|            Welcome screen: Add playlist via file upload            |             Welcome screen: Add playlist via URL              |
| ![Welcome screen: Add playlist via file upload](./iptv-upload.png) | ![Welcome screen: Add playlist via URL](./upload-via-url.png) |
|              EPG Sidebar: TV guide on the right side               |                 General application settings                  |
|     ![Playlist settings](./iptv-playlist-settings.png)             | ![EPG: TV guide on the right side](./iptv-epg.png)            |
|                       Playlist settings                            |                   EPG: TV guide on the right side             |

_Note: First version of the application which was developed as a PWA is available in an extra git branch._

## Download

Download the latest version of the application for macOS, Windows, and Linux from the [release page](https://github.com/thomasmcintee/iptvmate/releases).

Alternatively, you can install the application using one of the following package managers:

### Homebrew

```shell
brew install iptvmate
```

### Snap

```shell
sudo snap install iptvmate
```

### Arch

Also available as an Arch PKG, [iptvmate-bin](https://aur.archlinux.org/packages/iptvmate-bin/), in the AUR (using your favourite AUR-helper, .e.g. `yay`)

```shell
yay -S iptvmate-bin
```

### Gentoo

You can install iptvmate from the [gentoo-zh overlay](https://github.com/microcai/gentoo-zh)

```shell
sudo eselect repository enable gentoo-zh
sudo emerge --sync gentoo-zh
sudo emerge iptvmate-bin
```

[
<a href="https://github.com/sponsors/thomasmcintee" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/default-green.png" alt="Buy Me A Coffee" width="185"></a>

## Troubleshooting

`

## How to Build and Develop

Requirements:

- Node.js with npm

1. Clone this repository and install project dependencies:

    ```
    npm install
    ```

2. Start the application:

    ```
    npm run serve:backend
    ```

This will open the Electron app in a separate window, while the Angular dev server will run at <http://localhost:4200>.

To run only the Angular app without Electron, use:

```
npm run serve:frontend
```

## Disclaimer

**iptvmate doesn't provide any playlists or other digital content.**

<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->

[![All Contributors](https://img.shields.io/badge/all_contributors-13-orange.svg?style=flat-square)](#contributors)

<!-- ALL-CONTRIBUTORS-BADGE:END -->
