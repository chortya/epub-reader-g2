# Changelog

All notable changes to this project will be documented in this file.

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
