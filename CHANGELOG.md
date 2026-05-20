# Changelog

All notable changes to this project will be documented in this file.

## [v1.4.3] - 2026-05-15

### Changed
- **Menu selection box now adapts to the available options.** All five on-glasses list views (`mainMenu`, `settings`, `settingEditor`, `bookPicker`, `chapterList`) share one helper (`rebuildSlots` in `src/even-client.ts`), which previously rendered a fixed 4-row 576-px-wide grid regardless of how many actual options existed. As a result the highlighted row was a full-width banner even for two-letter labels like `"ON"`, and three-item menus rendered with a dead fourth row at the bottom. The helper now (a) trims trailing empty slots so a partial page renders only its real items, (b) vertically centers the remaining rows around the display center, and (c) sizes every row's width to the longest label on the page (clamped to ~160 px floor, `DISPLAY_WIDTH - 32 px` ceiling) with the label space-centered inside the box. Swipe routing is preserved by a new full-screen invisible `isEventCapture=1` overlay declared as container 1 — every swipe lands somewhere inside it regardless of where on the temple the user gestures, so no first-swipe is lost. Fixes the Even Hub marketplace tester feedback "selection box UI does not properly adapt to the size of the available options."
- **`v1.4.0` decision Q3 ("stable 3-slot main menu") clarified in code comments.** The three semantic main-menu choices (`Continue` / `Library (N)` / `Settings`) remain fixed; what was removed is only the implementation-side trailing empty slot in `labels` that `rebuildSlots` now trims. Stale comments in `showMainMenu` and `nextMainMenuSlot` updated to reflect the new render path.

### Added
- **`src/layout.ts`** — pure helpers for menu geometry: `computeBoxWidthPx`, `trimTrailingEmptySlots`, `computeRowOffsets`, `centerLabel`. Shared constants (`ITEMS_PER_PAGE`, `ROW_HEIGHT`, `CHAR_PITCH_PX`, `MIN_BOX_PX`, `EDGE_MARGIN`, `BORDER_INSET`) live here so the rendering math is one import for `even-client.ts` and unit-testable in isolation.
- **`tests/layout.test.ts`** — 19 tests pinning the layout contract: clamping at min/max box width, all-empty input, trailing-only trimming (preserves `selectedSlot` indexing), vertical centering for `n ∈ {1, 2, 3, 4}`, label centering / longer-than-box passthrough.

### Fixed
- **`SCROLL_SUPPRESS_AFTER_TEXT_MS` comments in `rebuildSlots`** said "80 ms" — corrected to "40 ms" to match the v1.4.2 patch.

## [v1.4.2] - 2026-05-04

### Fixed
- **First swipe in the on-glasses menu was eaten on device.** After a `rebuildPageContainer`, the toolkit's gesture pipeline kept stale tap/scroll debounce state across the view boundary, so the user's first swipe in the new menu was silently dropped on hardware (the simulator never reproduced it). Patched `even-toolkit/gestures.ts` to add `resetGestureState()`, which clears `lastTapTime` / `lastTapKind` / `lastScrollTime` / `lastScrollDir` without touching the post-rebuild text-update suppression window — leaving that window in place is what swallows the device's phantom SCROLL after re-layout. `rebuildSlots()` and `showWelcome()` now do `notifyTextUpdate(); resetGestureState();` in that order; `selectCurrentChapter()` calls `resetGestureState()` after `showPage()` / `showFlowFrame()` (which already arm the window). A first attempt that flipped on `bypassNextScrollChecks` after rebuild let the phantom through and snapped the highlight back to where it started — that approach was abandoned in favor of the narrower contract above.
- **Felt-laggy second swipe at the original 80 ms window.** Lowered `SCROLL_SUPPRESS_AFTER_TEXT_MS` in the toolkit patch from 80 → 40 ms. The phantom fires essentially with the rebuild (well under 30 ms), so 40 ms still suppresses it, while a deliberate human follow-up swipe (≥150 ms) lands without the previous wait.

### Added
- **`patch-package` wired up.** New `postinstall` script applies `patches/even-toolkit+1.7.2.patch` so the gesture-pipeline changes survive `npm install`.
- **`tests/gestures-reset.test.ts`** pins the new contract: `resetGestureState()` clears stale tap state, preserves the post-rebuild suppression window, and a real swipe lands once the window expires.

### Changed
- **`qr` / `qr:sim` scripts** now run `evenhub qr --clear` first, so the previous dev session's QR doesn't linger if the port number changed.

## [v1.4.1] - 2026-04-24

### Fixed
- **Progress bar wraps inside the status bar on long labels.** After v1.4.0 prepended the `HH:MM` clock to the footer, some pages (late-book paged reading, and flow mode in general) produced a label wide enough to wrap to a second line inside the 30 px footer container — the SDK rendered it as a small scroll indicator instead of the horizontal progress bar. Cause: the heavy/light box-drawing glyphs (`━`, `─`) render slightly wider than one monospace cell on the G2 display, so the label's rendered width exceeded 576 px even though the cell count fit. Fix: (a) `formatStatusLine` caps the progress bar at 10 glyphs (was 20); (b) flow-mode `infoText` drops the redundant `"Flow "` prefix (the `RUN`/`PAUSE` token already conveys mode) and the `W N/M` word-index suffix (the progress bar already shows within-page position). Worst-case label is now 50 cells — safe against the glyphs' wider rendering.

## [v1.4.0] - 2026-04-22

### Added
- **Main Menu on glasses.** After splash, the reader now shows a 3-slot main menu: `Continue reading`, `Library (N)`, `Settings`. Swipe to move, tap to enter, double-tap to exit the app. Slot 0 reads `(No recent book)` when no last-opened book is resolvable. See `docs/1.4.0-on-device-settings-and-menu.md`.
- **On-device Settings.** All five settings previously only editable from the web UI (hyphenation, status-bar position, reading mode, flow speed, text height) can now be edited directly from the glasses via a unified list-of-values editor. Tap a setting to enter its value picker; tap a value to commit; double-tap to cancel. Commits write to both browser `localStorage` and `bridge.setLocalStorage`; the bridge write is non-blocking so the UI updates immediately.
- **Clock in horizontal status bar.** Footer now reads `HH:MM  Ch C/T Pg P/N [━━━───]`. Updated via a 10 s `textContainerUpgrade` ticker with a string-compare gate so only actual minute rollovers trigger a redraw. Flicker-free. Automatically hides when `statusBarPosition='none'`.
- **Continue Reading resolves by bookId.** Three new bridge keys (`epub-last-book-id`, `epub-last-book-filename`, plus the existing `epub-book-title`) are written together on every position save. Continue Reading matches by `bookId` first, then by `(filename, title)` → `makeBookId()` derived id. Duplicate titles no longer silently resume the wrong book (fixes a latent bug from v1.3.x auto-resume).
- **Launch-intent-aware startup.** `main.ts` now registers `onLaunchSource` before `client.init()` so `runStartup` can consult the launch source after splash. `glassesMenu` with a resolvable last book bypasses the main menu and resumes directly (reading / flowReading per `readingMode`). `appMenu` and all other cases show the main menu.

### Changed
- **Double-tap routing.** Back from `bookPicker` or the chapter list now returns to `mainMenu` (was: exit-app). Exit-app moves one level deeper — double-tap from `mainMenu` closes the app. This is one extra double-tap than v1.3.x to exit from a reading session, but the main menu becomes the natural home.
- **Settings editor value-set for flow speed:** 17 uniform 30-WPM steps from 120 to 600. Previous web UI used a free-form slider; on-device and web both now present the same stepped list.

### Removed
- **Vertical ("right") status bar.** The option was visually cramped (26 px × 288 px sidebar), broke the `maxChars`-from-layout abstraction (every renderer subtracted 26 px inline), and had no good fit for the new clock. Dropped from `AppConfig.statusBarPosition`, from the web UI, and from all rendering paths.

### Migration
- Users with `statusBarPosition: 'right'` saved from v1.3.x are silently migrated to `'bottom'` on first read (precedent: the v0.8.0 `showStatusBar → statusBarPosition` migration). No action needed.
- **v1.3.x users who upgrade without opening a book will see `(No recent book)` on the main menu until they open a book at least once under v1.4.0.** This is intentional: the new Continue Reading path requires the bookId/filename keys that v1.3.x didn't write. Title-only resumption was removed to eliminate the duplicate-title footgun.

## [v1.3.1] - 2026-04-22

### Fixed
- **On-device settings persistence**: Settings (hyphenation, status-bar position, reading mode, flow speed, text height) now persist across app restarts on the G2 device. Previously they were written only to the WebView's browser `localStorage`, which is wiped when the Even Hub app restarts; positions and book cache already used `bridge.setLocalStorage` and were unaffected. Added `loadSettingsFromBridge(bridge)` and `saveSettingsToBridge(bridge)` in `constants.ts` — these call the official Device API (`bridge.getLocalStorage`/`setLocalStorage`, see [hub.evenrealities.com/docs/guides/device-apis](https://hub.evenrealities.com/docs/guides/device-apis#local-storage)). `main.ts` now hydrates `config` from bridge storage **before** `client.init()`, so the first startup render reflects persisted values, and mirrors every save to the bridge in addition to browser localStorage. Browser `localStorage` remains as a warm-start cache for faster page reloads in the simulator.

### Changed
- **Dependencies**: `even-toolkit` 1.7.0 → 1.7.2, `@evenrealities/evenhub-cli` 0.1.12 → 0.1.13, `@evenrealities/evenhub-simulator` 0.7.2 → 0.7.3, `vite` 8.0.8 → 8.0.9, `typescript` 6.0.2 → 6.0.3. even-toolkit 1.6.3 added a `storage` module that wraps the same bridge API we now use directly — see its changelog for the "shared storage no longer mirrors to browser localStorage" note that confirmed this bug.

### Added
- **Persistence tests**: Five new tests in `tests/settings-persistence.test.ts` covering `saveSettingsToBridge` and `loadSettingsFromBridge` with a mock bridge — writing under `SETTINGS_KEY`, applying overrides onto `config`, tolerating empty bridge values, and tolerating a throwing bridge without crashing the caller.

## [v1.3.0] - 2026-04-19

### Changed
- **Settings persistence**: Extracted the localStorage parse/validate logic from an inline IIFE into a pure `loadSettings(raw): Partial<AppConfig>` function in `constants.ts`. Behavior is unchanged for valid data; the refactor makes the logic testable without a DOM. Tightened validation: `hyphenation` and legacy `showStatusBar` now require `typeof === 'boolean'` (previously accepted any truthy/falsy value); non-object JSON roots (`"42"`, `null`, arrays) are rejected up front. `saveSettings()` now swallows `localStorage.setItem` errors so a storage-quota/private-mode error no longer throws out of the settings-apply handler.

### Added
- **Persistence tests**: New `tests/settings-persistence.test.ts` with 25 tests covering null/empty/malformed/non-object JSON inputs; range clamping for `textHeightPercent` and `flowSpeedWpm`; enum validation for `statusBarPosition` and `readingMode`; legacy `showStatusBar` migration in both directions; boolean-only validation for `hyphenation`; fractional rounding; round-trip verification against `JSON.stringify(config)`; partial/unknown-field handling.

## [v1.2.0] - 2026-04-18

### Added
- **Text height setting**: New "Text height" slider (50–100%, step 10) in the web UI settings panel. Shrinking the value leaves the top portion of the G2 display blank and renders text in the bottom band — useful when glasses sit higher in the field of view. Applies to both Paged and Flow modes; lines-per-page shrink proportionally.
- **Web-UI reader controls**: New context-aware "Reader" card that appears while a book is open. In Paged mode it shows Previous/Next page buttons (disabled at the book's start/end). In Flow mode it shows a Start/Pause toggle plus Previous/Next chapter buttons. Works in both real-device and simulator modes.

### Changed
- **Paginator**: `maxLines` per page is now derived from pixel math (`usableHeight / LINE_HEIGHT_PX`) instead of the hard-coded 9/10 split. Default output is unchanged — `floor((288 - 30)/28) = 9` with a bottom bar and `floor(288/28) = 10` without — verified by regression tests. At cropped sizes the visual "top crop" is rendered via leading blank lines prepended to each page; the text container itself always fills the full available height so every swipe lands on the capturing container (the SDK drops swipes that fall outside any `isEventCapture=1` container — that caused the single-swipe-is-ignored bug at 50/60 %).
- **EvenEpubClient**: Added public state getters (`getView`, `isFlowActive`, `can*`) and public action wrappers (`pagedNext`, `pagedPrev`, `toggleFlowPlayback`, `flow{Prev,Next}Chapter`) for web-UI consumption. Added `onFlowStateChanged` callback.

### Removed
- **Dead code**: Unused `TEXT_HEIGHT`/`BAR_HEIGHT` constants in `even-client.ts`; stale "Updated to 60" comment in `constants.ts`.

## [v1.1.1] - 2026-04-16

### Fixed
- **WebView Cache**: Added `Cache-Control: no-cache, no-store, must-revalidate` / `Pragma` / `Expires` meta tags to `index.html` so Android WebViews always refetch the HTML. Fingerprinted JS chunks already invalidate automatically — this ensures the HTML pointing at them does too.

### Changed
- **Dependencies**: Bumped `@evenrealities/even_hub_sdk` 0.0.9 → 0.0.10, `even-toolkit` 1.6.5 → 1.7.0, `@evenrealities/evenhub-cli` 0.1.11 → 0.1.12, `@evenrealities/evenhub-simulator` 0.7.1 → 0.7.2.
- **app.json**: Bumped `min_sdk_version` to `0.0.10` to match the installed SDK.

## [v0.9.0] - 2026-03-01

### Added
- **Flow Reading Mode**: Added an optional reading mode where text appears progressively word-by-word as an alternative to page-by-page reading.
- **Flow Controls in Settings**: Added `Reading mode` (`paged` or `flow`) and configurable `Flow speed (WPM)` in the web UI settings panel.
- **Flow Progress Persistence**: Added separate saved position for flow mode (chapter, page, and word index) so flow sessions resume accurately.
- **Contributor Guide**: Added `AGENTS.md` with repository-specific contributor guidelines and workflows.

### Changed
- **Flow Rendering Behavior**: Flow now reveals text within the current page and only advances after completing that page, preserving bottom-line visibility.
- **Flow Gesture Mapping**:
  - Single click toggles flow start/pause while in flow mode.
  - Double click exits to chapter list only when flow is paused.
- **Release Metadata**: Bumped package version to `0.9.0`.

### Notes
- Existing page-by-page reading behavior remains available and unchanged as the default mode.

## [v0.7.0] - 2026-02-15

### Added
- **Text-Only Logo**: Replaced the image-based logo with a stable "G2 ePUB Reader" text title on the startup screen (centered, max 60 chars).
- **Connection Gating**: Implemented strict startup logic that waits for `DeviceConnectType.Connected` before creating any UI. This resolves issues where the start screen would not appear on the physical device.
- **Improved Centering**: Dynamic text centering based on a 60-character line limit.

### Fixed
- **Startup Visibility**: Fixed a critical race condition where startup commands were sent before the device connection handshake was complete.
- **Double Click Navigation**: Restored the ability to double-click in the Chapter List to return to the main "Upload ePub" screen.
- **Text Overflow**: Reduced `CHARS_PER_LINE` from 61 to 60 to prevent text wrapping issues on certain EPUBs.

### Removed
- **Image Handling**: Removed all legacy image processing code (BMP conversion, 1-bit packing) to ensure maximum stability and SDK compliance.

## [0.6.0] - 2026-02-14

### Added
- **Native Text Startup Screen**: Replaced bitmap logo with native G2 text widgets for 100% reliable rendering on device.
- **Enhanced Hyphenation**: Added support for German (`hyphenation.de`), Russian (`hyphenation.ru`), and Ukrainian (`hyphenation.uk`) in addition to English.
- **Layout Optimization**: Tuned display parameters to 55 characters per line and 9 lines per page for optimal readability on G2 display.
- **Reading Progress**: Added visual Unicode progress bar in the footer.
- **Chapter Navigation**: Improved chapter list with pagination.

### Changed
- **Startup UI**: Centered "G2 ePub Reader" title and clear "Upload book via web UI" instructions.
- **Pagination Logic**: Fixed issues with line-breaking and word truncation.
- **Font Sizing**: Adjusted simulated font size to better match hardware physical display characteristics.

### Fixed
- **Device Rendering**: Resolved issue where bitmap logos would not render on the glasses hardware (Fixed by switching to native text).
