import { config, getTextLayout } from './constants.ts';
import type Hypher from 'hypher';
import { getTextWidth, READING_INNER_WIDTH } from './text-metrics.ts';

let hyphenator: Hypher | null = null;
let wideGlyphs = false;

/** Set the hyphenator instance (called after language detection) */
export function setHyphenator(h: Hypher): void {
  hyphenator = h;
}

/**
 * Flag that the book uses a script with wider glyphs (Cyrillic). Only the
 * legacy character-count measure uses it; pixel wrapping measures glyphs.
 */
export function setWideGlyphs(wide: boolean): void {
  wideGlyphs = wide;
}

/** How wide a line is, and how wide it may be. */
export type LineMeasure = { width: (line: string) => number; limit: number };

/**
 * Widest line we emit, in px. The reading container is 576 px wide with 6 px
 * padding (564 px of text). The firmware wraps any longer line itself, which
 * would push a line off the page, so keep a small margin for rounding.
 */
export const READING_LINE_LIMIT_PX = READING_INNER_WIDTH - 4;

/** Default: firmware glyph metrics (the G2 font is proportional). */
export const PIXEL_MEASURE: LineMeasure = { width: getTextWidth, limit: READING_LINE_LIMIT_PX };

function charMeasure(maxChars: number): LineMeasure {
  return { width: (line) => line.length, limit: maxChars };
}

function resolveMeasure(measure: number | LineMeasure | undefined): LineMeasure {
  if (typeof measure === 'number') return charMeasure(measure);
  return measure ?? PIXEL_MEASURE;
}

/**
 * Split chapter text into fixed-size pages.
 * Word-wraps to the measured line width + end-of-line hyphenation.
 * `measure` is a LineMeasure, or a character count (legacy/tests); default
 * is pixel-accurate. When `maxLines` is omitted it's derived from the
 * current text-height crop.
 */
export function paginateText(
  text: string,
  measure?: number | LineMeasure,
  maxLines = getTextLayout().maxLines,
): string[] {
  return paginateTextWithOffsets(text, measure, maxLines).pages;
}

export interface PaginatedChapter {
  pages: string[];
  /** Source offset of each page's first character within `text`. Parallel to pages. */
  pageStarts: number[];
}

/**
 * Bump when the pagination algorithm/geometry changes meaningfully (plan §5).
 * Saved offsets index the chapter text, not pages, so they stay exact across
 * re-wrapping (v1.6.0 pixel wrapping kept 1); bump only if offsets change
 * meaning (e.g. different text extraction).
 */
export const PAGINATION_VERSION = 1;

/**
 * paginateText plus per-page source offsets. Offsets let a saved position
 * survive repagination (text-height changes, pixel-accurate wrapping):
 * save the page's start offset, restore by finding the page containing it.
 */
export function paginateTextWithOffsets(
  text: string,
  measure?: number | LineMeasure,
  maxLines = getTextLayout().maxLines,
): PaginatedChapter {
  if (!text || text.trim().length === 0) {
    return { pages: ['(empty)'], pageStarts: [0] };
  }

  const wrapped = wordWrapWithOffsets(text, resolveMeasure(measure));

  const pages: string[] = [];
  const pageStarts: number[] = [];
  for (let i = 0; i < wrapped.length; i += maxLines) {
    const pageLines = wrapped.slice(i, i + maxLines);
    const page = pageLines.map((l) => l.text).join('\n').trimEnd();
    if (page.length > 0) {
      pages.push(page);
      pageStarts.push(pageLines[0].start);
    }
  }

  return pages.length > 0 ? { pages, pageStarts } : { pages: ['(empty)'], pageStarts: [0] };
}

/** Legacy character budget (kept for callers that still think in chars). */
export function defaultMaxChars(): number {
  return wideGlyphs ? 48 : 59;
}

/**
 * Find the page containing `offset` (binary search over page starts).
 * Offsets past the last page clamp to it.
 */
export function pageForOffset(pageStarts: number[], offset: number): number {
  if (pageStarts.length === 0) return 0;
  let lo = 0;
  let hi = pageStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pageStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

interface WrappedLine {
  text: string;
  start: number;
}

function wordWrapWithOffsets(text: string, measure: LineMeasure): WrappedLine[] {
  const lines: WrappedLine[] = [];
  let cursor = 0;

  for (const para of text.split('\n')) {
    const paraStart = cursor;
    const trimmed = para.trimEnd();
    if (trimmed.length === 0) {
      lines.push({ text: '', start: paraStart });
      cursor += para.length + 1;
      continue;
    }
    wrapParagraphWithOffsets(trimmed, measure, lines, paraStart);
    cursor += para.length + 1;
  }

  return lines;
}

function wrapParagraphWithOffsets(
  text: string,
  measure: LineMeasure,
  lines: WrappedLine[],
  paraStart: number,
): void {
  const fits = (line: string) => measure.width(line) <= measure.limit;
  const words = text.split(/( +)/);
  let currentLine = '';
  let currentLineStart = paraStart;
  let cursor = paraStart;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.length === 0) continue;

    if (/^ +$/.test(word)) {
      if (currentLine.length > 0) {
        currentLine += word;
      }
      cursor += word.length;
      continue;
    }

    const testLine = currentLine.length > 0 ? currentLine + word : word;

    if (fits(testLine)) {
      if (currentLine.length === 0) currentLineStart = cursor;
      currentLine = testLine;
      cursor += word.length;
      continue;
    }

    // Word doesn't fit. Try hyphenation on current line.
    if (config.hyphenation && hyphenator && word.length >= 5) {
      const prefix = currentLine;
      const hyphenated = tryHyphenate(word, (head) => fits(prefix + head + '-'));
      if (hyphenated) {
        if (currentLine.length === 0) currentLineStart = cursor;
        currentLine += hyphenated.head + '-';
        lines.push({ text: currentLine, start: currentLineStart });
        currentLine = hyphenated.tail;
        currentLineStart = cursor + hyphenated.head.length;
        cursor += word.length;
        continue;
      }
    }

    // Push current line, move word to next line.
    if (currentLine.trimEnd().length > 0) {
      lines.push({ text: currentLine.trimEnd(), start: currentLineStart });
      currentLine = '';
    }

    // If word is longer than a full line, hyphenate across lines
    if (!fits(word)) {
      let rest = word;
      let restStart = cursor;
      currentLineStart = cursor;
      while (!fits(rest)) {
        if (config.hyphenation && hyphenator) {
          const hyp = tryHyphenate(rest, (head) => fits(head + '-'));
          if (hyp) {
            lines.push({ text: hyp.head + '-', start: restStart });
            rest = hyp.tail;
            restStart += hyp.head.length;
            currentLineStart = restStart;
            continue;
          }
        }
        // Hard break: the longest prefix that fits with a trailing '-'.
        let cut = Math.max(1, rest.length - 1);
        while (cut > 1 && !fits(rest.slice(0, cut) + '-')) cut--;
        const slice = rest.slice(0, cut);
        lines.push({ text: slice + '-', start: restStart });
        rest = rest.slice(cut);
        restStart += slice.length;
        currentLineStart = restStart;
      }
      currentLine = rest;
    } else {
      currentLine = word;
      currentLineStart = cursor;
    }
    cursor += word.length;
  }

  if (currentLine.trimEnd().length > 0) {
    lines.push({ text: currentLine.trimEnd(), start: currentLineStart });
  }
}

/**
 * Try to hyphenate a word at the latest syllable break where `fits(head)`
 * (the caller appends its own prefix and the '-').
 */
function tryHyphenate(
  word: string,
  fits: (head: string) => boolean,
): { head: string; tail: string } | null {
  if (!hyphenator) return null;

  // Separate leading letters from trailing punctuation
  const match = word.match(/^([\p{L}\p{M}]+)(.*)/u);
  if (!match) return null;

  const [, core, suffix] = match;
  if (core.length < 4) return null;

  const syllables = hyphenator.hyphenate(core);
  if (syllables.length < 2) return null;

  // Find the longest prefix of syllables that fits (with '-')
  let head = '';
  let bestSplit = -1;

  for (let i = 0; i < syllables.length - 1; i++) {
    const candidate = head + syllables[i];
    if (fits(candidate)) {
      head = candidate;
      bestSplit = i;
    } else {
      break;
    }
  }

  if (bestSplit < 0 || head.length < 2) return null;

  const tail = syllables.slice(bestSplit + 1).join('') + suffix;
  return { head, tail };
}

/** Char offset (page-relative) of the `wordIndex`-th non-whitespace token. */
export function flowOffsetForWord(pageText: string, wordIndex: number): number {
  let seenWords = 0;
  for (const m of pageText.matchAll(/\S+|\s+/g)) {
    if (/\S/.test(m[0])) {
      if (seenWords === wordIndex) return m.index ?? 0;
      seenWords++;
    }
  }
  return 0;
}

/** Inverse: count words that begin strictly before `offset` (page-relative). */
export function flowWordForOffset(pageText: string, offset: number): number {
  let wordIndex = 0;
  for (const m of pageText.matchAll(/\S+|\s+/g)) {
    if ((m.index ?? 0) >= offset) break;
    if (/\S/.test(m[0])) wordIndex++;
  }
  return wordIndex;
}
