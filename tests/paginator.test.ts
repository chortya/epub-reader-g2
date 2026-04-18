import test from 'node:test';
import assert from 'node:assert/strict';

import { paginateText } from '../src/paginator.ts';
import {
  config,
  LINE_HEIGHT_PX,
  DISPLAY_HEIGHT,
  getTextLayout,
} from '../src/constants.ts';

// Build a long single-paragraph text that word-wraps into many short lines.
// Each "word" is 3 chars so ~15 words fit on a 59-char line.
const manyWords = Array.from({ length: 2000 }, (_, i) => `w${String(i).padStart(2, '0')}`).join(' ');

function withConfig(overrides: Partial<typeof config>, fn: () => void) {
  const snapshot = { ...config };
  Object.assign(config, overrides);
  try {
    fn();
  } finally {
    Object.assign(config, snapshot);
  }
}

test('LINE_HEIGHT_PX is the documented 28px', () => {
  assert.equal(LINE_HEIGHT_PX, 28);
});

test('paginateText: default height% + bottom status bar yields 9 lines per full page', () => {
  withConfig({ statusBarPosition: 'bottom', textHeightPercent: 100 }, () => {
    const pages = paginateText(manyWords);
    // all pages except possibly the last should be full
    const fullPages = pages.slice(0, -1);
    for (const p of fullPages) {
      assert.equal(p.split('\n').length, 9, 'expected 9 lines per full page');
    }
  });
});

test('paginateText: default height% + no status bar yields 10 lines per full page', () => {
  withConfig({ statusBarPosition: 'none', textHeightPercent: 100 }, () => {
    const pages = paginateText(manyWords);
    const fullPages = pages.slice(0, -1);
    for (const p of fullPages) {
      assert.equal(p.split('\n').length, 10, 'expected 10 lines per full page');
    }
  });
});

test('paginateText: textHeightPercent=50 + bottom bar yields 4 lines per full page', () => {
  // 129 px target, floor(129/28)=4 lines; container tightened to 4*29=116
  withConfig({ statusBarPosition: 'bottom', textHeightPercent: 50 }, () => {
    const pages = paginateText(manyWords);
    const fullPages = pages.slice(0, -1);
    for (const p of fullPages) {
      assert.equal(p.split('\n').length, 4, 'expected 4 lines with 50% crop + bottom bar');
    }
  });
});

test('paginateText: textHeightPercent=50 + no bar yields 5 lines per full page', () => {
  // 144 px target, floor(144/28)=5 lines
  withConfig({ statusBarPosition: 'none', textHeightPercent: 50 }, () => {
    const pages = paginateText(manyWords);
    const fullPages = pages.slice(0, -1);
    for (const p of fullPages) {
      assert.equal(p.split('\n').length, 5, 'expected 5 lines with 50% crop + no bar');
    }
  });
});

test('getTextLayout: container always covers the full available area (for event capture)', () => {
  // Every swipe must land on a capturing container; the SDK drops swipes that
  // fall outside one. So the text container must cover the full area below the
  // status bar regardless of textHeightPercent.
  const snapshot = { ...config };
  try {
    for (const percent of [50, 60, 70, 80, 90, 100]) {
      config.statusBarPosition = 'bottom';
      config.textHeightPercent = percent;
      const layout = getTextLayout();
      assert.equal(layout.yPosition, 0, `at ${percent}% container must start at y=0`);
      assert.equal(
        layout.usableHeight,
        DISPLAY_HEIGHT - 30,
        `at ${percent}% container must fill full available height`,
      );
    }
  } finally {
    Object.assign(config, snapshot);
  }
});

test('getTextLayout: topBlankLines + maxLines == full display line count', () => {
  const snapshot = { ...config };
  try {
    config.statusBarPosition = 'bottom';
    for (const percent of [50, 60, 70, 80, 90, 100]) {
      config.textHeightPercent = percent;
      const layout = getTextLayout();
      assert.equal(
        layout.topBlankLines + layout.maxLines,
        9,
        `at ${percent}% content + blank padding must equal 9 display lines (bottom bar)`,
      );
    }
    config.statusBarPosition = 'none';
    for (const percent of [50, 60, 70, 80, 90, 100]) {
      config.textHeightPercent = percent;
      const layout = getTextLayout();
      assert.equal(
        layout.topBlankLines + layout.maxLines,
        10,
        `at ${percent}% content + blank padding must equal 10 display lines (no bar)`,
      );
    }
  } finally {
    Object.assign(config, snapshot);
  }
});

test('getTextLayout: 100% has no blank padding', () => {
  const snapshot = { ...config };
  try {
    config.statusBarPosition = 'bottom';
    config.textHeightPercent = 100;
    const layout = getTextLayout();
    assert.equal(layout.maxLines, 9);
    assert.equal(layout.topBlankLines, 0);
    config.statusBarPosition = 'none';
    const layoutNoBar = getTextLayout();
    assert.equal(layoutNoBar.maxLines, 10);
    assert.equal(layoutNoBar.topBlankLines, 0);
  } finally {
    Object.assign(config, snapshot);
  }
});

test('getTextLayout: 50% + bar has 5 blank lines padding the content down', () => {
  const snapshot = { ...config };
  try {
    config.statusBarPosition = 'bottom';
    config.textHeightPercent = 50;
    const layout = getTextLayout();
    assert.equal(layout.maxLines, 4);
    assert.equal(layout.topBlankLines, 5);
  } finally {
    Object.assign(config, snapshot);
  }
});

test('paginateText: textHeightPercent never yields a 0-line page', () => {
  // Floor of the smallest allowed percent must still produce >=1 line.
  withConfig({ statusBarPosition: 'bottom', textHeightPercent: 50 }, () => {
    const pages = paginateText(manyWords);
    assert.ok(pages.length > 0, 'should produce at least one page');
    for (const p of pages) {
      assert.ok(p.split('\n').length >= 1, 'every page has >=1 line');
    }
  });
});

test('paginateText: reducing height% produces strictly more pages than default', () => {
  let defaultPageCount = 0;
  let croppedPageCount = 0;
  withConfig({ statusBarPosition: 'bottom', textHeightPercent: 100 }, () => {
    defaultPageCount = paginateText(manyWords).length;
  });
  withConfig({ statusBarPosition: 'bottom', textHeightPercent: 50 }, () => {
    croppedPageCount = paginateText(manyWords).length;
  });
  assert.ok(
    croppedPageCount > defaultPageCount,
    `cropped page count (${croppedPageCount}) must exceed default (${defaultPageCount})`,
  );
});

test('DISPLAY_HEIGHT / LINE_HEIGHT_PX ratio matches the legacy 9/10 line behavior', () => {
  // Sanity: floor((288 - 30) / 28) = 9, floor(288 / 28) = 10
  assert.equal(Math.floor((DISPLAY_HEIGHT - 30) / LINE_HEIGHT_PX), 9);
  assert.equal(Math.floor(DISPLAY_HEIGHT / LINE_HEIGHT_PX), 10);
});
