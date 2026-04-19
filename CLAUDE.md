# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Even G2 ePub Reader (v1.3.0) — a web app for reading EPUB books on Even Realities G2 smart glasses. Built with TypeScript, Vite, Even Hub SDK (v0.0.10), and even-toolkit. Renders paginated text to a 576x288px monochrome display.

## Commands

```bash
npm run dev          # Start dev server + show QR code for device pairing
npm run dev:sim      # Start dev server + open browser simulator
npm run build        # Production build (also used as validation — must pass)
npm run test         # Run regression tests via Node's native test runner
npm run preview      # Preview production build locally
npm run pack         # Build + package as .ehpk for Even Hub distribution
npm run pack:check   # Validate package structure against app.json schema
```

Tests live in `tests/*.test.ts` and run via Node's native `--test` with `--experimental-strip-types` (no Jest/Vitest). Run a single test file with `node --experimental-strip-types --test tests/app-json.test.ts`. Additional ad-hoc integration scripts exist at the root (`test-gutenberg.mjs`, `test-proxy.mjs`, `test-scraper.mjs`, `proxy-test.mjs`) — run with `node <script>.mjs`. Validate changes with `npm run build` and `npm run test`.

## Architecture

```
index.html → main.ts (bootstrap, UI wiring, file upload, settings panel, keep-alive, launch source)
               ├── EvenEpubClient (even-client.ts) — core app logic
               │     Manages views, navigation, reading modes, position persistence
               │     Uses mapGlassEvent() from even-toolkit for event handling
               │     Uses notifyTextUpdate()/armImmediateScroll() for gesture debouncing
               ├── parseEpub (epub-parser.ts) — EPUB ZIP → Chapter[] via JSZip + DOM parsing + cleanForG2()
               ├── paginateText (paginator.ts) — word-wrap with language-aware hyphenation
               ├── gutenberg.ts — fetch/download Project Gutenberg books via CORS proxy
               ├── splash-bridge.ts — SplashBridge adapter for raw SDK bridge
               ├── db.ts — IndexedDB local cache for recently opened books (max 3)
               ├── mock-bridge.ts — browser simulator fallback (renders to canvas)
               ├── constants.ts — display specs, config management, storage keys
               ├── utils.ts — shared helpers (status display, timeout wrapper, clamp, truncation)
               └── types.ts — shared type definitions (Chapter, Book, ViewState, etc.)
```

**Two reading modes:** Paged (page-by-page, swipe navigation) and Flow (word-by-word streaming, configurable 120-600 WPM). A "Text height" setting (50–100 % in 10 % steps) crops the reading area from the top, leaving the upper portion of the G2 display blank; lines-per-page shrinks proportionally. Implementation: the text container always fills the full available height (keeps `isEventCapture=1` coverage so no swipe is lost), and the crop is rendered by prepending `topBlankLines` leading blank lines to each page — see `getTextLayout()` in `constants.ts`.

**Text pipeline:** Raw HTML → plain text extraction (epub-parser) → cleanForG2() per line → language detection → word-wrap with hyphenation → page splitting (paginator) → display rendering.

**even-toolkit integration:** Uses glasses-side modules only (no React). Event mapping via `action-map`, gesture debouncing via `gestures`, text safety via `text-clean`, WebView keep-alive via `keep-alive`. Does NOT use `EvenHubBridge` from toolkit — the app uses the raw SDK bridge directly for custom container layouts (status bars, chapter grid).

**Persistence:** Reading positions saved to bridge localStorage per book title + browser localStorage as fallback. Config (hyphenation, status bar, reading mode, flow speed) in browser localStorage. Book files cached locally only — IndexedDB primary, base64 in bridge localStorage as fallback (max 3 books). No cloud storage.

**Entry points:** `index.html` is the main reader app. `gutenberg.html` is a standalone page for browsing/downloading Project Gutenberg books.

**Glasses-side views:** bookPicker → library (chapter list) → reading/flowReading. Splash screen on startup via even-toolkit `createSplash`. Book picker shows cached books from bridge localStorage; tap to load, double-tap to exit app.

**Gesture mapping:** Swipe up/down = prev/next page or browse books/chapters. Tap = select book/chapter or start/pause flow. Double-tap = back (reading→chapters→picker→exit).

**Position persistence:** Saved on every page turn to two layers: bridge localStorage (device) and browser localStorage (WebView fallback). Restored by trying bookId key first, then title key, across both layers.

**Web UI:** Even Realities light theme (CSS custom properties). No React — vanilla HTML/CSS/JS. Collapsible settings/Gutenberg sections. Toggle switch for hyphenation. A context-aware "Reader" card appears while a book is open and exposes Prev/Next (paged) or Start/Pause + chapter jumps (flow). Version shown in header.

## Key Dependencies

- `@evenrealities/even_hub_sdk` (0.0.10) — G2 glasses SDK bridge
- `even-toolkit` (1.7.x) — glasses gesture/event/text/splash modules + CSS design tokens (no React)
- `jszip` — EPUB ZIP parsing
- `hypher` + `hyphenation.*` — language-aware word hyphenation (en, de, es, fr, nl, pl, pt, ru, uk)
- `upng-js` — PNG encoding for splash screen tiles

## Code Style

- 2-space indentation, semicolons, strict TypeScript
- camelCase variables/functions, PascalCase classes/types, kebab-case filenames
- No linter/formatter configured — match existing style, keep diffs clean
- Imperative commit messages (e.g., "Fix Gutenberg parser header matching")
- Share constants in `constants.ts` and types in `types.ts`
- Always call `notifyTextUpdate()` after `rebuildPageContainer()` calls
- Use `/even-dev` skill for Even Realities SDK/toolkit reference
