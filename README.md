# Anime CRT TV Filter

A Chrome extension that applies a realistic CRT television effect to any video on the web. Built with WebGL2 fragment shaders for real-time performance.

![Chrome](https://img.shields.io/badge/Chrome-MV3-green) ![WebGL2](https://img.shields.io/badge/WebGL2-required-blue)

## Features

- **Scanlines** — horizontal line pattern scaled to video resolution
- **Screen curvature** — barrel distortion (full mode) or enhanced vignette (overlay mode)
- **Chromatic aberration** — RGB channel offset for color fringing
- **Bloom** — soft glow on bright areas via box blur
- **Noise** — animated film grain
- **Flicker** — subtle brightness oscillation

All parameters are adjustable from 0–100 via the popup UI.

## Rendering modes

The extension automatically detects DRM-protected content and picks the best strategy:

| Mode | When | How |
|------|------|-----|
| **Full** | Unprotected video (e.g. YouTube) | Captures video frames into a WebGL texture and renders the full CRT effect on a canvas that replaces the video |
| **Overlay** | DRM-protected video (e.g. Netflix) | Draws a semi-transparent scanline/noise/vignette overlay on top of the video — no pixel capture needed |

The mode badge in the popup shows which mode is active. Chromatic aberration and bloom are disabled in overlay mode since they require pixel access.

## Presets

| Preset | Scanlines | Curvature | Chromatic | Bloom | Noise | Flicker |
|--------|-----------|-----------|-----------|-------|-------|---------|
| Subtle | 30 | 20 | 15 | 20 | 10 | 5 |
| Heavy  | 70 | 50 | 40 | 50 | 30 | 20 |
| VHS    | 50 | 10 | 60 | 30 | 50 | 40 |

## Keyboard shortcut

Toggle the filter on/off:

- **Mac:** `Cmd+Shift+C`
- **Windows/Linux:** `Ctrl+Shift+C`

## Install

1. Clone this repo
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the project folder

## How it works

`content.js` is injected into every page. It watches the DOM for `<video>` elements via MutationObserver, attaches to the largest visible one, and creates a WebGL2 canvas positioned over (or replacing) the video. A GLSL fragment shader runs per-frame to produce the CRT effect. Settings sync across tabs via `chrome.storage.sync`.

## Project structure

```
manifest.json    — MV3 extension manifest
content.js       — video detection, WebGL setup, GLSL shaders, render loop
popup.html       — settings UI (sliders, presets, toggle)
popup.js         — popup logic and chrome.storage sync
background.js    — keyboard shortcut handler
icon*.png        — extension icons
```

## License

MIT
