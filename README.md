# Anime CRT TV Filter

A Chrome extension that applies a realistic CRT television effect to any video on the web. Built with WebGL2 fragment shaders for real-time performance.

![Chrome](https://img.shields.io/badge/Chrome-MV3-green) ![WebGL2](https://img.shields.io/badge/WebGL2-required-blue)

## How the effect is modelled

Instead of layering 2D effects on top of the picture, the full mode simulates the physical chain of a CRT TV in a multi-pass WebGL2 pipeline:

1. **Signal**: the video is resampled to a real line count (240p / 480i / 576i) and treated like a composite signal in YIQ. Luma is band-limited by **Sharpness** (with peaking halos around edges at high values), chroma is far narrower and lags behind (**Color Bleed**), and **Noise** adds RF snow, sync jitter and a rolling tracking tear.
2. **Beam**: every scanline is drawn by a gaussian electron spot per gun, in linear light (gamma 2.4). The spot **gets wider as it gets brighter**, so dark areas show scanline gaps and highlights fuse together, which is the defining look of a real tube. Energy is conserved, so thin lines don't dim the picture. **Convergence** errors grow toward the screen edges. **Interlace** alternates fields. **Persistence** lets the phosphor decay over a few frames instead of vanishing.
3. **Glass**: a blur pyramid of the beam image provides **Bloom** and wide **Halation** (light scattered inside the faceplate). The **Phosphor Mask** (aperture grille, slot mask or shadow mask) is drawn at native display pixels, with brightness compensation and overflow spill from saturated phosphors. The colours are converted from P22 phosphor primaries, with an optional **9300K** white point like Japanese sets. **Hum / Flicker** adds a rolling mains hum bar. **Curvature** bends the picture and rounds the screen corners, with the tube's glow reflected on the inner bezel.

Auto line count picks 480 lines when the video is displayed tall enough for the beam profile to resolve (~1700+ device pixels), otherwise 240.

## Rendering modes

The extension automatically detects DRM-protected content and picks the best strategy:

| Mode | When | How |
|------|------|-----|
| **Full** | Unprotected video (e.g. YouTube) | Captures video frames into a WebGL texture and renders the full CRT effect on a canvas that replaces the video |
| **Overlay** | DRM-protected video (e.g. Netflix, Crunchyroll) | Draws a semi-transparent scanline/noise/vignette overlay on top of the video — no pixel capture needed |

The mode badge in the popup shows which mode is active. Overlay mode can only darken the picture, so it approximates scanlines, mask, interlace, noise, hum and the screen edge. The Signal and Glass sections only take effect in full mode.

## Presets

| Preset | Look |
|--------|------|
| Subtle | Light aperture grille and scanlines, gentle glow |
| Heavy | Slot mask, 240p, strong curvature and halation |
| VHS | Soft, smeared colour, snow, tracking tear |
| Arcade | Sharp 240p with a shadow mask and pronounced scanlines |
| Retro TV | Consumer set: slot mask, interlace, 9300K white |
| Late Night | Heavy bloom and halation, long phosphor trails |

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

`content.js` is injected into every page. It watches the DOM for `<video>` elements via MutationObserver, attaches to the largest visible one, and creates a WebGL2 canvas positioned over (or replacing) the video. Each frame runs the signal → beam → glow → composite passes described above. Settings sync across tabs via `chrome.storage.sync`.

## Project structure

```
manifest.json    — MV3 extension manifest
content.js       — video detection, WebGL pipeline, GLSL shaders, render loop
popup.html       — settings UI (sliders, presets, toggle)
popup.js         — popup logic and chrome.storage sync
background.js    — keyboard shortcut handler
icon*.png        — extension icons
```

## License

MIT
