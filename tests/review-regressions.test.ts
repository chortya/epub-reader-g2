import test from 'node:test';
import assert from 'node:assert/strict';

import { makeBookId } from '../src/book-id.ts';
import { pruneBridgeBooks } from '../src/db.ts';
import { pickChapterTitle } from '../src/chapter-title.ts';

test('makeBookId is stable and slug-safe', () => {
  const id = makeBookId('Alice in Wonderland.epub', 'Alice in Wonderland');

  assert.equal(id, makeBookId('Alice in Wonderland.epub', 'Alice in Wonderland'));
  assert.match(id, /^[a-z0-9-]+$/);
});

test('pruneBridgeBooks removes deleted entries from bridge fallback storage', () => {
  const entries = [
    { filename: 'keep.epub', title: 'Keep', base64: 'a', timestamp: 1 },
    { filename: 'remove.epub', title: 'Remove', base64: 'b', timestamp: 2 },
  ];

  assert.deepEqual(pruneBridgeBooks(entries, 'remove.epub'), [
    { filename: 'keep.epub', title: 'Keep', base64: 'a', timestamp: 1 },
  ]);
});

test('pickChapterTitle prefers real headings over generic chapter labels', () => {
  assert.equal(
    pickChapterTitle('', 'The March Hare', 'Chapter 7', 7),
    'The March Hare',
  );
  assert.equal(
    pickChapterTitle('', 'Chapter 7', 'Contents', 7),
    'Chapter 7',
  );
});
