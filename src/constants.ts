// Even G2 Display Specifications
// SDK PROPERTY CONSTRAINTS (from official documentation):
// - xPosition range: 0-576
// - yPosition range: 0-288
// - TextContainer: width max 576, height max 288
// - ImageContainer: width max 200, height max 100
// - containerName max: 16 characters
// - **IMAGES FORBIDDEN IN STARTUP PHASE** (createStartUpPageContainer)
// - Images ONLY work in rebuildPageContainer (post-startup pages)
export const DISPLAY_WIDTH = 576;  // SDK maximum X range
export const DISPLAY_HEIGHT = 288; // SDK maximum Y range

// Pixel height reserved per text line on the G2 display.
// Chosen so floor((288 - 30)/LINE_HEIGHT_PX) = 9 lines with a 30px bottom bar
// and floor(288/LINE_HEIGHT_PX) = 10 lines without — matches legacy behavior.
export const LINE_HEIGHT_PX = 28;
export const STATUS_BAR_HEIGHT_PX = 30;

export const TEXT_HEIGHT_MIN_PERCENT = 50;
export const TEXT_HEIGHT_MAX_PERCENT = 100;
export const TEXT_HEIGHT_STEP_PERCENT = 10;

export const SETTINGS_KEY = 'epub-reader-settings';

export const config = {
    hyphenation: true,
    statusBarPosition: 'bottom' as 'bottom' | 'right' | 'none',
    readingMode: 'paged' as 'paged' | 'flow',
    flowSpeedWpm: 240,
    textHeightPercent: TEXT_HEIGHT_MAX_PERCENT,
};

try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.hyphenation !== undefined) config.hyphenation = parsed.hyphenation;

        if (parsed.statusBarPosition !== undefined) {
            config.statusBarPosition = parsed.statusBarPosition;
        } else if (parsed.showStatusBar !== undefined) {
            config.statusBarPosition = parsed.showStatusBar ? 'bottom' : 'none';
        }

        if (parsed.readingMode === 'paged' || parsed.readingMode === 'flow') {
            config.readingMode = parsed.readingMode;
        }
        if (typeof parsed.flowSpeedWpm === 'number' && Number.isFinite(parsed.flowSpeedWpm)) {
            config.flowSpeedWpm = Math.max(120, Math.min(600, Math.floor(parsed.flowSpeedWpm)));
        }
        if (typeof parsed.textHeightPercent === 'number' && Number.isFinite(parsed.textHeightPercent)) {
            config.textHeightPercent = Math.max(
                TEXT_HEIGHT_MIN_PERCENT,
                Math.min(TEXT_HEIGHT_MAX_PERCENT, Math.round(parsed.textHeightPercent)),
            );
        }
    }
} catch (e) {
    // ignore
}

export function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(config));
}

export const SWIPE_COOLDOWN_MS = 300;
export const FLOW_MIN_WPM = 120;
export const FLOW_MAX_WPM = 600;

export const STORAGE_KEY_POSITION = 'epub-reading-position';
export const STORAGE_KEY_FLOW_POSITION = 'epub-flow-position';
export const STORAGE_KEY_BOOK_TITLE = 'epub-book-title';

/**
 * Layout for the reading text container given current config.
 *
 * The text container always covers the full available area below the status
 * bar so that every swipe lands on a container with isEventCapture=1 (the SDK
 * drops swipes that fall outside any capturing container — that was the source
 * of the "need-two-swipes" bug at cropped sizes).
 *
 * The visual "crop" is achieved by padding each page of text with `topBlankLines`
 * leading blank lines, pushing the content down within the full-size container.
 *
 * `maxLines` is the reduced number of content lines the paginator should fit per
 * page. `topBlankLines` is how many blank lines to prepend at render time so the
 * content still occupies a full `availableHeight` worth of display lines.
 */
export function getTextLayout(): {
  availableHeight: number;
  usableHeight: number;
  yPosition: number;
  maxLines: number;
  topBlankLines: number;
  barHeight: number;
} {
  const barHeight = config.statusBarPosition === 'bottom' ? STATUS_BAR_HEIGHT_PX : 0;
  const availableHeight = DISPLAY_HEIGHT - barHeight;
  const percent = Math.max(
    TEXT_HEIGHT_MIN_PERCENT,
    Math.min(TEXT_HEIGHT_MAX_PERCENT, config.textHeightPercent),
  );
  const targetUsable = Math.max(
    LINE_HEIGHT_PX,
    Math.floor((availableHeight * percent) / 100),
  );
  const displayLines = Math.max(1, Math.floor(availableHeight / LINE_HEIGHT_PX));
  const maxLines = Math.max(1, Math.min(displayLines, Math.floor(targetUsable / LINE_HEIGHT_PX)));
  const topBlankLines = Math.max(0, displayLines - maxLines);
  return {
    availableHeight,
    usableHeight: availableHeight, // container always fills the area below the status bar
    yPosition: 0,
    maxLines,
    topBlankLines,
    barHeight,
  };
}
