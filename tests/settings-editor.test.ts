import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatSettingsRow,
  applyEditorValue,
  FLOW_SPEED_VALUES,
  TEXT_HEIGHT_VALUES,
  type AppConfig,
} from '../src/constants.ts';

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    hyphenation: true,
    statusBarPosition: 'bottom',
    readingMode: 'paged',
    flowSpeedWpm: 240,
    textHeightPercent: 80,
    ...overrides,
  };
}

// --- formatSettingsRow ---

test('formatSettingsRow: hyphenation ON/OFF casing', () => {
  assert.equal(formatSettingsRow('hyphenation', cfg({ hyphenation: true })), 'Hyphenation: ON');
  assert.equal(formatSettingsRow('hyphenation', cfg({ hyphenation: false })), 'Hyphenation: OFF');
});

test('formatSettingsRow: statusBarPosition labels', () => {
  assert.equal(formatSettingsRow('statusBarPosition', cfg({ statusBarPosition: 'bottom' })), 'Status bar: Bottom');
  assert.equal(formatSettingsRow('statusBarPosition', cfg({ statusBarPosition: 'none' })), 'Status bar: Hidden');
});

test('formatSettingsRow: readingMode labels', () => {
  assert.equal(formatSettingsRow('readingMode', cfg({ readingMode: 'paged' })), 'Reading mode: Paged');
  assert.equal(formatSettingsRow('readingMode', cfg({ readingMode: 'flow' })), 'Reading mode: Flow');
});

test('formatSettingsRow: flowSpeedWpm shows wpm suffix', () => {
  assert.equal(formatSettingsRow('flowSpeedWpm', cfg({ flowSpeedWpm: 240 })), 'Flow speed: 240 wpm');
  assert.equal(formatSettingsRow('flowSpeedWpm', cfg({ flowSpeedWpm: 600 })), 'Flow speed: 600 wpm');
});

test('formatSettingsRow: textHeightPercent shows percent suffix', () => {
  assert.equal(formatSettingsRow('textHeightPercent', cfg({ textHeightPercent: 80 })), 'Text height: 80%');
  assert.equal(formatSettingsRow('textHeightPercent', cfg({ textHeightPercent: 50 })), 'Text height: 50%');
});

// --- FLOW_SPEED_VALUES / TEXT_HEIGHT_VALUES shape ---

test('FLOW_SPEED_VALUES: 17 uniform 30-WPM steps from 120 to 600', () => {
  assert.equal(FLOW_SPEED_VALUES.length, 17, 'expected 17 steps');
  assert.equal(FLOW_SPEED_VALUES[0], 120, 'first is FLOW_MIN_WPM');
  assert.equal(FLOW_SPEED_VALUES[16], 600, 'last is FLOW_MAX_WPM');
  for (let i = 1; i < FLOW_SPEED_VALUES.length; i++) {
    assert.equal(FLOW_SPEED_VALUES[i] - FLOW_SPEED_VALUES[i - 1], 30, `step ${i} must be +30`);
  }
});

test('TEXT_HEIGHT_VALUES: 6 uniform 10% steps from 50 to 100', () => {
  assert.equal(TEXT_HEIGHT_VALUES.length, 6);
  assert.deepEqual([...TEXT_HEIGHT_VALUES], [50, 60, 70, 80, 90, 100]);
});

// --- applyEditorValue ---

test('applyEditorValue: hyphenation index 0 = ON, 1 = OFF', () => {
  const c = cfg({ hyphenation: false });
  applyEditorValue(c, 'hyphenation', 0);
  assert.equal(c.hyphenation, true);
  applyEditorValue(c, 'hyphenation', 1);
  assert.equal(c.hyphenation, false);
});

test('applyEditorValue: statusBarPosition index maps to [bottom, none]', () => {
  const c = cfg();
  applyEditorValue(c, 'statusBarPosition', 0);
  assert.equal(c.statusBarPosition, 'bottom');
  applyEditorValue(c, 'statusBarPosition', 1);
  assert.equal(c.statusBarPosition, 'none');
});

test('applyEditorValue: readingMode index maps to [paged, flow]', () => {
  const c = cfg();
  applyEditorValue(c, 'readingMode', 0);
  assert.equal(c.readingMode, 'paged');
  applyEditorValue(c, 'readingMode', 1);
  assert.equal(c.readingMode, 'flow');
});

test('applyEditorValue: flowSpeedWpm index 0 = 120, index 16 = 600', () => {
  const c = cfg();
  applyEditorValue(c, 'flowSpeedWpm', 0);
  assert.equal(c.flowSpeedWpm, 120);
  applyEditorValue(c, 'flowSpeedWpm', 16);
  assert.equal(c.flowSpeedWpm, 600);
  applyEditorValue(c, 'flowSpeedWpm', 4);
  assert.equal(c.flowSpeedWpm, 240, 'index 4 is the 5th step = 120 + 4*30 = 240');
});

test('applyEditorValue: textHeightPercent index maps to [50..100 by 10]', () => {
  const c = cfg();
  applyEditorValue(c, 'textHeightPercent', 0);
  assert.equal(c.textHeightPercent, 50);
  applyEditorValue(c, 'textHeightPercent', 3);
  assert.equal(c.textHeightPercent, 80);
  applyEditorValue(c, 'textHeightPercent', 5);
  assert.equal(c.textHeightPercent, 100);
});
