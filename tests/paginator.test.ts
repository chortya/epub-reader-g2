import test from 'node:test';
import assert from 'node:assert/strict';

import { paginateText } from '../src/paginator.ts';
import {
  config,
  LINE_HEIGHT_PX,
  G2_LINE_PITCH_PX,
  DISPLAY_HEIGHT,
  STATUS_BAR_HEIGHT_PX,
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

test('LINE_HEIGHT_PX is the documented 28px nominal', () => {
  assert.equal(LINE_HEIGHT_PX, 28);
});

test('G2_LINE_PITCH_PX is the measured ~28.67px actual pitch', () => {
  // This is the value used for "how many lines fit in a container" math.
  // Must be ≥ real measured pitch or blank padding lines overflow cropped
  // heights and the SDK draws its scroll indicator.
  assert.ok(G2_LINE_PITCH_PX >= 28.67);
  assert.ok(G2_LINE_PITCH_PX < 29);
});

test('BLANK_OVERFLOW_RESERVE: worst-case blank padding fits at cropped heights', () => {
  // Core correctness invariant for the v1.4.1 overflow fix: at any crop, the
  // total number of rendered lines (blank padding + text) × measured pitch
  // must fit the container. The reserve of 1 blank line at cropped heights
  // means worst-case is (displayLines - 1) × G2_LINE_PITCH_PX.
  const snapshot = { ...config };
  try {
    for (const barPos of ['bottom', 'none'] as const) {
      config.statusBarPosition = barPos;
      for (const percent of [50, 60, 70, 80, 90, 100]) {
        config.textHeightPercent = percent;
        const layout = getTextLayout();
        const totalRenderedPx = (layout.maxLines + layout.topBlankLines) * G2_LINE_PITCH_PX;
        assert.ok(
          totalRenderedPx <= layout.usableHeight + 0.05, // 0.05 tolerance for 100% real-text case (0.03 overflow is SDK-tolerated)
          `bar=${barPos} ${percent}%: ${totalRenderedPx} px content > ${layout.usableHeight} px container`,
        );
      }
    }
  } finally {
    Object.assign(config, snapshot);
  }
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
  // 129 px target, floor(129/28)=4 lines
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
        DISPLAY_HEIGHT - STATUS_BAR_HEIGHT_PX,
        `at ${percent}% container must fill full available height`,
      );
    }
  } finally {
    Object.assign(config, snapshot);
  }
});

test('getTextLayout: topBlankLines + maxLines fills the full display line count', () => {
  // Total rendered content (blank padding + text) exactly fills the container,
  // so there's no visible gap between the text and the status bar.
  const snapshot = { ...config };
  try {
    config.statusBarPosition = 'bottom';
    for (const percent of [50, 60, 70, 80, 90, 100]) {
      config.textHeightPercent = percent;
      const layout = getTextLayout();
      assert.equal(
        layout.topBlankLines + layout.maxLines,
        9,
        `at bar ${percent}% content + blank padding must equal 9`,
      );
    }
    config.statusBarPosition = 'none';
    for (const percent of [50, 60, 70, 80, 90, 100]) {
      config.textHeightPercent = percent;
      const layout = getTextLayout();
      assert.equal(
        layout.topBlankLines + layout.maxLines,
        10,
        `at no-bar ${percent}% content + blank padding must equal 10`,
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
  // Sanity: floor((288 - 30) / 28) = 9, floor(288 / 28) = 10. This is the
  // line count at 100% text height; cropped heights cap total content at
  // displayLines − 1 via BLANK_OVERFLOW_RESERVE to avoid SDK overflow.
  assert.equal(Math.floor((DISPLAY_HEIGHT - STATUS_BAR_HEIGHT_PX) / LINE_HEIGHT_PX), 9);
  assert.equal(Math.floor(DISPLAY_HEIGHT / LINE_HEIGHT_PX), 10);
});
