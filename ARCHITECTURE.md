# Architecture

This document describes how the **Even G2 ePub Reader** is put together as of
**v1.3.0**. It is meant for contributors touching the codebase; user-facing
docs live in `README.md` / `CHANGELOG.md` and high-level conventions live in
`CLAUDE.md`.

## 1. What it is

A single-page TypeScript web app that runs inside the Even Hub WebView and
renders EPUB books onto the Even Realities G2 smart-glasses display
(576 × 288 px, 16-level greyscale). The same build also runs in a desktop
browser with a mocked bridge for development.

Two entry points ship in the built bundle:

| Path              | Purpose                                                           |
|-------------------|-------------------------------------------------------------------|
| `index.html`      | Main reader (library, upload, settings, on-glasses viewer)        |
| `gutenberg.html`  | Standalone Project Gutenberg browser                              |

## 2. Runtime stack

- **Language**: TypeScript 6, `strict: true`, ES2022 modules.
- **Build**: Vite 8 (Bundler module resolution, so `./foo.ts` imports are
  allowed in source).
- **Tests**: Node 22+ native test runner with `--experimental-strip-types` —
  no Jest / Vitest.
- **Runtime dependencies**:
  - `@evenrealities/even_hub_sdk` (0.0.10) — raw bridge to the G2 device.
  - `even-toolkit` (1.7.x) — gesture mapping, splash, text cleaning,
    keep-alive (no React — we use the glasses-side modules only).
  - `jszip` — EPUB ZIP extraction.
  - `hypher` + `hyphenation.*` — per-language word hyphenation.
  - `upng-js` — PNG encoding for the splash screen.

## 3. Module map (`src/`)

```
main.ts              entry: bridge setup, UI wiring, upload, Gutenberg, library render, settings panel,
                     Reader-controls card, auto-resume, keep-alive activation.
even-client.ts       EvenEpubClient: views, navigation, reading modes, gesture handling,
                     position persistence. Talks to the raw SDK bridge directly.
epub-parser.ts       EPUB ZIP -> Chapter[]: ZIP unpacking, OPF/spine traversal, DOM-based plain-text
                     extraction, cleanForG2() per line, language detection, hyphenator loading.
paginator.ts         Plain text -> string[] pages: word-wrap at character width with end-of-line
                     hyphenation fallback; page line count derived from getTextLayout().
constants.ts         DISPLAY_* / LINE_HEIGHT_PX, the persistent `config` object, TEXT_HEIGHT_* limits,
                     loadSettings() / saveSettings(), getTextLayout() — central layout math.
types.ts             Shared type aliases: Chapter, Book, ViewState, ReadingPosition, CachedBookMeta.
utils.ts             setStatus / appendEventLog / withTimeout / clamp / truncateForList.
db.ts                Local book cache: IndexedDB primary + bridge-localStorage fallback (base64),
                     max 3 books. pruneBridgeBooks() is pure and unit-tested.
mock-bridge.ts       Browser-simulator bridge: intercepts SDK methods and renders containers into
                     a DOM canvas; provides Prev/Next/Tap/DblTap buttons.
splash-bridge.ts     Adapter exposing an even-toolkit SplashBridge interface on top of the raw SDK.
gutenberg.ts         Fetches the Gutenberg Top 100 and downloads individual EPUBs via a CORS proxy.
book-id.ts           Deterministic slug-safe ID derived from filename + title hash.
chapter-title.ts     Picks the best-looking chapter title from spine / heading / document-title
                     candidates (generic "Chapter N" labels deprioritized).
logo.ts              Embedded logo byte data used on the upload page.
```

## 4. High-level component diagram

```
                      +-------------------------------+
                      |           index.html          |
                      |  (settings, library, upload,  |
                      |   Gutenberg, Reader card,     |
                      |    simulator container)       |
                      +---------------+---------------+
                                      |
                                      v
                      +-------------------------------+
                      |            main.ts            |
                      |  - bridge discovery           |
                      |  - EvenEpubClient instance    |
                      |  - UI event wiring            |
                      |  - onViewChanged / onPosition |
                      |    / onFlowStateChanged renders
                      |    Library + Reader card      |
                      +--------+--------------+-------+
                               |              |
                   parseEpub() |              | loadBook(), applySettings(),
                               v              |  pagedNext/Prev, toggleFlow...
                 +------------------------+   |
                 |     epub-parser.ts     |   |
                 +-----------+------------+   v
                             |       +----------------------------+
                             |       |      EvenEpubClient        |
                             +------>|   (even-client.ts, 1k LOC) |
                                     |                            |
                                     |  chapterPages[][]          |
                                     |  flowPageData[][]          |
                                     |  view state machine        |
                                     |  gesture -> action -> view |
                                     +---+-------+----------+-----+
                                         |       |          |
                                         | paginateText()   |
                                         v       |          |
                             +------------------+|          |
                             |    paginator.ts  ||          |
                             +---+--------------+|          |
                                 |     getTextLayout()      |
                                 v   |                      |
                             +------------------+           |
                             |   constants.ts   |<----------+ (config reads)
                             |  config / layout |
                             +------------------+
                                         |
                                         | SDK calls (rebuildPageContainer,
                                         |  textContainerUpgrade, storage)
                                         v
                      +-------------------------------+
                      |   Bridge (one of two)         |
                      | - Even Hub SDK (real device)  |
                      | - MockBridge (browser/sim)    |
                      +-------------------------------+
```

## 5. Data model

From `src/types.ts`:

```ts
type Chapter         = { title: string; text: string };
type Book            = { title: string; chapters: Chapter[] };
type ViewState       = 'bookPicker' | 'library' | 'reading' | 'flowReading';
type ReadingPosition = { chapterIndex: number; pageIndex: number; wordIndex?: number };
type CachedBookMeta  = { bookId: string; title: string; filename: string; uploadedAt: number };
```

Each chapter is flattened to plain text during parse. The reader never holds
the original HTML — styling, images, and markup are discarded by design
(G2 is monochrome, 58-ish chars per line).

## 6. View state machine

```
                       +------------+
             startup   |            |   book picked
   (connect) -------->  bookPicker   -----------+
             (cached)  |            |           |
                       +-----+------+           |
                             | dbl-tap          |
                             v  (exit)          v
                       +------------+     +-----------+
                       |            |     |           |
                       |  library   +---->|  reading  |   (config.readingMode=paged)
                       |  (chapter  |  tap|           |
                       |    list)   |<----+           |
                       +-----+------+ dbl-tap (back)  |
                             |                        +--+
                             |                           |
                             |                (config.readingMode=flow)
                             v                           v
                       +------------+              +---------------+
                       |  welcome   |              |  flowReading  |
                       +------------+              +---------------+
```

Transitions are driven either by mapped gestures (see §7) or by internal
navigation after book selection / end-of-chapter. `onViewChanged` fires on
every transition; the web UI uses it to show/hide the Reader card.

## 7. Gesture pipeline

Raw SDK events reach the app via `bridge.onEvenHubEvent`. They flow through
three layers:

```
SDK event -------> mapGlassEvent() ------> switch(action.type) in EvenEpubClient
(SCROLL_TOP,      (even-toolkit/          (HIGHLIGHT_MOVE | SELECT_HIGHLIGHTED | GO_BACK)
 SCROLL_BOTTOM,    action-map)            + view-dependent dispatch
 CLICK,
 DOUBLE_CLICK,
 FOREGROUND_*,
 SYSTEM_EXIT)
```

Two debouncing helpers from `even-toolkit/gestures` are used around display
updates: `notifyTextUpdate()` after every `rebuildPageContainer` /
`textContainerUpgrade` (suppresses spurious scroll events for ~80 ms) and
`armImmediateScroll()` before a view transition (makes the first swipe
responsive again).

`SYSTEM_EXIT_EVENT` and `FOREGROUND_EXIT_EVENT` flush positions to
persistence before the process dies.

## 8. Text pipeline

```
uploaded .epub (ArrayBuffer)
    |
    v
JSZip -> OPF -> spine hrefs ----------------+
    |                                        |
    | per chapter HTML                       |
    v                                        |
extractTextFromHtml() (DOMParser)            | chapter title
    |                                        |
    v                                        |
cleanForG2() per line (even-toolkit)         |
    |                                        |
    v                                        v
                 Chapter { title, text }
    |
    v (once per Book load and on applySettings)
paginateText(text, maxChars, maxLines)
    |    ^
    |    +-- getTextLayout() reads config.textHeightPercent, statusBarPosition
    |         and returns { maxLines, topBlankLines, ... }
    v
string[]  (one entry per page)
    |
    +---> chapterPages[]   (paged reading mode)
    |
    +---> flowPageData[]   (tokens + wordCount per page, for flow mode)
```

### 8.1 Paginator

- `maxChars` is 58–59 for Latin glyphs, 45–48 for wide Cyrillic glyphs,
  with a ‑1 adjustment when the right-side status bar steals width.
- `maxLines` comes from `getTextLayout()` — see §9.
- Hyphenation is language-aware and applies either at end-of-line (preferred
  break inside a word that doesn't fit) or across a single word longer than
  a full line.

### 8.2 Flow mode

Per-page tokenization (`/\S+|\s+/g`) lets the flow ticker reveal one
non-whitespace token per beat at `config.flowSpeedWpm` WPM. When the full
page is revealed the ticker advances to the next page's first word and keeps
going. Flow position serializes `wordIndex` in addition to chapter/page.

## 9. Display layout math

The G2 display is 576 × 288 px; `LINE_HEIGHT_PX = 28`. The area not consumed
by the status bar is `availableHeight = 288 − (bottom ? 30 : 0)`.

`getTextLayout()` returns a single geometry object used by every reading
view:

```ts
{
  availableHeight,                   // 258 or 288 px
  usableHeight: availableHeight,     // text container is ALWAYS full-height
  yPosition: 0,                      // anchored at the top
  maxLines,                          // how many text lines the paginator produces
  topBlankLines,                     // how many blank lines to prepend at render time
  barHeight,                         // 30 or 0
}
```

**Why is the container always full-height?** Only containers with
`isEventCapture: 1` receive swipe events. A shorter container would leave a
dead zone that silently swallows swipes (observed as "need two swipes to
turn a page" at 50 % and 60 %). Rendering the visual crop with leading
`\n`-padding inside a full-size container keeps every swipe on target.

**Line count derivation**:

```
displayLines   = floor(availableHeight / LINE_HEIGHT_PX)     // 9 or 10
targetUsable   = floor(availableHeight * textHeightPercent / 100)
maxLines       = min(displayLines, floor(targetUsable / LINE_HEIGHT_PX))
topBlankLines  = displayLines - maxLines
```

Examples (bottom status bar on):

| `textHeightPercent` | `maxLines` | `topBlankLines` |
|---|---|---|
| 100 | 9 | 0 |
| 90  | 8 | 1 |
| 80  | 7 | 2 |
| 70  | 6 | 3 |
| 60  | 5 | 4 |
| 50  | 4 | 5 |

## 10. Persistence

Five independent storage lanes, all keyed by book identity:

```
+-------------------+----------------------+-------------------------------+-------------------------------+
| Data              | Primary              | Fallback                      | Key pattern                   |
+-------------------+----------------------+-------------------------------+-------------------------------+
| Book files        | IndexedDB            | bridge.setLocalStorage        | BRIDGE_BOOKS_KEY (array,      |
| (max 3)           | (db.ts, store:books) | base64, max 3                 |  each { filename, title, ...})|
+-------------------+----------------------+-------------------------------+-------------------------------+
| Cached book list  | bridge local storage | (none)                        | 'epub-book-list'              |
| (glasses picker)  |                      |                               |                               |
+-------------------+----------------------+-------------------------------+-------------------------------+
| Paged position    | bridge local storage | window.localStorage           | STORAGE_KEY_POSITION + bookId |
|                   |                      | (WebView fallback)            | + STORAGE_KEY_POSITION + title|
+-------------------+----------------------+-------------------------------+-------------------------------+
| Flow position     | bridge local storage | window.localStorage           | STORAGE_KEY_FLOW_POSITION +...|
+-------------------+----------------------+-------------------------------+-------------------------------+
| App settings      | window.localStorage  | (none)                        | SETTINGS_KEY                  |
| (AppConfig)       |                      |                               |                               |
+-------------------+----------------------+-------------------------------+-------------------------------+
```

- **Book files** use IndexedDB for fast local reads and mirror to the bridge
  storage in the background so the glasses-side book picker can see them.
- **Positions** are saved on every page turn to *both* lanes. Read path
  tries `bookId` first, then `title`, then bridge, then browser
  localStorage — whichever returns valid state first wins.
- **Settings** pass through the pure `loadSettings(raw): Partial<AppConfig>`
  at module load (see §11); `saveSettings()` serializes the whole `config`
  object, so adding a new field is automatically forward-compatible.

## 11. Settings lifecycle

```
first page load
    |
    v
constants.ts module evaluates
    |
    v
Object.assign(config, loadSettings(localStorage.getItem(SETTINGS_KEY)))
    |
    v
DOM ready: main.ts binds <select>/<input>/<slider> values from `config`
    |
    v
user clicks "Apply Settings"
    |
    v
main.ts mutates `config` with validated values from the DOM
    |
    v
saveSettings() writes JSON.stringify(config) to localStorage
    |
    v
client.applySettings()
    |
    +- repaginate all chapters
    +- rescale pageIndex via old/new page-count ratio
    +- force flowLayoutReady = false (forces full rebuild next frame)
    +- refreshCurrentView()
```

`loadSettings` is pure and exhaustively tested
(`tests/settings-persistence.test.ts`): it validates each field,
clamps numeric ranges, rejects non-object JSON, migrates the legacy
`showStatusBar` boolean to the newer `statusBarPosition` enum, and returns
`{}` on any parse error so the caller just keeps defaults.

## 12. Web-UI reader controls

A DOM card (`#reader-controls`) visible only while a book is open. Its
visibility and contents react to three client callbacks:

```
onViewChanged        --> re-renders based on client.getView()
onPositionChanged    --> re-renders to refresh can*() boundary buttons
onFlowStateChanged   --> flips the Start/Pause label
```

The buttons call public wrappers on `EvenEpubClient`
(`pagedNext`, `pagedPrev`, `toggleFlowPlayback`, `flow{Prev,Next}Chapter`).
Internally those dispatch through the same view-transition paths as the
gesture pipeline, so device and web interactions are fully symmetric.

## 13. Bridge abstraction

`main.ts` tries `waitForEvenAppBridge()` with a 2.5 s timeout. On success the
real SDK bridge is used. On timeout (or when the URL contains
`?simulator=true`) it falls back to `MockBridge` — a class that implements
the subset of SDK methods the client actually uses and renders text
containers into a DOM canvas in the page.

`MockBridge` is singleton; the `rebuildPageContainer` / `textContainerUpgrade`
calls update `#sim-screen`, and button clicks (Swipe Up, Swipe Down, Tap,
DblTap) synthesize `EvenHubEvent` objects that flow through the same
`onEvenHubEvent` listeners as on device. This is why tests that exercise
client logic still need a DOM host (we don't run them in Node today).

## 14. Testing

All tests live in `tests/*.test.ts` and run with:

```
node --experimental-strip-types --test tests/*.test.ts
```

Tests are pure: they import `src/*.ts` directly (using explicit `.ts`
extensions — Node's native TS mode requires them) and exercise side-effect
free functions. There is no jsdom / Vitest / Jest.

Current suites (v1.3.0 → 45 tests):

- `app-json.test.ts` — manifest / package version alignment, SDK version
  consistency, `supported_languages` matches hyphenation set, network
  whitelist covers hard-coded hosts.
- `paginator.test.ts` — default line counts, text-height crop math,
  `getTextLayout` invariants (full-height container, `maxLines +
  topBlankLines = displayLines`).
- `review-regressions.test.ts` — `makeBookId` stability,
  `pruneBridgeBooks` set semantics, `pickChapterTitle` priority order.
- `settings-persistence.test.ts` — `loadSettings` clamping, type
  rejection, `showStatusBar` migration, `JSON.stringify(config)` round-trip.

The app-json test enforces a number of release invariants, so simply
forgetting to bump `app.json` version alongside `package.json` is caught
automatically at `npm test`.

## 15. Build, release, and packaging

```
npm run build      Vite production build into dist/
npm run test       run the Node native test suite
npm run pack       build + package dist/ as epub-reader.ehpk for Even Hub
npm run pack:check validate packaging against app.json schema
npm run dev        Vite + QR code for device pairing
npm run dev:sim    Vite + native Even Hub simulator
```

Release sequence when cutting a new version:

1. Bump `version` in **both** `package.json` and `app.json` (the
   `app.json` test enforces equality; hand-edit both).
2. Update `index.html` header badge (`v1.x.y`) and `CLAUDE.md` project line.
3. Add a `CHANGELOG.md` entry dated with today's date.
4. `npm run build && npm run test` — must be green.
5. `npm run pack` — writes `epub-reader.ehpk` at repo root.
6. Commit with an imperative message; Claude-authored commits include the
   `Co-Authored-By: Claude Opus 4.7 (1M context)` trailer.
7. Upload the `.ehpk` to the Even Hub Dev Portal
   (https://preview.evenhub.evenrealities.com) for marketplace review.

## 16. Non-goals

- **Rich text rendering**: G2 is monochrome and font-fixed; we deliberately
  discard HTML styling, images, tables, and RTL special casing.
- **Cloud sync**: books and positions stay on the device plus the local
  browser. No remote storage, no accounts.
- **Multiple simultaneous books open**: the client holds exactly one
  `Book` at a time; switching flushes state and loads fresh.
- **Arbitrary pixel drawing in reading views**: text containers only.
  Pixel output is reserved for the splash screen (at startup only, via
  `updateImageRawData`).
