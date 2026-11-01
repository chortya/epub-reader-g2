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
- **KOReader progress sync** — keep your place in step with KOReader and other kosync-compatible apps (optional; see below)
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
npm run typecheck   # tsc --noEmit
npm run pack:dev    # Package for sideloading (no relay required)
VITE_RELAY_ORIGIN=https://<relay> npm run pack   # Release package (see docs/1.6.0-submission.md)
```

Packaged builds reach Project Gutenberg and KOReader sync servers through a
small relay you deploy yourself ([relay/README.md](relay/README.md)). Even Hub
only allows whitelisted, CORS-enabled origins, and neither service sends CORS
headers.

## BookOrbit

If your books live in [BookOrbit](https://github.com/bookorbit/bookorbit), pick **BookOrbit** as the
server type under Sync server and log in with the KOReader login from BookOrbit. You get:
- progress sync with BookOrbit's web reader and your KOReader devices;
- a **BookOrbit library** section to download EPUBs;
- reading time in BookOrbit's statistics;
- books marked read when you finish them.

BookOrbit needs CORS headers on its KOReader API and a personal build that whitelists it. See
[docs/bookorbit.md](docs/bookorbit.md).

## KOReader progress sync

Open **Progress sync (KOReader)** on the phone. Enter the same server and
account as in KOReader (Settings → Progress sync), then log in or create an
account.

Syncing happens at these points:
- **When a book opens:** a newer position from another device is applied.
- **While you read:** about 15 s after your last page turn.
- **When the app goes to the background or exits.**
- **On request:** with **Sync progress** in the glasses' hold menu.

Books are matched the way KOReader matches them by default: a partial MD5
of the file, or the file name if you switch "Match books by". Positions
are exchanged at paragraph precision.

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

- IndexedDB keeps the full local library for fast reload in the browser/WebView. Content-based IDs prevent same-named EPUBs from overwriting one another.
- Bridge local storage keeps a base64 fallback of those same books so they survive app restarts on the glasses device.
- Reading positions are saved on every page turn to bridge storage (per bookId and per title) with browser localStorage as a secondary fallback.
- Web library lists local books only; deleting from the web UI prompts for confirmation and removes both the IndexedDB entry and the bridge-storage copy.

## Display Specs

Optimized for the Even G2 display: **576×288 px**, using native text rendering.
- **Layout**: lines wrap by pixel width using the firmware's own font metrics, so they fill the 564 px text area without the glasses re-wrapping them.
- **Hyphenation**: English, German, Spanish, French, Dutch, Polish, Portuguese, Russian, Ukrainian.

## Startup Screen

Displays "ePub Reader" using native text widgets for reliable rendering on the glasses.

## Tech Stack

- TypeScript + Vite
- [Even Hub SDK](https://www.npmjs.com/package/@evenrealities/even_hub_sdk)
- [even-toolkit](https://www.npmjs.com/package/even-toolkit) (gestures, splash, keep-alive)
- JSZip (EPUB parsing)
- Hypher (hyphenation)
- UPNG.js (splash tile encoding)

## Privacy

See [PRIVACY.md](PRIVACY.md). The reader is local-first, and the only optional
remote state is KOReader progress sync.

## Verification

- `npm run build`
- `npm run test`
- `npm run typecheck`
- `npm run dev`
- `npm run dev:sim`

## License

All rights reserved.
