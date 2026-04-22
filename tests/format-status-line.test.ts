import test from 'node:test';
import assert from 'node:assert/strict';

import { formatStatusLine } from '../src/constants.ts';

// Helper: construct a local Date at a given H:MM. JS Date uses local tz; we do
// not care which tz as long as getHours/getMinutes match what we assert.
function at(h: number, m: number): Date {
  const d = new Date(2026, 0, 1, h, m, 0, 0);
  return d;
}

test('formatStatusLine: prepends 00:00 for midnight', () => {
  const out = formatStatusLine({ now: at(0, 0), infoText: 'Ch 1/1 Pg 1/1 ', maxChars: 59, progress: 0 });
  assert.ok(out.startsWith('00:00'), `expected "00:00" prefix, got: ${JSON.stringify(out)}`);
});

test('formatStatusLine: zero-pads single-digit hour and minute', () => {
  const out = formatStatusLine({ now: at(9, 5), infoText: 'Ch 1/1 Pg 1/1 ', maxChars: 59, progress: 0 });
  assert.ok(out.startsWith('09:05'), `expected "09:05" prefix, got: ${JSON.stringify(out)}`);
});

test('formatStatusLine: 23:59 renders without wrap', () => {
  const out = formatStatusLine({ now: at(23, 59), infoText: 'Ch 1/1 Pg 1/1 ', maxChars: 59, progress: 0 });
  assert.ok(out.startsWith('23:59'), `expected "23:59" prefix, got: ${JSON.stringify(out)}`);
});

test('formatStatusLine: progress 0 produces an all-empty bar', () => {
  const out = formatStatusLine({ now: at(12, 0), infoText: 'Ch 1/1 Pg 1/1 ', maxChars: 59, progress: 0 });
  // Bar characters: filled '━' and empty '─'. At progress 0, no filled chars.
  assert.ok(!out.includes('━'), `expected no filled "━" at progress 0, got: ${JSON.stringify(out)}`);
  assert.ok(out.includes('─'), `expected empty "─" chars present, got: ${JSON.stringify(out)}`);
});

test('formatStatusLine: progress 1 produces an all-filled bar', () => {
  const out = formatStatusLine({ now: at(12, 0), infoText: 'Ch 1/1 Pg 1/1 ', maxChars: 59, progress: 1 });
  assert.ok(out.includes('━'), `expected filled "━" chars at progress 1, got: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('─'), `expected no empty "─" at progress 1, got: ${JSON.stringify(out)}`);
});

test('formatStatusLine: mid-progress mixes fill and empty and fits maxChars', () => {
  const out = formatStatusLine({ now: at(12, 0), infoText: 'Ch 1/1 Pg 1/1 ', maxChars: 59, progress: 0.5 });
  assert.ok(out.includes('━'), 'expected filled chars at mid-progress');
  assert.ok(out.includes('─'), 'expected empty chars at mid-progress');
  assert.ok(out.length <= 59, `output exceeds maxChars: ${out.length} > 59`);
});

test('formatStatusLine: stays within maxChars=48 for Cyrillic width', () => {
  const out = formatStatusLine({ now: at(9, 5), infoText: 'Ch 1/1 Pg 1/1 ', maxChars: 48, progress: 0.5 });
  assert.ok(out.length <= 48, `output exceeds maxChars=48: length ${out.length}, value ${JSON.stringify(out)}`);
  assert.ok(out.startsWith('09:05'), 'clock must not be truncated off the front');
});

test("formatStatusLine: bar never renders at negative width when infoText is long", () => {
  // Construct an infoText that leaves essentially no room for a bar.
  const longInfo = 'X'.repeat(40) + ' ';
  const out = formatStatusLine({ now: at(12, 0), infoText: longInfo, maxChars: 48, progress: 0.5 });
  // The contract is "no crash, no negative-length bar". The formatter should
  // either clamp the bar to a minimum width or render the line without one,
  // but never throw and never produce a NaN-count repeat.
  assert.ok(typeof out === 'string', 'must return a string');
  assert.ok(out.length > 0, 'must not be empty');
});
