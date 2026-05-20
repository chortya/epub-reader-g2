import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAR_PITCH_PX,
  EDGE_MARGIN,
  ITEMS_PER_PAGE,
  MIN_BOX_PX,
  ROW_HEIGHT,
  centerLabel,
  computeBoxWidthPx,
  computeRowOffsets,
  trimTrailingEmptySlots,
} from '../src/layout.ts';
import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from '../src/constants.ts';

// Background: v1.4.3 replaces rebuildSlots' fixed 4-row 576-px-wide grid with
// content-sized rows vertically centered on the display. Pure helpers live in
// src/layout.ts so the geometry math can be verified without a bridge.

test('computeBoxWidthPx: single short label clamps to MIN_BOX_PX', () => {
  assert.equal(computeBoxWidthPx(['ON']), MIN_BOX_PX);
});

test('computeBoxWidthPx: longest label drives width; others do not', () => {
  // Both arrays contain the same longest label.
  const short = computeBoxWidthPx(['ON', 'OFF']);
  const long = computeBoxWidthPx(['ON', 'Continue reading']);
  assert.ok(long > short);
});

test('computeBoxWidthPx: very long label clamps to DISPLAY_WIDTH - 2*EDGE_MARGIN', () => {
  const wide = 'x'.repeat(200);
  assert.equal(computeBoxWidthPx([wide]), DISPLAY_WIDTH - 2 * EDGE_MARGIN);
});

test('computeBoxWidthPx: empty strings are ignored', () => {
  assert.equal(computeBoxWidthPx(['', '', 'ON', '']), MIN_BOX_PX);
});

test('computeBoxWidthPx: all-empty input returns MIN_BOX_PX (no Infinity/NaN)', () => {
  assert.equal(computeBoxWidthPx([]), MIN_BOX_PX);
  assert.equal(computeBoxWidthPx(['', '', '']), MIN_BOX_PX);
});

test('computeBoxWidthPx: scales with longest label length', () => {
  const label = 'Continue reading'; // 16 chars
  const got = computeBoxWidthPx([label]);
  // Expected: ceil(16 * 9.76) + 2*4 = 157 + 8 = 165, then clamped above MIN_BOX_PX.
  const expectedRaw = Math.ceil(label.length * CHAR_PITCH_PX) + 8;
  assert.equal(got, Math.max(MIN_BOX_PX, expectedRaw));
});

test('trimTrailingEmptySlots: removes trailing empty rows from a 4-slot array', () => {
  assert.deepEqual(trimTrailingEmptySlots(['A', 'B', 'C', '']), ['A', 'B', 'C']);
  assert.deepEqual(trimTrailingEmptySlots(['A', 'B', '', '']), ['A', 'B']);
  assert.deepEqual(trimTrailingEmptySlots(['A', '', '', '']), ['A']);
});

test('trimTrailingEmptySlots: preserves internal empties so selectedSlot stays valid', () => {
  // If a future caller intentionally renders a blank row between visible
  // options, the trim must not shift indices.
  assert.deepEqual(trimTrailingEmptySlots(['A', '', 'C', '']), ['A', '', 'C']);
});

test('trimTrailingEmptySlots: tolerates null / undefined and caps at ITEMS_PER_PAGE', () => {
  assert.deepEqual(trimTrailingEmptySlots([null, undefined, 'C']), ['', '', 'C']);
  // Inputs longer than ITEMS_PER_PAGE are truncated to the page slot count
  // before trimming; pagination is caller-side.
  const five = ['A', 'B', 'C', 'D', 'E'];
  assert.equal(trimTrailingEmptySlots(five).length, ITEMS_PER_PAGE);
});

test('trimTrailingEmptySlots: all-empty input returns []', () => {
  assert.deepEqual(trimTrailingEmptySlots(['', '', '', '']), []);
  assert.deepEqual(trimTrailingEmptySlots([]), []);
});

test('computeRowOffsets: n=4 collapses to today’s grid', () => {
  assert.deepEqual(computeRowOffsets(ITEMS_PER_PAGE), [
    0,
    ROW_HEIGHT,
    2 * ROW_HEIGHT,
    3 * ROW_HEIGHT,
  ]);
});

test('computeRowOffsets: n=3 centers rows symmetrically', () => {
  const ys = computeRowOffsets(3);
  assert.equal(ys.length, 3);
  // Center of the rendered group should be near display center.
  const center = (ys[0] + ys[ys.length - 1] + ROW_HEIGHT) / 2;
  assert.ok(Math.abs(center - DISPLAY_HEIGHT / 2) <= 1, `center off: ${center}`);
  // Rows are evenly spaced by ROW_HEIGHT.
  for (let i = 1; i < ys.length; i++) {
    assert.equal(ys[i] - ys[i - 1], ROW_HEIGHT);
  }
});

test('computeRowOffsets: n=2 centers rows symmetrically', () => {
  const ys = computeRowOffsets(2);
  assert.equal(ys.length, 2);
  const center = (ys[0] + ys[1] + ROW_HEIGHT) / 2;
  assert.ok(Math.abs(center - DISPLAY_HEIGHT / 2) <= 1);
  assert.equal(ys[1] - ys[0], ROW_HEIGHT);
});

test('computeRowOffsets: n=1 centers the lone row vertically', () => {
  assert.deepEqual(computeRowOffsets(1), [Math.floor((DISPLAY_HEIGHT - ROW_HEIGHT) / 2)]);
});

test('computeRowOffsets: n=0 returns []', () => {
  assert.deepEqual(computeRowOffsets(0), []);
});

test('centerLabel: even box-vs-label delta pads symmetrically', () => {
  // 4 spaces before "AB" inside a 10-cell box: floor((10-2)/2) = 4.
  assert.equal(centerLabel('AB', 10), '    AB');
});

test('centerLabel: odd box-vs-label delta floors the left padding', () => {
  // floor((11-2)/2) = 4. We don't pad the right (no SDK alignment); we just
  // shift the text closer to center.
  assert.equal(centerLabel('AB', 11), '    AB');
});

test('centerLabel: label longer than box returns unchanged', () => {
  assert.equal(centerLabel('hello world', 5), 'hello world');
});

test('centerLabel: empty label produces only padding up to half the box', () => {
  assert.equal(centerLabel('', 6), '   ');
});
