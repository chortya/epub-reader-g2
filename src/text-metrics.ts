/**
 * Pixel-accurate G2 text measurement (Phase 2).
 *
 * The firmware font is proportional (NOT monospace), so char-count heuristics
 * systematically mis-fit labels — a measured 59-char Latin line can exceed the
 * 576 px container. This adapter wraps @evenrealities/pretext, which mirrors
 * the EvenHub/LVGL font metrics exactly, and is the single import site for
 * pixel measurement in the reader (footer/status line, menu box widths).
 */
import { getTextWidth, pxTruncate, measureTextWrap } from '@evenrealities/pretext';

export { getTextWidth, pxTruncate, measureTextWrap };

/** Inner content width of a full-width container with the standard 6 px padding. */
export const READING_INNER_WIDTH = 576 - 2 * 6;

/** Inner width of the footer container (paddingLength 0, full width). */
export const FOOTER_INNER_WIDTH = 576;

/**
 * Width of a string in px using the firmware's font metrics.
 * Convenience alias so call sites read clearly.
 */
export function measureWidth(text: string): number {
  return getTextWidth(text);
}
