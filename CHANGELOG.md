# Changelog

All notable changes to this project will be documented in this file.

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
