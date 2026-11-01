/**
 * Glasses-side screen layouts for everything before the book: main menu,
 * library (book picker), contents (chapter list), settings and the setting
 * editor, plus a modal overlay card.
 *
 * Pure builders: they return container specs; EvenEpubClient turns them into
 * SDK containers. The layout key covers geometry and borders only,
 * so moving the selection (which changes text and brightness, never
 * geometry) can be sent as flicker-free textContainerUpgrades instead of a
 * rebuild.
 *
 *    section ······························ position · clock     y 0-30
 *   ╭ list frame ─────────────╮ ╭ detail card ───────────╮
 *   │  ○ Item 3 before   (dim)│ │ Title (bright, 2 lines)│
 *   │  ○ Item 1 before        │ │                        │
 *   │╭───────────────────────╮│ │ author / details       │  y 32-258
 *   ││● Selected item    58% ││ │ ━━━━━━━━──────── 58%   │
 *   │╰───────────────────────╯│ │                        │
 *   │  ★ Item 1 after   (dim) │ │                        │
 *   ╰─────────────────────────╯ ╰────────────────────────╯
 *     ● open  ●● back                          ▲ ▼        y 258-288
 *
 * Patterns follow community G2 apps (two-pane rail + card: Pulse, Daily App;
 * empty full-screen capture layer declared first: even-toolkit) and the
 * official guidelines' glyph set (─ ━ ╭╮╰╯ ● ○ ▶ ▲ ▼ ★ ·).
 */

import { measureWidth } from './text-metrics.ts';

export type BoxSpec = {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  content: string;
  border?: number;
  borderColor?: number;
  radius?: number;
  pad?: number;
  /** Text brightness 1-4 (SDK textColor). */
  textColor?: number;
  capture?: boolean;
};

export type ScreenSpec = {
  boxes: BoxSpec[];
  /** Geometry/border/z signature: equal keys = content-only update possible. */
  key: string;
};

export type ListItem = {
  label: string;
  /** One status glyph shown before the label (e.g. ● reading, ○ new, ★ done). */
  icon?: string;
  /** Short right-aligned value (e.g. "58%", "21 p"). */
  meta?: string;
};

export type Card = {
  title: string;
  lines: string[];
  /** Word-wrap long lines (prose) instead of truncating them (lists). */
  wrap?: boolean;
};

export type ListScreenModel = {
  section: string;
  /** e.g. "3/12"; shown before the clock. */
  position?: string;
  clock?: string;
  items: ListItem[];
  selected: number;
  card: Card;
  hints: string;
};

export const SCREEN_W = 576;
export const SCREEN_H = 288;
/** SDK 0.0.16: at most 8 text containers per page (12 containers in total). */
export const MAX_TEXT_CONTAINERS = 8;
/** Measured G2 line pitch (see G2_LINE_PITCH_PX); a one-line box needs 30 px. */
const PITCH = 28.67;
export const BODY_Y = 32;
export const BODY_H = 226;
export const FOOTER_Y = BODY_Y + BODY_H; // 258
export const LIST_W = 300;
export const CARD_X = 306;
export const CARD_W = SCREEN_W - CARD_X;
/** Rows shown above and below the fixed selection row. */
export const WING_ROWS = 3;
const WING_H = Math.ceil(WING_ROWS * PITCH) + 2; // 88
const SEL_H = 40;
const ROW_X = 8;
const ROW_W = LIST_W - 2 * ROW_X;
const CARD_PAD = 10;
/** Card text lines (2 of them under the title box). */
export const CARD_LINES = Math.floor((BODY_H - 2 * CARD_PAD - 2) / PITCH); // 7

/** Brightness levels (SDK textColor 1-4). */
export const BRIGHT = 4;
export const NORMAL = 3;
export const DIM = 2;

type Measure = (text: string) => number;

/** Truncate to fit `px`, ending in "...". */
export function fitPx(text: string, px: number, measure: Measure = measureWidth): string {
  if (measure(text) <= px) return text;
  const ell = '...';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(text.slice(0, mid).trimEnd() + ell) <= px) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? ell : text.slice(0, lo).trimEnd() + ell;
}

/** `left` and `right` on one line of `px`, the gap filled with spaces. */
export function spread(left: string, right: string, px: number, measure: Measure = measureWidth): string {
  if (!right) return fitPx(left, px, measure);
  const rightW = measure(right);
  const space = Math.max(1, measure(' '));
  const leftFit = fitPx(left, Math.max(0, px - rightW - space * 2), measure);
  const gap = Math.max(1, Math.floor((px - measure(leftFit) - rightW) / space));
  return leftFit + ' '.repeat(gap) + right;
}

/** Greedy word wrap to `px`, at most `maxLines` (the last one truncated with "..."). */
export function wrapPx(text: string, px: number, maxLines: number, measure: Measure = measureWidth): string[] {
  if (maxLines <= 0) return [];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const candidate = line ? `${line} ${words[i]}` : words[i];
    if (!line || measure(candidate) <= px) {
      line = candidate;
      continue;
    }
    if (lines.length === maxLines - 1) {
      // Last allowed line: keep the rest so fitPx ends it in "...".
      line = `${line} ${words.slice(i).join(' ')}`;
      break;
    }
    lines.push(line);
    line = words[i];
  }
  if (line) lines.push(line);
  return lines.map((l) => fitPx(l, px, measure));
}

/**
 * At most `max` lines: blank spacer lines go first (last one first), then
 * the tail is cut - so the lines that carry content survive.
 */
export function fitLines(lines: string[], max: number): string[] {
  const out = [...lines];
  while (out.length > max) {
    const blank = out.lastIndexOf('');
    if (blank === -1) break;
    out.splice(blank, 1);
  }
  return out.slice(0, Math.max(0, max));
}

/** A bar of `px` width: ━ for the done part, ─ for the rest. */
export function progressBar(fraction: number, px: number, measure: Measure = measureWidth): string {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const unit = Math.max(1, measure('━'));
  const total = Math.max(4, Math.floor(px / unit));
  const done = Math.round(f * total);
  return '━'.repeat(done) + '─'.repeat(total - done);
}

/**
 * A picker-wheel list: the selection always sits in the framed middle row,
 * the items before/after it scroll through the rows above/below. Geometry
 * never depends on the selection, so a swipe is a pure content update.
 *
 * Text containers (8 max): 1 capture + header, 2 list frame, 3 rows above,
 * 4 selection, 5 rows below, 6 card frame + details, 7 card title, 8 footer.
 */
export function buildListScreen(model: ListScreenModel, measure: Measure = measureWidth): ScreenSpec {
  const total = model.items.length;
  const selected = total === 0 ? -1 : Math.min(Math.max(0, model.selected), total - 1);
  const rowText = (i: number, px: number): string => {
    const item = i >= 0 && i < total ? model.items[i] : null;
    if (!item) return '';
    return spread(`${item.icon ?? ' '} ${item.label}`, item.meta ?? '', px, measure);
  };
  const wingPx = ROW_W - 8;
  const boxes: BoxSpec[] = [];

  // 1. Full-screen capture layer, declared first (beneath everything) so every
  // swipe/tap lands on it; it doubles as the header line at the top.
  const right = [model.position, model.clock].filter(Boolean).join('  ·  ');
  boxes.push({
    id: 1, name: 'capture', x: 0, y: 0, w: SCREEN_W, h: SCREEN_H, pad: 2, capture: true, textColor: NORMAL,
    content: spread(` ${model.section}`, `${right} `, SCREEN_W - 12, measure),
  });

  // 2. List frame.
  boxes.push({ id: 2, name: 'listframe', x: 0, y: BODY_Y, w: LIST_W, h: BODY_H, content: '', border: 1, borderColor: 6, radius: 8, pad: 0 });

  // 3-5. Rows above (bottom-aligned with leading blanks), the framed
  // selection, rows below.
  const above: string[] = [];
  for (let r = WING_ROWS; r >= 1; r--) above.push(rowText(selected - r, wingPx));
  const below: string[] = [];
  for (let r = 1; r <= WING_ROWS; r++) below.push(rowText(selected + r, wingPx));
  const aboveY = BODY_Y + 3;
  const selY = aboveY + WING_H + 2;
  const belowY = selY + SEL_H + 2;
  boxes.push({ id: 3, name: 'above', x: ROW_X, y: aboveY, w: ROW_W, h: WING_H, pad: 0, textColor: DIM, content: above.join('\n') });
  boxes.push({
    id: 4, name: 'selected', x: 4, y: selY, w: LIST_W - 8, h: SEL_H, border: 1, borderColor: 13, radius: 6, pad: 3,
    textColor: BRIGHT, content: selected < 0 ? '  (empty)' : rowText(selected, LIST_W - 8 - 2 * 4 - 8),
  });
  boxes.push({ id: 5, name: 'below', x: ROW_X, y: belowY, w: ROW_W, h: WING_H, pad: 0, textColor: DIM, content: below.join('\n') });

  // 6-7. Detail card: framed body with the title box drawn over its top.
  const cardTextPx = CARD_W - 2 * CARD_PAD - 6;
  const titleLines = wrapPx(model.card.title, cardTextPx, 2, measure);
  const detail = fitLines(
    model.card.lines.flatMap((l) =>
      model.card.wrap && l ? wrapPx(l, cardTextPx, CARD_LINES, measure) : [fitPx(l, cardTextPx, measure)]),
    CARD_LINES - titleLines.length,
  );
  boxes.push({
    id: 6, name: 'card', x: CARD_X, y: BODY_Y, w: CARD_W, h: BODY_H, border: 1, borderColor: 10, radius: 8, pad: CARD_PAD,
    textColor: NORMAL,
    // Blank lines under the title box (drawn over the card's top).
    content: [...titleLines.map(() => ''), ...detail].join('\n'),
  });
  boxes.push({
    id: 7, name: 'cardtitle', x: CARD_X + CARD_PAD, y: BODY_Y + CARD_PAD - 2, w: CARD_W - 2 * CARD_PAD, h: Math.ceil(2 * PITCH) + 4, pad: 0,
    textColor: BRIGHT, content: titleLines.join('\n'),
  });

  // 8. Footer: gesture hints, scroll indicators.
  const more = `${selected - WING_ROWS > 0 ? '▲' : ' '} ${selected + WING_ROWS < total - 1 ? '▼' : ' '}`.trim();
  boxes.push({
    id: 8, name: 'footer', x: 0, y: FOOTER_Y, w: SCREEN_W, h: SCREEN_H - FOOTER_Y, pad: 0, textColor: DIM,
    content: spread(`  ${model.hints}`, `${more}  `, SCREEN_W - 8, measure),
  });

  return { boxes, key: layoutKey(boxes) };
}

/**
 * A modal card over a screen. Containers have no fill (text underneath would
 * show through the card, zOrder or not), so only the dimmed header stays
 * around the card (no gesture hints: nothing is selectable meanwhile).
 */
export function withOverlay(base: ScreenSpec, title: string, lines: string[], measure: Measure = measureWidth): ScreenSpec {
  const boxes: BoxSpec[] = base.boxes
    .filter((b) => b.capture)
    .map((b) => ({ ...b, textColor: DIM, border: 0 }));
  const w = 440;
  const h = 200;
  const pad = 14;
  const textPx = w - 2 * pad - 6;
  const maxLines = Math.floor((h - 2 * pad - 4) / PITCH); // 5
  const head = [
    ...wrapPx(title, textPx, 2, measure),
    '─'.repeat(Math.max(4, Math.floor(textPx / Math.max(1, measure('─'))))),
  ];
  const content = [...head, ...fitLines(lines.map((l) => fitPx(l, textPx, measure)), maxLines - head.length)].join('\n');
  boxes.push({
    id: 9, name: 'overlay', x: Math.round((SCREEN_W - w) / 2), y: Math.round((SCREEN_H - h) / 2), w, h,
    border: 2, borderColor: 15, radius: 10, pad, textColor: BRIGHT, content,
  });
  return { boxes, key: layoutKey(boxes) };
}

function layoutKey(boxes: BoxSpec[]): string {
  return boxes
    .map((b) => [b.id, b.x, b.y, b.w, b.h, b.border ?? 0, b.borderColor ?? 0, b.radius ?? 0, b.pad ?? -1, b.capture ? 1 : 0].join(','))
    .join('|');
}

/** "now", "5 min ago", "3 h ago", "yesterday", "4 d ago", "12 Mar". */
export function relativeTime(then: number, now = Date.now()): string {
  const s = Math.max(0, (now - then) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86_400) return 'yesterday';
  if (s < 14 * 86_400) return `${Math.round(s / 86_400)} d ago`;
  const d = new Date(then);
  return `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}`;
}
