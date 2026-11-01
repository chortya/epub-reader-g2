# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Even G2 ePub Reader (v1.6.0, app name "ePub Reader") — a web app for reading EPUB books on Even Realities G2 smart glasses. Built with TypeScript, Vite, Even Hub SDK (v0.0.16), and even-toolkit. Renders paginated text to a 576x288px monochrome display.

## Commands

```bash
npm run dev          # Start dev server + show QR code for device pairing
npm run dev:sim      # Start dev server + open browser simulator
npm run build        # Production build (also used as validation — must pass)
npm run test         # Run regression tests via Node's native test runner
npm run preview      # Preview production build locally
npm run typecheck    # tsc --noEmit (must pass)
npm run pack:dev     # Build + package for sideloading (no relay)
npm run pack         # Release: needs VITE_RELAY_ORIGIN (whitelisted + in PRIVACY.md), then build + .ehpk
```

Tests live in `tests/*.test.ts` and run via Node's native `--test` with `--experimental-strip-types` (no Jest/Vitest). Suites include `app-json.test.ts` (version/SDK sync, whitelist shape, listing limits, one app name everywhere), `kosync*.test.ts` (DOM via `linkedom`), `relay.test.ts`, plus paginator/settings/position/lifecycle suites. Run a single file with `node --experimental-strip-types --test tests/app-json.test.ts`. Test imports of local TS modules must include the `.ts` extension. Validate changes with `npm run typecheck`, `npm run build` and `npm run test`.

## Architecture

```
index.html → main.ts (bootstrap, UI wiring, file upload, settings panel, keep-alive, launch source)
               ├── EvenEpubClient (even-client.ts) — core app logic
               │     Manages views, navigation, reading modes, position persistence
               │     Uses mapGlassEvent() from even-toolkit for event handling
               │     Uses notifyTextUpdate()/armImmediateScroll() for gesture debouncing
               ├── parseEpub (epub-parser.ts) — EPUB ZIP → Chapter[] via JSZip + DOM parsing + cleanForG2()
               ├── paginateText (paginator.ts) — word-wrap with language-aware hyphenation
               ├── gutenberg.ts — fetch/download Project Gutenberg books via the relay (relay.ts)
               ├── kosync.ts / kosync-session.ts / kosync-locator.ts — KOReader progress sync
               │     (protocol client, per-book push/pull pacing, XPointer <-> offset mapping)
               ├── splash-bridge.ts — SplashBridge adapter for raw SDK bridge
               ├── db.ts — content-addressed IndexedDB library + bridge fallback (no silent eviction)
               ├── mock-bridge.ts — browser simulator fallback (renders to canvas)
               ├── constants.ts — display specs, config management, storage keys
               ├── utils.ts — shared helpers (status display, timeout wrapper, clamp, truncation)
               ├── book-id.ts — deterministic bookId from filename+title (hash+slug); resolveLastBook() for Continue Reading
               ├── chapter-title.ts — picks/normalizes chapter titles (spine > heading > document)
               ├── launch.ts — pickInitialView() pure post-splash view decision (glassesMenu vs mainMenu)
               └── types.ts — shared type definitions (Chapter, Book, ViewState, etc.)
```

**Two reading modes:** Paged (page-by-page, swipe navigation) and Flow (word-by-word streaming, configurable 120-600 WPM). A "Text height" setting (50–100 % in 10 % steps) crops the reading area from the top, leaving the upper portion of the G2 display blank; lines-per-page shrinks proportionally. Implementation: the text container always fills the full available height (keeps `isEventCapture=1` coverage so no swipe is lost), and the crop is rendered by prepending `topBlankLines` leading blank lines to each page — see `getTextLayout()` in `constants.ts`.

**Text pipeline:** Raw HTML → plain text extraction (epub-parser) → cleanForG2() per line → language detection → word-wrap with hyphenation → page splitting (paginator) → display rendering.

**even-toolkit integration:** Uses glasses-side modules only (no React). Event mapping via `action-map`, gesture debouncing via `gestures`, text safety via `text-clean`, WebView keep-alive via `keep-alive`. Does NOT use `EvenHubBridge` from toolkit — the app uses the raw SDK bridge directly for custom container layouts (status bars, chapter grid).

**Persistence:** Reading positions saved to bridge localStorage per book identity/title + browser localStorage as fallback. Config (hyphenation, status bar, reading mode, flow speed, text height) written to BOTH bridge localStorage (via `saveSettingsToBridge`, persists across device app restarts) AND browser localStorage (fast warm-start on simulator). Book files use a content-addressed IndexedDB library with a base64 bridge fallback; there is no silent three-book eviction, and same-named EPUBs stay isolated. "Continue Reading" on the mainMenu resolves from three bridge keys written together on every save: `epub-book-title`, `epub-last-book-id`, `epub-last-book-filename`. No cloud storage of books; the only remote state is the optional KOReader progress sync (`epub-kosync` settings key).

**Entry point:** `index.html` is the whole app. `relay/` is a separate Cloudflare Worker (Gutenberg + kosync forwarding with CORS) the developer deploys; packaged builds require it (Even Hub whitelist + WebView CORS).

**Glasses-side views:** `mainMenu` (Continue / Library (N) / Settings) → `bookPicker` → `library` (chapter list) → `reading` / `flowReading`. Also `settings` (5-item list) and `settingEditor` (per-setting value picker) reachable from `mainMenu`. Splash screen on startup via even-toolkit `createSplash`; after splash, `pickInitialView` (in `src/launch.ts`) decides between direct-resume (when launched from `glassesMenu` with a resolvable last book) and `mainMenu`.

**Gesture mapping:** Swipe up/down = prev/next page or browse list items. Tap = select book/chapter/setting value or start/pause flow. Double-tap = back one level (reading→chapters→mainMenu→exit-app). Only 4 SDK gestures exist (`CLICK`, `DOUBLE_CLICK`, `SCROLL_TOP`, `SCROLL_BOTTOM`); no long-press / triple-tap / temple-swipe available — see `docs/1.4.0-on-device-settings-and-menu.md` §2.2.

**Position persistence:** Saved on every page turn to two layers: bridge localStorage (device) and browser localStorage (WebView fallback). Restored by trying bookId key first, then title key, across both layers. Since v1.4.0, every save also writes `STORAGE_KEY_LAST_BOOK_ID` and `STORAGE_KEY_LAST_BOOK_FILENAME` so the mainMenu's Continue Reading resolver can match by bookId — never by title alone.

**Web UI:** Even Realities light theme (CSS custom properties). No React — vanilla HTML/CSS/JS. Collapsible settings/Gutenberg sections. Toggle switch for hyphenation. A context-aware "Reader" card appears while a book is open and exposes Prev/Next (paged) or Start/Pause + chapter jumps (flow). Version shown in header.

## G2 Platform Constraints

- **Display:** 576×288 px monochrome; max 12 containers per page; max 1 `isEventCapture=1` container per page (must cover the full tap area or swipes are lost — see the Text-height note above).
- **Startup vs runtime:** `createStartUpPageContainer` is text-only (no images). Images only work in `rebuildPageContainer`.
- **Text updates:** use `textContainerUpgrade` for flicker-free content swaps; `rebuildPageContainer` for layout changes (causes brief flicker). Always call `notifyTextUpdate()` after `rebuildPageContainer()`.
- **Version sync:** `app.json.version` must match `package.json.version` — `tests/app-json.test.ts` fails otherwise. Same test checks the Even Hub SDK version referenced in `app.json`.
- **Deeper reference:** `ARCHITECTURE.md` (in repo root) and the `/even-dev` skill cover SDK details and G2 quirks.

## Key Dependencies

- `@evenrealities/even_hub_sdk` (0.0.16) — G2 glasses SDK bridge
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
