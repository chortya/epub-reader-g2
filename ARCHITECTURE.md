# Architecture

This document describes how the **Even G2 ePub Reader** is put together as of
**v1.5.0**. It is meant for contributors touching the codebase; user-facing
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
  - `@evenrealities/even_hub_sdk` (0.0.15, pinned) — raw bridge to the G2
    device (long-press events, native contextual menu, textColor since 0.0.14).
  - `even-toolkit` (1.7.7, patched) — gesture mapping, splash, text cleaning,
    keep-alive (no React — we use the glasses-side modules only). The
    patch-package patch adds `resetGestureState()` and the 40 ms suppression
    window to `gestures` (regenerated for 1.7.7).
  - `@evenrealities/pretext` (via even-toolkit) — firmware-exact LVGL font
    metrics; wrapped by `src/text-metrics.ts`.
  - `jszip` — EPUB ZIP extraction.
  - `hypher` + `hyphenation.*` — per-language word hyphenation.
  - `upng-js` — PNG encoding for the splash screen.

## 3. Module map (`src/`)

```
main.ts              entry: bridge setup, simulator fallback, bridge-settings hydration, UI wiring,
                     upload, Gutenberg, library render, Reader-controls card, keep-alive activation,
                     glassesMenu auto-resume hook.
even-client.ts       EvenEpubClient: views, navigation, reading modes, gesture handling,
                     position persistence. Talks to the raw SDK bridge directly.
epub-parser.ts       EPUB ZIP -> Chapter[]: ZIP unpacking, OPF/spine traversal, DOM-based plain-text
                     extraction, cleanForG2() per line, language detection, hyphenator loading.
paginator.ts         Plain text -> string[] pages: word-wrap at character width with end-of-line
                     hyphenation fallback; page line count derived from getTextLayout().
constants.ts         DISPLAY_* / LINE_HEIGHT_PX, the persistent `config` object, TEXT_HEIGHT_* limits,
                     loadSettings() / saveSettings(), loadSettingsFromBridge() / saveSettingsToBridge(),
                     getTextLayout() — central layout math.
types.ts             Shared type aliases: Chapter, Book, ViewState, ReadingPosition, CachedBookMeta.
utils.ts             setStatus / appendEventLog / withTimeout / clamp / truncateForList.
db.ts                Local book library: SHA-256 content identity, IndexedDB primary +
                     bridge-localStorage fallback (base64), serialized mutations, no silent eviction.
mock-bridge.ts       Browser-simulator bridge: intercepts SDK methods and renders containers into
                     a DOM canvas; provides Prev/Next/Tap/DblTap buttons.
splash-bridge.ts     Adapter exposing an even-toolkit SplashBridge interface on top of the raw SDK.
gutenberg.ts         Fetches the Gutenberg Top 100 and downloads individual EPUBs via a CORS proxy.
book-id.ts           Book identity: SHA-256 content IDs (makeContentBookId) plus the legacy
                     filename+title hash (makeBookId); resolveLastBook() for the mainMenu's
                     Continue Reading resolver (bookId → filename+title).
operation-queue.ts   createSerialExecutor — FIFO promise queue whose rejections never wedge
                     the tail; used for bridge-library mutations and gesture dispatch.
position-store.ts    Position persistence: debounced createPositionPersister (trailing 800 ms,
                     immediate on lifecycle exits, ref-snapshot flush), savePagedPosition /
                     saveFlowPosition (v2 format, title lane only for legacy IDs),
                     writeLastBookKeys (L3, once per book open), migrateLegacyPositionKeys,
                     readPositionFromKeys (shared restore reader).
reading-progress.ts  Pure footer/progress math: computePagedProgress / computeFlowProgress
                     (with measured-pace chapter ETA), rescalePageIndex (legacy estimator),
                     routeGoBack, toggleStatusBarPosition.
book-selection.ts    Collision-aware book-picker labels + companion search matching.
lifecycle.ts         Foreground lifecycle reducer (active/overlayOpen/backgrounded) that
                     disambiguates native-menu ENTER/EXIT from real background/foreground;
                     static menu payloads (PAGED_MENU_ITEMS / FLOW_MENU_ITEMS).
sentences.ts         Sentence-boundary scanning on cleaned chapter text (Flow sentence
                     rewind, auto-rewind on resume). Offsets match position v2.
text-metrics.ts      Single import site for @evenrealities/pretext pixel measurement
                     (firmware font metrics; the font is proportional, not monospace).
chapter-title.ts     Picks the best-looking chapter title from spine / heading / document-title
                     candidates (generic "Chapter N" labels deprioritized).
launch.ts            pickInitialView(intent, lastBook, readingMode) — pure post-splash view
                     decision. glassesMenu + resolvable → reading/flowReading; else mainMenu.
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
type ViewState       = 'mainMenu' | 'bookPicker' | 'welcome' | 'chapterList' | 'reading'
                     | 'flowReading' | 'settings' | 'settingEditor';
// v2 (v1.5.0): offset+paginationVersion survive repagination exactly.
// chapterIndex/pageIndex/wordIndex remain as hints — 1.4.6 (rollback) reads
// those and ignores the v2 fields.
type ReadingPosition = { chapterIndex: number; pageIndex: number; wordIndex?: number;
                         v?: number; offset?: number; paginationVersion?: number };
type CachedBookMeta  = { bookId: string; title: string; filename: string; uploadedAt: number };
```

Each chapter is flattened to plain text during parse. The reader never holds
the original HTML — styling, images, and markup are discarded by design
(G2 is monochrome, ~59-char lines with a proportional font — pixel metrics in
`text-metrics.ts`, not char counts, decide the footer fit).

## 6. View state machine

As of v1.4.0 the top-level IA is the `mainMenu` (Continue / Library (N) /
Settings). `pickInitialView(intent, lastBook, readingMode)` in `src/launch.ts`
decides the post-splash view. `glassesMenu` launches with a resolvable last
book bypass `mainMenu` and go straight to `reading` / `flowReading`.

```
                              +---------+
                 startup ---->| splash  |
                              +----+----+
                                   |
                     pickInitialView(intent, lastBook, readingMode)
                                   |
         +-------- 'reading'/'flowReading' (glassesMenu + resolvable) ------+
         |                         |                                       |
         |                         v                                       |
         |                   +-----------+                                 |
         |                   | mainMenu  |  (3 slots: Continue / Lib(N) /   |
         |                   |           |   Settings. dbl-tap = exit-app)  |
         |                   +-----------+                                 |
         |              tap=0 |  tap=1 |  tap=2                             |
         |                    |        |        |                          |
         |                    v        v        v                          |
         |           +------------+  +-------+  +----------+               |
         |           | reading /  |  |booPicker| | settings |               |
         |           | flowReading|  +-------+  +----------+               |
         |           | (via       |      |          | tap                  |
         |           |  Continue) |      | tap      v                      |
         |           +-----+------+      v    +-----------+                |
         |                 | dbl          +->| settingEditor|               |
         |                 v               |  +-----------+                |
         |          +------------+         |       | tap=save              |
         |          | library    |         |       | dbl=cancel            |
         |          | (chapter   |<--------+       v                       |
         |          |   list)    |              back to settings           |
         |          +------------+                                         |
         |                 | dbl                                           |
         |                 v                                               |
         |            back to mainMenu <----------------------------------+|
         +-----------------+-------------------------------------------+
                           |
                           v
                        mainMenu
```

Gesture-level notes:
- `bookPicker` and `library` (chapter list) both GO_BACK to `mainMenu`. Exit-app
  lives on `mainMenu` GO_BACK only.
- `settingEditor` GO_BACK cancels the in-flight pick and returns to `settings`.
- `settings` GO_BACK returns to `mainMenu`.
- `flowReading` GO_BACK is gated on `!isFlowRunning` (unchanged from v1.3.x).

`onViewChanged` fires on every transition; the web UI uses it to show/hide the
Reader card.

## 7. Gesture pipeline

Raw SDK events reach the app via `bridge.onEvenHubEvent`. They flow through
three layers:

```
SDK event ----> lifecycle/menu routing ---> mapGlassEvent() ---> dispatchGlassEvent()
(sys, menu,      (src/lifecycle.ts —        (even-toolkit/       (serialized FIFO via
 foreground_*)    overlay vs background)     action-map)          createSerialExecutor)
```

- **Lifecycle (v1.5.0).** FOREGROUND_ENTER/EXIT are ambiguous since the
  native contextual menu (hold) fires the same pair around the overlay. The
  reducer tracks active/overlayOpen/backgrounded: a menu click is held until
  the overlay's EXIT delivers it (both event orders work); only a *real*
  backgrounding pauses Flow and flushes. SYSTEM_EXIT bypasses everything.
- **Native menu.** Reading-view rebuilds carry `menuObject` (a rebuild without
  it clears the menu). Clicks arrive as `menuItemClickEvent` and bypass
  gesture routing; stale clicks are dropped by a view guard.
- **Serialization.** Gesture-driven renders run through one FIFO queue so
  rapid swipes cannot interleave SDK calls; lifecycle exits preempt.
- **Flow swipes** (running): one sentence back/forward (`src/sentences.ts`);
  paused: page navigation. Chapter jumps live in the menu/Contents.
- `notifyTextUpdate()` follows every rebuild/upgrade (phantom-suppression
  window); `resetGestureState()` runs after view transitions.

`SYSTEM_EXIT_EVENT` flushes; a real `FOREGROUND_EXIT_EVENT` pauses Flow and
saves the position immediately (persister `{immediate}`).

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

- `maxChars` is 59 for Latin glyphs, 48 for wide Cyrillic glyphs.
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

```
+-------------------+----------------------+----------------------------------------------+
| Data              | Primary              | Key pattern                                  |
+-------------------+----------------------+----------------------------------------------+
| Book files        | IndexedDB (db.ts,    | Split bridge mirror (v1.5.0):                |
| (local library)   | store:books, keyed   |   'epub-book-index' (metadata array)         |
|                   | by SHA-256 bookId)   |   'epub-book-data-<bookId>' (base64 payload) |
|                   |                      | Legacy single blob 'epub-recent-books' is    |
|                   |                      | dual-written for 1.4.6 rollback              |
+-------------------+----------------------+----------------------------------------------+
| Cached book list  | bridge local storage | 'epub-book-list'                             |
| (glasses picker)  |                      |                                              |
+-------------------+----------------------+----------------------------------------------+
| Paged position    | bridge local storage | STORAGE_KEY_POSITION + bookId                |
| (format v2)       | (debounced 800 ms;   | (+ title lane only for legacy IDs)           |
|                   | immediate on exits)  |                                              |
+-------------------+----------------------+----------------------------------------------+
| Flow position     | bridge local storage | STORAGE_KEY_FLOW_POSITION + ... (same rules) |
+-------------------+----------------------+----------------------------------------------+
| Quick bookmark    | bridge local storage | 'epub-bookmark-<bookId>' (position v2)       |
+-------------------+----------------------+----------------------------------------------+
| App settings      | bridge local storage | SETTINGS_KEY (incl. textBrightness 1-4)      |
+-------------------+----------------------+----------------------------------------------+
| Last book meta    | bridge local storage | STORAGE_KEY_BOOK_TITLE / _LAST_BOOK_ID /     |
| (for Continue)    | (once per book open) | _LAST_BOOK_FILENAME                          |
+-------------------+----------------------+----------------------------------------------+
```

- **Positions (v1.5.0 format v2)** are a superset of v1: `{v:2, chapterIndex,
  pageIndex, wordIndex, offset, paginationVersion}`. `offset` is the char
  position inside the chapter's cleaned text (paged: page start; flow: word
  start), valid while `paginationVersion` matches — so text-height changes
  (and any future pagination change) resume at the *same text*, not the same
  page fraction. Rollback safety: 1.4.6 reads the hints and ignores v2
  fields, so no mirror keys are needed.
- **Debounced persister** (`createPositionPersister`): page turns schedule a
  save (trailing 800 ms, latest-wins); lifecycle exits and menu actions save
  immediately; `flush()` lands pending writes (under the ref captured at save
  time) before a book switch. `setLocalStorage === false` is an error.
- **L3 "last book" keys** are written together once per book open (invariant
  I1 — `tests/l3-save-invariant.test.ts`), not on every page turn.

- **Book files** use SHA-256 content IDs in IndexedDB, so different EPUB bytes
  remain separate even when filenames and titles collide. Schema v3 migrates
  surviving filename-keyed rows without clearing the store; re-uploading the
  same filename+title replaces the migrated legacy-ID row and re-keys its
  positions. The bridge mirror uses the v1.5.0 split layout (index + per-book
  payload) with the legacy blob dual-written; mutations are serialized and
  neither store silently evicts books. Rejected bridge writes throw with an
  explicit storage-full message.
- **Cached book list** is separate from the book bytes: `EvenEpubClient`
  stores a compact metadata array under `'epub-book-list'` so startup can
  render the glasses-side picker before any EPUB is parsed.
- **Positions**: restore tries `bookId` first, then the title lane (legacy
  IDs only), then bridge, then browser localStorage. On a legacy→content-ID
  re-upload the old position keys are migrated forward
  (`migrateLegacyPositionKeys`).
- **Settings** now use bridge localStorage as the source of truth on device.
  `constants.ts` still hydrates synchronously from browser localStorage at
  module load for warm reloads in the same WebView, then `main.ts` calls
  `loadSettingsFromBridge()` before `EvenEpubClient` is constructed so the
  first startup render reflects persisted device settings. Saves mirror to
  both lanes.

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
main.ts resolves bridge (real SDK or MockBridge)
    |
    v
main.ts awaits loadSettingsFromBridge(bridge)
    |
    v
EvenEpubClient is constructed / init() runs with hydrated config
    |
    v
DOM ready: main.ts binds <select>/<input>/<slider> values from `config`
    |
    v
user clicks "Apply Settings"
    |
    +- main.ts mutates `config` with validated values from the DOM
    +- saveSettings() writes JSON.stringify(config) to browser localStorage
    +- saveSettingsToBridge(bridge) mirrors to device-persistent storage
    +- client.applySettings()
         +- repaginate all chapters
         +- rescale pageIndex via old/new page-count ratio
         +- clamp flowWordIndex to the new page's word count
         +- switch reading <-> flowReading if readingMode changed
         +- force flowLayoutReady = false when re-rendering flow
         +- refreshCurrentView()
```

`loadSettings` is pure and exhaustively tested
(`tests/settings-persistence.test.ts`): it validates each field,
clamps numeric ranges, rejects non-object JSON, migrates the legacy
`showStatusBar` boolean to the newer `statusBarPosition` enum, and returns
`{}` on any parse error so the caller just keeps defaults.

`loadSettingsFromBridge()` and `saveSettingsToBridge()` are intentionally
thin async wrappers over `bridge.getLocalStorage()` / `setLocalStorage()`.
They swallow bridge failures and leave browser localStorage as a degraded
fallback instead of blocking the UI.

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

Before creating `EvenEpubClient`, `main.ts` hydrates settings from the
bridge-backed store. This ordering matters: on the real device the WebView's
browser localStorage is wiped across app restarts, so bridge localStorage is
the only reliable settings source for first paint.

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

Current suites (v1.5.0 → 173 tests):

- `app-json.test.ts` — manifest / package version alignment, SDK version
  consistency, `supported_languages` matches hyphenation set, network
  whitelist covers hard-coded hosts.
- `paginator.test.ts` — default line counts, text-height crop math,
  `getTextLayout` invariants (full-height container, `maxLines +
  topBlankLines = displayLines`).
- `review-regressions.test.ts` — `makeBookId` stability,
  `pruneBridgeBooks` set semantics, `pickChapterTitle` priority order.
- `settings-persistence.test.ts` — `loadSettings` clamping, type
  rejection, `showStatusBar` + `'right' → 'bottom'` migrations,
  `JSON.stringify(config)` round-trip, and bridge-backed
  `loadSettingsFromBridge()` / `saveSettingsToBridge()` behavior.
- `format-status-line.test.ts` — clock + progress-bar assembly for the
  horizontal status bar (zero-padding, bar-length clamping, maxChars=48
  Cyrillic path).
- `settings-editor.test.ts` — `formatSettingsRow` per-key labels,
  `applyEditorValue` index-to-value mapping for all 5 settings,
  `FLOW_SPEED_VALUES` / `TEXT_HEIGHT_VALUES` shape invariants.
- `continue-reading.test.ts` — `resolveLastBook` drift matrix (bookId
  hit, filename+title tiebreaker, title-only rejected, empty cases).
- `launch-intent.test.ts` — `pickInitialView` decision function for
  each combination of launch intent, resolvable last book, and reading
  mode.
- `l3-save-invariant.test.ts` — invariant I1 (v1.5.0 form): the three L3
  keys are written together once per book open; saves never touch them.
- `position-store.test.ts` — persister debounce/flush/ref-snapshot semantics,
  v2 save/read helpers, legacy position-key migration, shared restore reader.
- `layout.test.ts` — menu-box geometry contract incl. injected pixel measure.
- `gestures-reset.test.ts` — the toolkit-patch contract (resetGestureState
  preserves the post-rebuild suppression window).
- `lifecycle.test.ts` — overlay vs background ENTER/EXIT, both event orders,
  menu payload constraints (unique non-zero ids, 32-byte labels).
- `sentences.test.ts` — sentence boundaries incl. abbreviation guards.
- `review-regressions.test.ts` — book identity, bridge-library split
  (index + per-book keys, legacy fallback), split round-trip, flow ETA guard.

The app-json test enforces a number of release invariants, so simply
forgetting to bump `app.json` version alongside `package.json` is caught
automatically at `npm test`.

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
