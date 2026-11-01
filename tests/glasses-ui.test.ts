import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TEXT_CONTAINERS,
  SCREEN_H,
  SCREEN_W,
  WING_ROWS,
  buildListScreen,
  fitLines,
  fitPx,
  progressBar,
  relativeTime,
  spread,
  withOverlay,
  wrapPx,
  type ListScreenModel,
} from '../src/glasses-ui.ts';

// 10 px per character keeps the expectations readable.
const mono = (s: string) => s.length * 10;

function model(n: number, selected: number): ListScreenModel {
  return {
    section: 'Library',
    position: `${selected + 1}/${n}`,
    clock: '12:34',
    items: Array.from({ length: n }, (_, i) => ({ label: `Book ${i}`, icon: '○', meta: `${i}%` })),
    selected,
    card: { title: `Book ${selected}`, lines: ['', 'Author'] },
    hints: '● open   ●● back',
  };
}

const box = (spec: ReturnType<typeof buildListScreen>, name: string) => {
  const b = spec.boxes.find((x) => x.name === name);
  assert.ok(b, `missing box ${name}`);
  return b;
};

test('fitPx truncates with an ellipsis and keeps short text', () => {
  assert.equal(fitPx('short', 100, mono), 'short');
  assert.equal(fitPx('a long label here', 80, mono), 'a lon...');
  assert.ok(mono(fitPx('a long label here', 80, mono)) <= 80);
  assert.equal(fitPx('abc', 20, mono), '...');
});

test('spread right-aligns the right part within the width', () => {
  const s = spread('left', 'right', 200, mono);
  assert.ok(s.startsWith('left') && s.endsWith('right'));
  assert.ok(mono(s) <= 200);
  // An over-long left side is truncated, the right side is kept whole.
  const t = spread('x'.repeat(50), '58%', 120, mono);
  assert.ok(t.endsWith('58%') && t.includes('...') && mono(t) <= 120);
});

test('wrapPx wraps greedily and truncates the last allowed line', () => {
  assert.deepEqual(wrapPx('one two three', 70, 3, mono), ['one two', 'three']);
  const lines = wrapPx('aa bb cc dd ee ff gg', 50, 2, mono);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'aa bb');
  assert.ok(lines[1].endsWith('...') && mono(lines[1]) <= 50);
  assert.deepEqual(wrapPx('', 50, 2, mono), []);
  // One line: the overflow is marked, not silently dropped.
  assert.equal(wrapPx('alpha beta gamma', 100, 1, mono)[0], 'alpha b...');
  assert.deepEqual(wrapPx('alpha', 100, 0, mono), []);
});

test('progressBar fills proportionally and survives bad input', () => {
  assert.equal(progressBar(0.5, 100, mono), '━━━━━─────');
  assert.equal(progressBar(2, 100, mono), '━'.repeat(10));
  assert.equal(progressBar(Number.NaN, 100, mono), '─'.repeat(10));
});

test('list screen stays within the SDK limits on every selection', () => {
  for (const n of [0, 1, 3, 7, 40]) {
    for (let sel = 0; sel < Math.max(1, n); sel++) {
      const spec = buildListScreen(model(n, sel), mono);
      assert.ok(spec.boxes.length <= MAX_TEXT_CONTAINERS, `${spec.boxes.length} containers`);
      assert.equal(spec.boxes.filter((b) => b.capture).length, 1);
      assert.equal(spec.boxes[0].capture, true, 'capture layer declared first');
      assert.deepEqual([spec.boxes[0].x, spec.boxes[0].y, spec.boxes[0].w, spec.boxes[0].h], [0, 0, SCREEN_W, SCREEN_H]);
      assert.equal(new Set(spec.boxes.map((b) => b.id)).size, spec.boxes.length, 'unique ids');
      for (const b of spec.boxes) {
        assert.ok(b.content.length <= 1000, `${b.name} too long`);
        assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= SCREEN_W && b.y + b.h <= SCREEN_H, `${b.name} off screen`);
      }
    }
  }
});

test('moving the selection changes content only (flicker-free upgrade)', () => {
  const keys = new Set(Array.from({ length: 12 }, (_, i) => buildListScreen(model(12, i), mono).key));
  assert.equal(keys.size, 1);
  // Even across list sizes the geometry is the same.
  assert.equal(buildListScreen(model(1, 0), mono).key, buildListScreen(model(12, 5), mono).key);
});

test('the selection sits in the framed middle row, neighbours above/below', () => {
  const spec = buildListScreen(model(10, 5), mono);
  assert.match(box(spec, 'selected').content, /Book 5\b/);
  const above = box(spec, 'above').content.split('\n');
  const below = box(spec, 'below').content.split('\n');
  assert.equal(above.length, WING_ROWS);
  assert.equal(below.length, WING_ROWS);
  assert.match(above[WING_ROWS - 1], /Book 4\b/);
  assert.match(above[0], /Book 2\b/);
  assert.match(below[0], /Book 6\b/);
  assert.match(box(spec, 'footer').content, /▲ ▼\s*$/);
});

test('the first item leaves the rows above blank (bottom-aligned wheel)', () => {
  const spec = buildListScreen(model(2, 0), mono);
  assert.deepEqual(box(spec, 'above').content.split('\n'), ['', '', '']);
  assert.match(box(spec, 'below').content.split('\n')[0], /Book 1\b/);
  assert.doesNotMatch(box(spec, 'footer').content, /[▲▼]/);
});

test('selection is clamped and an empty list renders a placeholder', () => {
  assert.match(box(buildListScreen(model(3, 99), mono), 'selected').content, /Book 2\b/);
  assert.match(box(buildListScreen(model(0, 0), mono), 'selected').content, /empty/);
});

test('card wraps prose when asked and truncates list lines otherwise', () => {
  const m = model(1, 0);
  m.card = { title: 'T', lines: ['word '.repeat(30).trim()] };
  const truncated = box(buildListScreen(m, mono), 'card').content.split('\n');
  // One blank line under the one-line title, then the truncated line.
  assert.equal(truncated.length, 2);
  assert.ok(truncated[1].endsWith('...'));
  m.card.wrap = true;
  const wrapped = box(buildListScreen(m, mono), 'card').content.split('\n');
  assert.ok(wrapped.length > 3);
  assert.ok(wrapped.length <= 7);
});

test('overlay keeps only the dimmed header, never text under the card', () => {
  const base = buildListScreen(model(5, 2), mono);
  const spec = withOverlay(base, 'A Book', ['', 'Opening the book...'], mono);
  assert.deepEqual(spec.boxes.map((b) => b.name), ['capture', 'overlay']);
  assert.equal(spec.boxes[0].content, base.boxes[0].content);
  assert.notEqual(spec.key, base.key);
  const o = box(spec, 'overlay');
  assert.ok(o.content.startsWith('A Book\n─'));
  assert.ok(o.content.split('\n').length <= 5);
  assert.ok(o.x + o.w <= SCREEN_W && o.y + o.h <= SCREEN_H);
});

test('relativeTime buckets', () => {
  const now = Date.UTC(2026, 10, 1, 12);
  assert.equal(relativeTime(now - 30_000, now), 'just now');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 min ago');
  assert.equal(relativeTime(now - 3 * 3_600_000, now), '3 h ago');
  assert.equal(relativeTime(now - 30 * 3_600_000, now), 'yesterday');
  assert.equal(relativeTime(now - 4 * 86_400_000, now), '4 d ago');
  assert.match(relativeTime(now - 40 * 86_400_000, now), /^\d+ (Sep|Oct)$/);
});

test('fitLines drops spacer lines before content', () => {
  assert.deepEqual(fitLines(['', 'a', '', 'b', 'c'], 4), ['', 'a', 'b', 'c']);
  assert.deepEqual(fitLines(['', 'a', '', 'b', 'c'], 3), ['a', 'b', 'c']);
  assert.deepEqual(fitLines(['a', 'b', 'c'], 2), ['a', 'b']);
  assert.deepEqual(fitLines(['a'], 0), []);
});

test('a full settings card keeps every value line', () => {
  const m = model(1, 0);
  m.card = { title: 'Settings', lines: ['', 'Hyphenation: ON', 'Status bar: Bottom', 'Reading mode: Flow', 'Flow speed: 240 wpm', 'Text height: 100%', 'Brightness: 4/4'] };
  const lines = box(buildListScreen(m, mono), 'card').content.split('\n');
  assert.ok(lines.length <= 7);
  assert.equal(lines.at(-1), 'Brightness: 4/4');
  assert.ok(lines.includes('Hyphenation: ON'));
});

test('overlay keeps the status line under a two-line title', () => {
  const base = buildListScreen(model(1, 0), mono);
  const spec = withOverlay(base, 'The Adventures of Sherlock Holmes and Other Stories', ['', 'Opening the book...'], mono);
  const lines = box(spec, 'overlay').content.split('\n');
  assert.equal(lines.at(-1), 'Opening the book...');
  assert.ok(lines.length <= 5);
});
