# Even G2 ePub Reader

Read EPUB books directly on your Even Realities G2 smart glasses. Upload an EPUB file via the web UI or download one of the Top 100 public domain titles from Project Gutenberg, then read page-by-page using touchpad gestures on the glasses display.

## Features

- **EPUB parsing** — extracts chapters and metadata from standard EPUB files
- **Project Gutenberg integration** — discover and download the Top 100 free books directly from the reader UI
- **Smart text layout** — word wrapping with language-aware hyphenation (English, German, Spanish, French, Dutch, Polish, Portuguese, Russian, Ukrainian)
- **Touchpad navigation** — swipe up/down for pages, tap to select chapters, with mode-specific tap/double-tap actions while reading
- **Flow reading mode** — optional word-by-word page stream with adjustable speed and single-tap start/pause
- **Customizable Layout** — configure the visual layout with horizontal (bottom) or vertical (right) progress bars
- **Reading progress** — visual progress indicators and automatic position saving across sessions
- **Local-first storage** — books and positions are cached on-device; no network or account needed once a book is loaded
- **Chapter browser** — paginated chapter list for quick navigation
- **Browser testing mode** — develop and test in a web browser without glasses connected

## Getting Started

### Prerequisites

- Node.js and npm
- Even Hub tooling for QR/device workflows

### Install

```bash
npm install
```

### Development

```bash
npm run dev
npm run dev:sim
```

`npm run dev` starts the Vite dev server and auto-generates a QR for `/`.
`npm run dev:sim` starts the dev server in simulator mode (`/?simulator=true`) and auto-generates a QR for that path.

### Build & Package

```bash
npm run build       # Build to ./dist
npm run test        # Run regression tests
npm run pack        # Build + package as epub-reader.ehpk
npm run pack:check  # Validate package without output
```

### QR Code (manual)

```bash
npm run qr
npm run qr:sim
```

## Controls

| Gesture | Action |
|---------|--------|
| Swipe down | Next page / next chapter |
| Swipe up | Previous page / previous chapter |
| Tap | Select chapter |
| Double-tap (Paged mode) | Return to chapter list |
| Tap (Flow mode) | Start/Pause flow |
| Double-tap (Flow mode, paused) | Return to chapter list |

## Storage Behavior

- IndexedDB keeps the 3 most recent books for fast reload in the browser/WebView.
- Bridge local storage keeps a base64 fallback of those same books so they survive app restarts on the glasses device.
- Reading positions are saved on every page turn to bridge storage (per bookId and per title) with browser localStorage as a secondary fallback.
- Web library lists local books only; deleting from the web UI prompts for confirmation and removes both the IndexedDB entry and the bridge-storage copy.

## Display Specs

Optimized for the Even G2 display: **576×288 px**, using native text rendering.
- **Layout**: ~59 characters per line in standard mode, fewer for right-side progress bar or wider Cyrillic glyphs.
- **Hyphenation**: English, German, Spanish, French, Dutch, Polish, Portuguese, Russian, Ukrainian.

## Startup Screen

Displays "G2 ePUB Reader" using native text widgets for reliable rendering on the glasses.

## Tech Stack

- TypeScript + Vite
- [Even Hub SDK](https://www.npmjs.com/package/@evenrealities/even_hub_sdk)
- [even-toolkit](https://www.npmjs.com/package/even-toolkit) (gestures, splash, keep-alive)
- JSZip (EPUB parsing)
- Hypher (hyphenation)
- UPNG.js (splash tile encoding)

## Verification

- `npm run build`
- `npm run test`
- `npm run dev`
- `npm run dev:sim`

## License

All rights reserved.
