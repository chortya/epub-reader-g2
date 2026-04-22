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

export const SWIPE_COOLDOWN_MS = 300;
export const FLOW_MIN_WPM = 120;
export const FLOW_MAX_WPM = 600;

// Editor presentation value sets. These drive the on-device settings editor
// (see docs/1.4.0-on-device-settings-and-menu.md §4.2). They are NOT used for
// validation — loadSettings continues to clamp free-form input to the full
// [MIN, MAX] range. A rogue blob containing flowSpeedWpm=999 is clamped to 600
// and the editor pre-selection algorithm picks the nearest valid step.
export const FLOW_SPEED_VALUES = [
  120, 150, 180, 210, 240, 270, 300, 330, 360,
  390, 420, 450, 480, 510, 540, 570, 600,
] as const;

export const TEXT_HEIGHT_VALUES = [50, 60, 70, 80, 90, 100] as const;

export type SettingKey =
  | 'hyphenation'
  | 'statusBarPosition'
  | 'readingMode'
  | 'flowSpeedWpm'
  | 'textHeightPercent';

export type AppConfig = {
    hyphenation: boolean;
    statusBarPosition: 'bottom' | 'none';
    readingMode: 'paged' | 'flow';
    flowSpeedWpm: number;
    textHeightPercent: number;
};

export const config: AppConfig = {
    hyphenation: true,
    statusBarPosition: 'bottom',
    readingMode: 'paged',
    flowSpeedWpm: 240,
    textHeightPercent: TEXT_HEIGHT_MAX_PERCENT,
};

/**
 * Parse a serialized settings blob into a partial config override.
 * Rejects invalid values field-by-field (returns nothing for that field)
 * and clamps numeric ranges. Malformed JSON returns {}. This is the pure
 * inverse of JSON.stringify(config) — tests should exercise this directly.
 */
export function loadSettings(raw: string | null): Partial<AppConfig> {
    if (!raw) return {};
    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object') return {};

    const out: Partial<AppConfig> = {};

    if (typeof parsed.hyphenation === 'boolean') {
        out.hyphenation = parsed.hyphenation;
    }

    if (
        parsed.statusBarPosition === 'bottom'
        || parsed.statusBarPosition === 'none'
    ) {
        out.statusBarPosition = parsed.statusBarPosition;
    } else if (parsed.statusBarPosition === 'right') {
        // v1.4.0 removed the vertical status bar. Migrate saved 'right' to 'bottom'.
        out.statusBarPosition = 'bottom';
    } else if (typeof parsed.showStatusBar === 'boolean') {
        // Legacy key from versions < v0.8.0
        out.statusBarPosition = parsed.showStatusBar ? 'bottom' : 'none';
    }

    if (parsed.readingMode === 'paged' || parsed.readingMode === 'flow') {
        out.readingMode = parsed.readingMode;
    }

    if (typeof parsed.flowSpeedWpm === 'number' && Number.isFinite(parsed.flowSpeedWpm)) {
        out.flowSpeedWpm = Math.max(
            FLOW_MIN_WPM,
            Math.min(FLOW_MAX_WPM, Math.floor(parsed.flowSpeedWpm)),
        );
    }

    if (typeof parsed.textHeightPercent === 'number' && Number.isFinite(parsed.textHeightPercent)) {
        out.textHeightPercent = Math.max(
            TEXT_HEIGHT_MIN_PERCENT,
            Math.min(TEXT_HEIGHT_MAX_PERCENT, Math.round(parsed.textHeightPercent)),
        );
    }

    return out;
}

try {
    Object.assign(config, loadSettings(localStorage.getItem(SETTINGS_KEY)));
} catch {
    // localStorage unavailable — fall back to defaults
}

export function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(config));
    } catch {
        // localStorage unavailable — silently skip
    }
}

// Bridge-backed persistence. On the real G2 device the WebView's browser
// localStorage is wiped across app restarts; bridge.setLocalStorage is the
// only store that survives. See https://hub.evenrealities.com/docs/guides/device-apis#local-storage
interface SettingsBridge {
    setLocalStorage(key: string, value: string): Promise<boolean>;
    getLocalStorage(key: string): Promise<string>;
}

export async function loadSettingsFromBridge(bridge: SettingsBridge): Promise<void> {
    try {
        const raw = await bridge.getLocalStorage(SETTINGS_KEY);
        const overrides = loadSettings(raw || null);
        if (Object.keys(overrides).length > 0) {
            Object.assign(config, overrides);
            // Mirror to browser localStorage so a cold reload in the same
            // WebView session still gets the persisted values synchronously.
            try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(config)); } catch { /* */ }
        }
    } catch (e) {
        console.warn('loadSettingsFromBridge failed:', e);
    }
}

export async function saveSettingsToBridge(bridge: SettingsBridge): Promise<void> {
    try {
        const ok = await bridge.setLocalStorage(SETTINGS_KEY, JSON.stringify(config));
        if (ok === false) console.warn('Bridge rejected settings write');
    } catch (e) {
        console.warn('saveSettingsToBridge failed:', e);
    }
}

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

// --- v1.4.0 pure helpers (consumed by clock ticker, settings menu, editor) ---

function zeroPad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Build the single-line footer string for the horizontal status bar:
 *
 *   "HH:MM  <infoText>[━━━──────]"
 *
 * The progress bar width is derived from (maxChars - clock - infoText - brackets),
 * clamped to a sane minimum so cramped infoText never produces a negative-length
 * bar. The bar is omitted entirely if no width is left.
 *
 * Pure function; all inputs explicit so it is test-friendly without a DOM or a
 * real clock. See docs/1.4.0-on-device-settings-and-menu.md §7.2.
 */
export function formatStatusLine(args: {
  now: Date;
  infoText: string;
  maxChars: number;
  progress: number;
}): string {
  const { now, infoText, maxChars, progress } = args;
  const hhmm = `${zeroPad2(now.getHours())}:${zeroPad2(now.getMinutes())}`;
  const prefix = `${hhmm}  `;
  const clampedProgress = Math.max(0, Math.min(1, progress));

  // Reserve brackets. Bar width is whatever remains after clock + infoText.
  const BRACKETS = 2;
  const rawBarLen = maxChars - prefix.length - infoText.length - BRACKETS;

  if (rawBarLen <= 0) {
    // Not enough room for even a 1-char bar; drop the bar entirely rather than
    // render something misleading or crash on a negative repeat.
    return `${prefix}${infoText}`.slice(0, maxChars);
  }

  const barLen = Math.max(5, Math.min(20, rawBarLen));
  const filled = Math.round(barLen * clampedProgress);
  const empty = barLen - filled;
  const bar = '━'.repeat(filled) + '─'.repeat(empty);
  return `${prefix}${infoText}[${bar}]`;
}

/**
 * Render a single row for the on-device settings list, given the current
 * config. Format: "{Label}: {formatted value}".
 */
export function formatSettingsRow(key: SettingKey, cfg: AppConfig): string {
  switch (key) {
    case 'hyphenation':
      return `Hyphenation: ${cfg.hyphenation ? 'ON' : 'OFF'}`;
    case 'statusBarPosition':
      return `Status bar: ${cfg.statusBarPosition === 'bottom' ? 'Bottom' : 'Hidden'}`;
    case 'readingMode':
      return `Reading mode: ${cfg.readingMode === 'flow' ? 'Flow' : 'Paged'}`;
    case 'flowSpeedWpm':
      return `Flow speed: ${cfg.flowSpeedWpm} wpm`;
    case 'textHeightPercent':
      return `Text height: ${cfg.textHeightPercent}%`;
  }
}

/**
 * Mutate `cfg` in place, setting the slot named by `key` from the editor's
 * value-list at position `index`. Index bounds are assumed to come from a
 * paginated list whose length matches the value array; callers must not pass
 * out-of-range indices.
 */
export function applyEditorValue(cfg: AppConfig, key: SettingKey, index: number): void {
  switch (key) {
    case 'hyphenation':
      // Editor list: [ON, OFF] → [true, false].
      cfg.hyphenation = index === 0;
      return;
    case 'statusBarPosition':
      // Editor list: [Bottom, Hidden] → ['bottom', 'none'].
      cfg.statusBarPosition = index === 0 ? 'bottom' : 'none';
      return;
    case 'readingMode':
      // Editor list: [Paged, Flow] → ['paged', 'flow'].
      cfg.readingMode = index === 0 ? 'paged' : 'flow';
      return;
    case 'flowSpeedWpm':
      cfg.flowSpeedWpm = FLOW_SPEED_VALUES[index];
      return;
    case 'textHeightPercent':
      cfg.textHeightPercent = TEXT_HEIGHT_VALUES[index];
      return;
  }
}
