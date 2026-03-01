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

// Characters per line for word-wrapping
// Updated to 60 to prevent overflows in some EPUBs
export const SETTINGS_KEY = 'epub-reader-settings';

export const config = {
    hyphenation: true,
    statusBarPosition: 'bottom' as 'bottom' | 'right' | 'none',
    readingMode: 'paged' as 'paged' | 'flow',
    flowSpeedWpm: 240,
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
