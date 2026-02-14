# Changelog

All notable changes to this project will be documented in this file.

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
