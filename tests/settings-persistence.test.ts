import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadSettings,
  loadSettingsFromBridge,
  saveSettingsToBridge,
  config,
  FLOW_MIN_WPM,
  FLOW_MAX_WPM,
  TEXT_HEIGHT_MIN_PERCENT,
  TEXT_HEIGHT_MAX_PERCENT,
  SETTINGS_KEY,
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

// --- Bridge-backed persistence (fixes "settings don't persist on device") ---

function makeMockBridge(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const writes: Array<{ key: string; value: string }> = [];
  return {
    store,
    writes,
    async getLocalStorage(key: string) { return store.get(key) ?? ''; },
    async setLocalStorage(key: string, value: string) {
      store.set(key, value);
      writes.push({ key, value });
      return true;
    },
  };
}

test('saveSettingsToBridge: writes JSON.stringify(config) under SETTINGS_KEY', async () => {
  const bridge = makeMockBridge();
  const snapshot = { ...config };
  await saveSettingsToBridge(bridge);
  assert.equal(bridge.writes.length, 1);
  assert.equal(bridge.writes[0].key, SETTINGS_KEY);
  assert.deepEqual(JSON.parse(bridge.writes[0].value), snapshot);
});

test('loadSettingsFromBridge: applies bridge overrides onto config', async () => {
  const original = { ...config };
  try {
    const bridge = makeMockBridge({
      [SETTINGS_KEY]: JSON.stringify({
        hyphenation: !original.hyphenation,
        textHeightPercent: 60,
      }),
    });
    await loadSettingsFromBridge(bridge);
    assert.equal(config.hyphenation, !original.hyphenation);
    assert.equal(config.textHeightPercent, 60);
    // Unchanged fields stay at their previous values
    assert.equal(config.readingMode, original.readingMode);
  } finally {
    Object.assign(config, original);
  }
});

test('loadSettingsFromBridge: tolerates empty bridge value and missing key', async () => {
  const original = { ...config };
  const bridge = makeMockBridge(); // bridge returns '' for any key
  await loadSettingsFromBridge(bridge);
  assert.deepEqual({ ...config }, original);
});

test('loadSettingsFromBridge: tolerates a throwing bridge', async () => {
  const original = { ...config };
  const bridge = {
    async getLocalStorage(): Promise<string> { throw new Error('bridge down'); },
    async setLocalStorage(): Promise<boolean> { return false; },
  };
  await loadSettingsFromBridge(bridge); // must not throw
  assert.deepEqual({ ...config }, original);
});

test('saveSettingsToBridge: tolerates a throwing bridge', async () => {
  const bridge = {
    async getLocalStorage(): Promise<string> { return ''; },
    async setLocalStorage(): Promise<boolean> { throw new Error('bridge down'); },
  };
  await saveSettingsToBridge(bridge); // must not throw
});

test('loadSettings: extra unknown fields are ignored', () => {
  const raw = JSON.stringify({ textHeightPercent: 70, futureSetting: 'xyz' });
  const loaded = loadSettings(raw);
  assert.equal(loaded.textHeightPercent, 70);
  // @ts-expect-error — futureSetting shouldn't be copied into our Partial<AppConfig>
  assert.equal(loaded.futureSetting, undefined);
});
