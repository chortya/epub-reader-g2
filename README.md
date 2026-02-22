# EPUB Reader for Even Realities G2

Read EPUB books on your Even Realities G2 smart glasses. Upload an EPUB file via the web UI, then read page-by-page using touchpad gestures on the glasses display.

## Features

- **EPUB parsing** — extracts chapters and metadata from standard EPUB files
- **Smart text layout** — word wrapping with language-aware hyphenation (English, German, Russian, Ukrainian)
- **Touchpad navigation** — swipe up/down for pages, tap to select chapters, double-tap for chapter list
- **Reading progress** — visual progress bar and automatic position saving across sessions
- **Chapter browser** — paginated chapter list for quick navigation
- **Browser testing mode** — develop and test in a web browser without glasses connected

## Getting Started

### Prerequisites

- Node.js and npm

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
| Double-tap | Return to chapter list |

## Display Specs

Optimized for the Even G2 display: **576×288 px**, using native text rendering.
- **Layout**: ~60 characters per line, 9 lines per page.
- **Hyphenation**: English, German, Russian, Ukrainian.

## Startup Screen

Displays "G2 ePUB Reader" using native text widgets for reliable rendering on the glasses.

## Tech Stack

- TypeScript + Vite
- [Even Hub SDK](https://www.npmjs.com/package/@evenrealities/even_hub_sdk)
- JSZip (EPUB parsing)
- Hypher (hyphenation)

## License

All rights reserved.
