/**
 * Shared brand artwork for the reader's glasses-side UI.
 *
 * Drawing rules follow the official Even Realities design guidelines
 * (hub.evenrealities.com/docs/build/design-guidelines): flat FILLED shapes,
 * strokes >= 2px, silhouette-readable single subject, no hairline outlines.
 * Depth comes from distinct 4-bit greyscale tiers — the display quantizes to
 * 16 levels (~17 luminance per step, see even-toolkit png-utils).
 */

/** Greyscale tiers (canvas luminance -> device level). */
export const GREY_BRIGHT = '#f2f2f2'; // level 14 — primary mark / wordmark
export const GREY_MID = '#9a9a9a';    // level 9  — secondary detail, rules
export const GREY_DIM = '#5a5a5a';    // level 5  — tertiary info (version, hints)

export interface BookMarkGeometry {
  /** Canvas center x for the mark. */
  cx: number;
  /** Top edge of the mark. */
  topY: number;
  /** Page height. */
  pageH?: number;
  /** Page half width. */
  halfW?: number;
}

/**
 * Draw the filled open-book mark: two solid pages dipping at the spine, a
 * dark fold, and mid-grey text lines. Silhouette-first — reads at any size.
 */
export function drawBookMark(
  ctx: CanvasRenderingContext2D,
  { cx, topY, pageH = 52, halfW = 38 }: BookMarkGeometry,
): void {
  ctx.fillStyle = GREY_BRIGHT;
  // Left page: spine (lower) to outer edge (higher) — open-book dip.
  ctx.beginPath();
  ctx.moveTo(cx, topY + 6);
  ctx.lineTo(cx - halfW, topY);
  ctx.lineTo(cx - halfW, topY + pageH);
  ctx.lineTo(cx, topY + pageH + 6);
  ctx.closePath();
  ctx.fill();
  // Right page (mirror).
  ctx.beginPath();
  ctx.moveTo(cx, topY + 6);
  ctx.lineTo(cx + halfW, topY);
  ctx.lineTo(cx + halfW, topY + pageH);
  ctx.lineTo(cx, topY + pageH + 6);
  ctx.closePath();
  ctx.fill();
  // Spine shading: dark notch so the fold reads at a glance.
  ctx.fillStyle = '#101010';
  ctx.fillRect(cx - 1, topY + 8, 2, pageH - 4);
  // Text lines on the pages — mid grey, 3px (above the 2px floor).
  ctx.fillStyle = GREY_MID;
  for (let i = 0; i < 3; i++) {
    const ly = topY + 13 + i * 11;
    ctx.fillRect(cx - halfW + 6, ly, halfW - 14, 3);
    ctx.fillRect(cx + 8, ly, halfW - 14, 3);
  }
}

/** Total pixel height the mark occupies (pages + spine dip). */
export function bookMarkHeight(pageH = 52): number {
  return pageH + 6;
}
