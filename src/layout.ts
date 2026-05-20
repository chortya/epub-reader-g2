import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from './constants.ts';
import { clamp } from './utils.ts';

// Slot rendering geometry. Shared by even-client's rebuildSlots (the on-glasses
// list views: mainMenu, settings, settingEditor, bookPicker, chapterList).
export const ITEMS_PER_PAGE = 4;
export const ROW_HEIGHT = Math.floor(DISPLAY_HEIGHT / ITEMS_PER_PAGE);

// Monospace glyph pitch on G2: 576 px / 59 narrow-glyph chars ≈ 9.76 px.
// Wide / CJK glyphs render ≈ 12 px but labels in our menus are ASCII, so we
// use the narrow value for sizing. See src/paginator.ts for the source.
export const CHAR_PITCH_PX = 9.76;

// Floor: even short labels ("ON", "60%") get ~16 cells of box so the border
// looks like a button rather than a postage stamp.
export const MIN_BOX_PX = 160;

// Breathing room at the left/right edges of the display.
export const EDGE_MARGIN = 16;

// Visual border + inner padding allowance baked into the box width so the
// border doesn't crowd the text.
export const BORDER_INSET = 4;

export function computeBoxWidthPx(labels: readonly string[]): number {
  const lengths = labels.filter((s) => s.length > 0).map((s) => s.length);
  // Math.max() with no args returns -Infinity; guard with a 0 sentinel so an
  // all-empty input falls through to MIN_BOX_PX rather than NaN.
  const longest = Math.max(0, ...lengths);
  const raw = Math.ceil(longest * CHAR_PITCH_PX) + 2 * BORDER_INSET;
  return clamp(raw, MIN_BOX_PX, DISPLAY_WIDTH - 2 * EDGE_MARGIN);
}

export function trimTrailingEmptySlots(labels: readonly (string | undefined | null)[]): string[] {
  const visible = labels.slice(0, ITEMS_PER_PAGE).map((l) => l ?? '');
  while (visible.length > 0 && visible[visible.length - 1].length === 0) {
    visible.pop();
  }
  return visible;
}

export function computeRowOffsets(n: number): number[] {
  if (n <= 0) return [];
  const used = n * ROW_HEIGHT;
  const top = Math.max(0, Math.floor((DISPLAY_HEIGHT - used) / 2));
  return Array.from({ length: n }, (_, i) => top + i * ROW_HEIGHT);
}

export function centerLabel(label: string, boxChars: number): string {
  if (label.length >= boxChars) return label;
  const pad = Math.floor((boxChars - label.length) / 2);
  return ' '.repeat(pad) + label;
}
