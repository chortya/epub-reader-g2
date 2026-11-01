import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DOMParser } from 'linkedom';

import { Md5, md5Hex } from '../src/md5.ts';
import {
  ChapterLocator,
  bookPercentage,
  fragmentPrefix,
  koreaderPartialMd5Samples,
  parseXPointer,
  positionForPercentage,
} from '../src/kosync-locator.ts';

function nodeMd5(bytes: Uint8Array | string): string {
  return createHash('md5').update(bytes).digest('hex');
}

test('md5Hex matches node:crypto across padding boundaries', () => {
  for (const len of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 4097]) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (i * 31 + 7) & 0xff;
    assert.equal(md5Hex(bytes), nodeMd5(bytes), `len ${len}`);
  }
  assert.equal(md5Hex('password'), '5f4dcc3b5aa765d61d8327deb882cf99');
  assert.equal(md5Hex('Ünïcödé'), nodeMd5('Ünïcödé'));
});

test('Md5 incremental updates equal a single update', () => {
  const bytes = new Uint8Array(3000).map((_, i) => (i * 13) & 0xff);
  const hasher = new Md5();
  hasher.update(bytes.subarray(0, 10)).update(bytes.subarray(10, 1500)).update(bytes.subarray(1500));
  assert.equal(hasher.digestHex(), nodeMd5(bytes));
});

test('KOReader partial MD5 samples offsets 0, 1K, 4K, 16K, ... and stops past EOF', () => {
  const bytes = new Uint8Array(20_000).map((_, i) => i & 0xff);
  const samples = koreaderPartialMd5Samples(bytes);
  // offsets: 0 (i=-1 wraps), 1024, 4096, 16384; 65536 is past EOF.
  assert.equal(samples.length, 4);
  assert.equal(samples[0][0], bytes[0]);
  assert.equal(samples[1][0], bytes[1024]);
  assert.equal(samples[2][0], bytes[4096]);
  assert.equal(samples[3].length, 20_000 - 16384 > 1024 ? 1024 : 20_000 - 16384);

  // Reference implementation, transcribed from KOReader util.partialMD5.
  const hasher = createHash('md5');
  for (let i = -1; i <= 10; i++) {
    const offset = (1024 << (2 * i)) >>> 0;
    if (offset >= bytes.length) break;
    hasher.update(bytes.subarray(offset, offset + 1024));
  }
  const ours = new Md5();
  for (const s of samples) ours.update(s);
  assert.equal(ours.digestHex(), hasher.digest('hex'));
});

test('parseXPointer handles KOReader-style pointers', () => {
  assert.deepEqual(parseXPointer('/body/DocFragment[12]/body/div/p[3]/text().42'), {
    fragment: 12,
    steps: [
      { kind: 'element', name: 'div', index: 1 },
      { kind: 'element', name: 'p', index: 3 },
      { kind: 'text', index: 1 },
    ],
    point: 42,
  });
  assert.deepEqual(parseXPointer('/body/DocFragment[3]/body/h2'), {
    fragment: 3, steps: [{ kind: 'element', name: 'h2', index: 1 }], point: null,
  });
  assert.deepEqual(parseXPointer('/body/DocFragment[3]/body/p[2]/text()[2].0')?.steps[1], { kind: 'text', index: 2 });
  assert.deepEqual(parseXPointer('/body/DocFragment[7]'), { fragment: 7, steps: [], point: null });
  assert.equal(parseXPointer('/body/DocFragment[0]/body'), null);
  assert.equal(parseXPointer('12'), null);
  assert.equal(parseXPointer('/body/DocFragment[2]/body/p[x]'), null);
  assert.equal(fragmentPrefix(0), '/body/DocFragment[1]/body');
});

const XHTML = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title></head>
<body>
  <div class="chapter">
    <h2>Chapter I. Down the Rabbit-Hole</h2>
    <p>Alice was beginning to get <em>very</em> tired of sitting by her sister on the bank.</p>
    <p>So she was considering in her own mind “as well as she could”, for the hot day made her feel sleepy.</p>
    <blockquote><p>Quoted verse line one</p><p>Quoted verse line two</p></blockquote>
    <p>There was nothing so <i>very</i> remarkable in that.</p>
  </div>
</body></html>`;

// What the extractor produces for XHTML above (indent, quote replacement).
const CHAPTER_TEXT = [
  'Chapter I. Down the Rabbit-Hole',
  '  Alice was beginning to get very tired of sitting by her sister on the bank.',
  '  So she was considering in her own mind "as well as she could", for the hot day made her feel sleepy.',
  '  Quoted verse line one',
  '  Quoted verse line two',
  '  There was nothing so very remarkable in that.',
].join('\n');

function locator(): ChapterLocator {
  const doc = new DOMParser().parseFromString(XHTML, 'text/html');
  return new ChapterLocator(doc.querySelector('body') as unknown as Element, CHAPTER_TEXT);
}

test('ChapterLocator anchors each text block to its offset in the chapter text', () => {
  const loc = locator();
  // h2, p, p, blockquote/p x2, p — the div and blockquote are pure containers.
  assert.equal(loc.anchorCount, 6);
  const so = CHAPTER_TEXT.indexOf('So she was');
  assert.equal(loc.pathForOffset(so), '/div[1]/p[2]');
  assert.equal(loc.pathForOffset(so + 20), '/div[1]/p[2]');
  assert.equal(loc.pathForOffset(0), '/div[1]/h2[1]');
  assert.equal(loc.pathForOffset(CHAPTER_TEXT.indexOf('verse line two')), '/div[1]/blockquote[1]/p[2]');
  assert.equal(loc.pathForOffset(CHAPTER_TEXT.length - 1), '/div[1]/p[3]');
});

test('ChapterLocator resolves XPointer steps back to chapter offsets', () => {
  const loc = locator();
  const steps = (xp: string) => parseXPointer(`/body/DocFragment[1]/body${xp}`)!;
  const at = (xp: string) => {
    const p = steps(xp);
    return loc.offsetForSteps(p.steps, p.point);
  };
  assert.equal(at('/div/p[2]'), CHAPTER_TEXT.indexOf('So she was'));
  assert.equal(at('/div/blockquote/p[2]'), CHAPTER_TEXT.indexOf('Quoted verse line two'));
  // Text node + point refines inside the paragraph: "Alice was " -> "beginning".
  assert.equal(at('/div/p[1]/text().10'), CHAPTER_TEXT.indexOf('beginning'));
  // Text after an inline element: second text node of p[1] starts at " tired".
  assert.equal(at('/div/p[1]/text()[2].1'), CHAPTER_TEXT.indexOf('tired'));
  // A container resolves to its first anchored block.
  assert.equal(at('/div/blockquote'), CHAPTER_TEXT.indexOf('Quoted verse line one'));
  assert.equal(at(''), 0);
  // Missing elements fall back to the deepest resolved ancestor.
  assert.equal(at('/div/p[2]/span[4]'), CHAPTER_TEXT.indexOf('So she was'));
});

test('round trip: offset -> path -> offset lands on the paragraph start', () => {
  const loc = locator();
  for (const needle of ['Alice was', 'So she was', 'Quoted verse line two', 'There was nothing']) {
    const offset = CHAPTER_TEXT.indexOf(needle);
    const path = loc.pathForOffset(offset + 5)!;
    const p = parseXPointer(`${fragmentPrefix(4)}${path}`)!;
    assert.equal(p.fragment, 5);
    assert.equal(loc.offsetForSteps(p.steps, p.point), offset, needle);
  }
});

test('bookPercentage / positionForPercentage are inverse at character precision', () => {
  const lengths = [100, 300, 600];
  assert.equal(bookPercentage(lengths, 0, 0), 0);
  assert.equal(bookPercentage(lengths, 1, 150), 0.25);
  assert.equal(bookPercentage(lengths, 2, 600), 1);
  assert.deepEqual(positionForPercentage(lengths, 0.25), { chapterIndex: 1, offset: 150 });
  assert.deepEqual(positionForPercentage(lengths, 0), { chapterIndex: 0, offset: 0 });
  assert.deepEqual(positionForPercentage(lengths, 1), { chapterIndex: 2, offset: 599 });
  assert.deepEqual(positionForPercentage([], 0.5), { chapterIndex: 0, offset: 0 });
});

test('paragraphs that open with the same words anchor to their own text', () => {
  const same = 'It was a dark and stormy night, said the narrator';
  const html = `<html><body><p>${same} once.</p><p>${same} twice.</p><p>${same} thrice.</p></body></html>`;
  const text = [`${same} once.`, `  ${same} twice.`, `  ${same} thrice.`].join('\n');
  const body = new DOMParser().parseFromString(html, 'text/html').querySelector('body') as unknown as Element;
  const loc = new ChapterLocator(body, text);
  const second = text.indexOf(`${same} twice.`);
  const third = text.indexOf(`${same} thrice.`);
  assert.equal(loc.pathForOffset(5), '/p[1]');
  assert.equal(loc.pathForOffset(second + 3), '/p[2]');
  assert.equal(loc.pathForOffset(third), '/p[3]');
  const p2 = parseXPointer('/body/DocFragment[1]/body/p[2]')!;
  assert.equal(loc.offsetForSteps(p2.steps, p2.point), second);
});

test('an inline node outside any block maps to the block before it, not the chapter start', () => {
  const html = '<html><body><div><p>First block here.</p><p>Second block here.</p><span>loose inline text</span></div></body></html>';
  const text = 'First block here.\n  Second block here.\n  loose inline text';
  const body = new DOMParser().parseFromString(html, 'text/html').querySelector('body') as unknown as Element;
  const loc = new ChapterLocator(body, text);
  const p = parseXPointer('/body/DocFragment[1]/body/div/span/text().3')!;
  assert.equal(loc.offsetForSteps(p.steps, p.point), text.indexOf('Second block'));
});

test('a block split by <br> is consumed whole, so the next paragraph anchors to itself', () => {
  const pre = 'Repeated opening words here';
  const html = `<html><body><p>${pre} first line<br/>${pre} second line</p><p>${pre} in paragraph two.</p></body></html>`;
  const text = [`${pre} first line`, `${pre} second line`, `  ${pre} in paragraph two.`].join('\n');
  const body = new DOMParser().parseFromString(html, 'text/html').querySelector('body') as unknown as Element;
  const loc = new ChapterLocator(body, text);
  const p2 = parseXPointer('/body/DocFragment[1]/body/p[2]')!;
  assert.equal(loc.offsetForSteps(p2.steps, p2.point), text.indexOf(`${pre} in paragraph two.`));
});
