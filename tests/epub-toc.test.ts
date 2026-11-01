import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';

import { tocEntriesFromNav, tocEntriesFromNcx, tocTitlesByPath } from '../src/epub-toc.ts';
import { pickChapterTitle } from '../src/chapter-title.ts';

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>Title page</text></navLabel><content src="title.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>
      I. Down the Rabbit-Hole</text></navLabel><content src="text/ch01.xhtml#start"/>
      <navPoint id="n2a" playOrder="3"><navLabel><text>A sub-section</text></navLabel><content src="text/ch01.xhtml#sub"/></navPoint>
    </navPoint>
    <navPoint id="n3" playOrder="4"><navLabel><text>II. The Pool of Tears</text></navLabel><content src="text/ch02.xhtml"/></navPoint>
  </navMap>
</ncx>`;

const NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <nav epub:type="landmarks"><ol><li><a href="cover.xhtml">Cover</a></li></ol></nav>
  <nav epub:type="toc"><ol>
    <li><a href="ch01.xhtml">Chapter <em>One</em></a></li>
    <li><a href="ch02.xhtml#x">Two</a><ol><li><a href="ch02.xhtml#y">Two, part b</a></li></ol></li>
  </ol></nav>
</body></html>`;

test('NCX entries come out in document order with labels collapsed', () => {
  const doc = new DOMParser().parseFromString(NCX, 'text/xml') as unknown as Document;
  assert.deepEqual(tocEntriesFromNcx(doc), [
    { href: 'title.xhtml', label: 'Title page' },
    { href: 'text/ch01.xhtml#start', label: 'I. Down the Rabbit-Hole' },
    { href: 'text/ch01.xhtml#sub', label: 'A sub-section' },
    { href: 'text/ch02.xhtml', label: 'II. The Pool of Tears' },
  ]);
});

test('nav entries use the toc nav, not landmarks', () => {
  const doc = new DOMParser().parseFromString(NAV, 'text/xml') as unknown as Document;
  assert.deepEqual(tocEntriesFromNav(doc).map((e) => e.label), ['Chapter One', 'Two', 'Two, part b']);
});

test('first label per document wins; hrefs resolve relative to the TOC', () => {
  const doc = new DOMParser().parseFromString(NCX, 'text/xml') as unknown as Document;
  const titles = tocTitlesByPath(tocEntriesFromNcx(doc), (href) => `OEBPS/${href.split('#')[0]}`);
  assert.equal(titles.get('OEBPS/text/ch01.xhtml'), 'I. Down the Rabbit-Hole');
  assert.equal(titles.get('OEBPS/text/ch02.xhtml'), 'II. The Pool of Tears');
  assert.equal(titles.size, 3);
});

test('pickChapterTitle ignores a document title that is just the book title', () => {
  const book = "Alice's Adventures in Wonderland";
  assert.equal(pickChapterTitle('', '', "Alice's Adventures in Wonderland by Lewis Carroll", 4, book), 'Chapter 4');
  assert.equal(pickChapterTitle('III. A Caucus-Race', '', `${book} by Lewis Carroll`, 4, book), 'III. A Caucus-Race');
  assert.equal(pickChapterTitle('', '', 'The Pool of Tears', 3, book), 'The Pool of Tears');
  // Without a book title the old behaviour stands.
  assert.equal(pickChapterTitle('', '', 'Some Document', 2), 'Some Document');
});
