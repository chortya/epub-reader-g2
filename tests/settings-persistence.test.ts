import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadSettings,
  config,
  FLOW_MIN_WPM,
  FLOW_MAX_WPM,
  TEXT_HEIGHT_MIN_PERCENT,
  TEXT_HEIGHT_MAX_PERCENT,
  type AppConfig,
} from '../src/constants.ts';

// --- Empty / malformed input ---

test('loadSettings: null returns empty overrides', () => {
  assert.deepEqual(loadSettings(null), {});
});

test('loadSettings: empty string returns empty overrides', () => {
  assert.deepEqual(loadSettings(''), {});
});

test('loadSettings: malformed JSON returns empty overrides (no throw)', () => {
  assert.deepEqual(loadSettings('{not json'), {});
});

test('loadSettings: non-object JSON returns empty overrides', () => {
  assert.deepEqual(loadSettings('null'), {});
  assert.deepEqual(loadSettings('42'), {});
  assert.deepEqual(loadSettings('"string"'), {});
  assert.deepEqual(loadSettings('[1,2,3]'), {}); // array is object but we reject
});

// --- textHeightPercent (the new setting) ---

test('loadSettings: preserves valid textHeightPercent within range', () => {
  for (const v of [50, 60, 70, 80, 90, 100]) {
    const result = loadSettings(JSON.stringify({ textHeightPercent: v }));
    assert.equal(result.textHeightPercent, v, `value ${v} should pass through`);
  }
});

test('loadSettings: clamps textHeightPercent below min to ' + TEXT_HEIGHT_MIN_PERCENT, () => {
  for (const v of [0, 10, 49, -5, -1000]) {
    const result = loadSettings(JSON.stringify({ textHeightPercent: v }));
    assert.equal(result.textHeightPercent, TEXT_HEIGHT_MIN_PERCENT);
  }
});

test('loadSettings: clamps textHeightPercent above max to ' + TEXT_HEIGHT_MAX_PERCENT, () => {
  for (const v of [101, 500, 9999]) {
    const result = loadSettings(JSON.stringify({ textHeightPercent: v }));
    assert.equal(result.textHeightPercent, TEXT_HEIGHT_MAX_PERCENT);
  }
});

test('loadSettings: rounds fractional textHeightPercent', () => {
  assert.equal(loadSettings(JSON.stringify({ textHeightPercent: 74.4 })).textHeightPercent, 74);
  assert.equal(loadSettings(JSON.stringify({ textHeightPercent: 74.6 })).textHeightPercent, 75);
});

test('loadSettings: rejects non-numeric textHeightPercent', () => {
  for (const v of ['80', null, true, {}, [], undefined]) {
    const result = loadSettings(JSON.stringify({ textHeightPercent: v }));
    assert.equal(result.textHeightPercent, undefined, `value ${JSON.stringify(v)} should be ignored`);
  }
});

test('loadSettings: rejects NaN and Infinity for textHeightPercent', () => {
  // Note: JSON.stringify converts NaN/Infinity to null, so we hand-craft the raw string.
  assert.equal(loadSettings('{"textHeightPercent": null}').textHeightPercent, undefined);
});

// --- flowSpeedWpm ---

test('loadSettings: preserves valid flowSpeedWpm within range', () => {
  assert.equal(loadSettings(JSON.stringify({ flowSpeedWpm: 240 })).flowSpeedWpm, 240);
});

test('loadSettings: clamps flowSpeedWpm to [FLOW_MIN_WPM, FLOW_MAX_WPM]', () => {
  assert.equal(loadSettings(JSON.stringify({ flowSpeedWpm: 50 })).flowSpeedWpm, FLOW_MIN_WPM);
  assert.equal(loadSettings(JSON.stringify({ flowSpeedWpm: 9999 })).flowSpeedWpm, FLOW_MAX_WPM);
});

// --- statusBarPosition ---

test('loadSettings: accepts all three statusBarPosition values', () => {
  for (const pos of ['bottom', 'right', 'none']) {
    assert.equal(loadSettings(JSON.stringify({ statusBarPosition: pos })).statusBarPosition, pos);
  }
});

test('loadSettings: rejects invalid statusBarPosition', () => {
  assert.equal(loadSettings(JSON.stringify({ statusBarPosition: 'top' })).statusBarPosition, undefined);
  assert.equal(loadSettings(JSON.stringify({ statusBarPosition: 42 })).statusBarPosition, undefined);
});

test('loadSettings: legacy showStatusBar=true migrates to bottom', () => {
  assert.equal(loadSettings(JSON.stringify({ showStatusBar: true })).statusBarPosition, 'bottom');
});

test('loadSettings: legacy showStatusBar=false migrates to none', () => {
  assert.equal(loadSettings(JSON.stringify({ showStatusBar: false })).statusBarPosition, 'none');
});

test('loadSettings: modern statusBarPosition wins over legacy showStatusBar', () => {
  const raw = JSON.stringify({ statusBarPosition: 'right', showStatusBar: false });
  assert.equal(loadSettings(raw).statusBarPosition, 'right');
});

// --- readingMode ---

test('loadSettings: accepts paged and flow for readingMode', () => {
  assert.equal(loadSettings(JSON.stringify({ readingMode: 'paged' })).readingMode, 'paged');
  assert.equal(loadSettings(JSON.stringify({ readingMode: 'flow' })).readingMode, 'flow');
});

test('loadSettings: rejects invalid readingMode', () => {
  assert.equal(loadSettings(JSON.stringify({ readingMode: 'scroll' })).readingMode, undefined);
});

// --- hyphenation ---

test('loadSettings: accepts boolean hyphenation', () => {
  assert.equal(loadSettings(JSON.stringify({ hyphenation: true })).hyphenation, true);
  assert.equal(loadSettings(JSON.stringify({ hyphenation: false })).hyphenation, false);
});

test('loadSettings: rejects non-boolean hyphenation', () => {
  assert.equal(loadSettings(JSON.stringify({ hyphenation: 'yes' })).hyphenation, undefined);
  assert.equal(loadSettings(JSON.stringify({ hyphenation: 1 })).hyphenation, undefined);
});

// --- Round-trip with the real saveSettings output ---

test('loadSettings: round-trips a JSON.stringify(config)-shaped blob', () => {
  const saved: AppConfig = {
    hyphenation: false,
    statusBarPosition: 'right',
    readingMode: 'flow',
    flowSpeedWpm: 360,
    textHeightPercent: 70,
  };
  const roundTripped = loadSettings(JSON.stringify(saved));
  assert.deepEqual(roundTripped, saved);
});

test('loadSettings: round-trips the default config', () => {
  // Capture what saveSettings() would write given a fresh config
  const serialized = JSON.stringify(config);
  const loaded = loadSettings(serialized);
  // Every field should be present and equal to its default
  assert.equal(loaded.hyphenation, config.hyphenation);
  assert.equal(loaded.statusBarPosition, config.statusBarPosition);
  assert.equal(loaded.readingMode, config.readingMode);
  assert.equal(loaded.flowSpeedWpm, config.flowSpeedWpm);
  assert.equal(loaded.textHeightPercent, config.textHeightPercent);
});

// --- Partial JSON (forward/backward compat) ---

test('loadSettings: missing fields leave defaults for that field only', () => {
  // User with old settings that predate textHeightPercent should retain defaults
  // for the new field and preserve the other fields they had configured.
  const raw = JSON.stringify({ hyphenation: false, flowSpeedWpm: 200 });
  const loaded = loadSettings(raw);
  assert.equal(loaded.hyphenation, false);
  assert.equal(loaded.flowSpeedWpm, 200);
  assert.equal(loaded.textHeightPercent, undefined, 'old save file has no textHeightPercent');
  assert.equal(loaded.statusBarPosition, undefined);
  assert.equal(loaded.readingMode, undefined);
});

test('loadSettings: extra unknown fields are ignored', () => {
  const raw = JSON.stringify({ textHeightPercent: 70, futureSetting: 'xyz' });
  const loaded = loadSettings(raw);
  assert.equal(loaded.textHeightPercent, 70);
  // @ts-expect-error — futureSetting shouldn't be copied into our Partial<AppConfig>
  assert.equal(loaded.futureSetting, undefined);
});
