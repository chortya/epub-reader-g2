import test from 'node:test';
import assert from 'node:assert/strict';

import { makeBookId, makeContentBookId } from '../src/book-id.ts';
import { pruneBridgeBooks, upsertBridgeBook, type SerializedBook } from '../src/db.ts';
import { createSerialExecutor } from '../src/operation-queue.ts';
import { pickChapterTitle } from '../src/chapter-title.ts';
import { formatBookPickerLabel, matchesBookQuery } from '../src/book-selection.ts';
import { toggleStatusBarPosition } from '../src/reading-progress.ts';

test('makeBookId is stable and slug-safe', () => {
  const id = makeBookId('Alice in Wonderland.epub', 'Alice in Wonderland');

  assert.equal(id, makeBookId('Alice in Wonderland.epub', 'Alice in Wonderland'));
  assert.match(id, /^[a-z0-9-]+$/);
});

test('makeContentBookId is content-stable and independent of filename/title metadata', async () => {
  const bytes = new TextEncoder().encode('same epub bytes').buffer;
  const other = new TextEncoder().encode('different epub bytes').buffer;

  assert.equal(await makeContentBookId(bytes), await makeContentBookId(bytes.slice(0)));
  assert.notEqual(await makeContentBookId(bytes), await makeContentBookId(other));
  assert.match(await makeContentBookId(bytes), /^epub-[a-f0-9]{64}$/);
});

test('upsertBridgeBook keeps a fourth distinct book instead of silently evicting one', () => {
  let entries: SerializedBook[] = [];
  for (let i = 1; i <= 4; i++) {
    entries = upsertBridgeBook(entries, {
      bookId: `book-${i}`,
      filename: `book-${i}.epub`,
      title: `Book ${i}`,
      base64: String(i),
      timestamp: i,
    });
  }

  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map((book) => book.bookId), ['book-4', 'book-3', 'book-2', 'book-1']);
});

test('upsertBridgeBook keeps different content identities with the same filename', () => {
  const first: SerializedBook = {
    bookId: 'content-a', filename: 'download.epub', title: 'First', base64: 'a', timestamp: 1,
  };
  const second: SerializedBook = {
    bookId: 'content-b', filename: 'download.epub', title: 'Second', base64: 'b', timestamp: 2,
  };

  assert.deepEqual(upsertBridgeBook([first], second), [second, first]);
});

test('upsertBridgeBook exact re-upload replaces only the matching content identity', () => {
  const old: SerializedBook = {
    bookId: 'same-content', filename: 'old.epub', title: 'Old metadata', base64: 'a', timestamp: 1,
  };
  const other: SerializedBook = {
    bookId: 'other-content', filename: 'old.epub', title: 'Other book', base64: 'b', timestamp: 2,
  };
  const refreshed: SerializedBook = {
    bookId: 'same-content', filename: 'renamed.epub', title: 'New metadata', base64: 'a', timestamp: 3,
  };

  assert.deepEqual(upsertBridgeBook([other, old], refreshed), [refreshed, other]);
});

test('pruneBridgeBooks deletes by immutable bookId, not a colliding filename', () => {
  const keep: SerializedBook = {
    bookId: 'keep-id', filename: 'same.epub', title: 'Keep', base64: 'a', timestamp: 1,
  };
  const remove: SerializedBook = {
    bookId: 'remove-id', filename: 'same.epub', title: 'Remove', base64: 'b', timestamp: 2,
  };

  assert.deepEqual(pruneBridgeBooks([keep, remove], 'remove-id'), [keep]);
});

test('createSerialExecutor preserves order and continues after a failed mutation', async () => {
  const events: string[] = [];
  const serial = createSerialExecutor();
  const first = serial(async () => {
    events.push('first:start');
    await Promise.resolve();
    events.push('first:end');
    throw new Error('expected failure');
  });
  const second = serial(async () => {
    events.push('second:start');
    events.push('second:end');
  });

  await assert.rejects(first, /expected failure/);
  await second;
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('formatBookPickerLabel distinguishes duplicate titles by filename', () => {
  const books = [
    { bookId: 'id-a', title: 'Collected Works', filename: 'author-a.epub', uploadedAt: 1 },
    { bookId: 'id-b', title: 'Collected Works', filename: 'author-b.epub', uploadedAt: 2 },
  ];

  assert.equal(formatBookPickerLabel(books[0], books), 'author-a - Collected Works');
  assert.equal(formatBookPickerLabel(books[1], books), 'author-b - Collected Works');
});

test('formatBookPickerLabel uses an ID suffix when title and filename both collide', () => {
  const books = [
    { bookId: 'epub-1111aaaa', title: 'Same', filename: 'book.epub', uploadedAt: 1 },
    { bookId: 'epub-2222bbbb', title: 'Same', filename: 'book.epub', uploadedAt: 2 },
  ];

  assert.equal(formatBookPickerLabel(books[0], books), 'AAAA book - Same');
  assert.equal(formatBookPickerLabel(books[1], books), 'BBBB book - Same');
});

test('matchesBookQuery searches title and filename case-insensitively', () => {
  const book = { bookId: 'id', title: 'Die Verwandlung', filename: 'kafka.epub', uploadedAt: 1 };

  assert.equal(matchesBookQuery(book, 'VERWAND'), true);
  assert.equal(matchesBookQuery(book, 'KAFKA'), true);
  assert.equal(matchesBookQuery(book, 'alice'), false);
  assert.equal(matchesBookQuery(book, '   '), true);
});

test('toggleStatusBarPosition alternates between the 9-line footer and 10-line canvas', () => {
  assert.equal(toggleStatusBarPosition('bottom'), 'none');
  assert.equal(toggleStatusBarPosition('none'), 'bottom');
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

// --- Phase 1.5: split bridge storage (index + per-book payloads) ---

test('upsertBookIndex upserts by bookId and sorts newest first', async () => {
  const { upsertBookIndex } = await import('../src/db.ts');
  const a = { bookId: 'a', filename: 'a.epub', title: 'A', timestamp: 100 };
  const b = { bookId: 'b', filename: 'b.epub', title: 'B', timestamp: 200 };
  assert.deepEqual(upsertBookIndex([a], b).map((e) => e.bookId), ['b', 'a']);
  const a2 = { ...a, timestamp: 300 };
  const merged = upsertBookIndex([a, b], a2);
  assert.equal(merged.length, 2, 'upsert replaces, never duplicates');
  assert.deepEqual(merged.map((e) => e.bookId), ['a', 'b']);
});

test('parseBookIndex tolerates corruption and validates entry shape', async () => {
  const { parseBookIndex } = await import('../src/db.ts');
  assert.deepEqual(parseBookIndex(''), []);
  assert.deepEqual(parseBookIndex('not json'), []);
  assert.deepEqual(parseBookIndex('{"x":1}'), []);
  assert.deepEqual(parseBookIndex('[{"bookId":"a","filename":"a.epub","title":"A","timestamp":1},{"junk":true}]'), [
    { bookId: 'a', filename: 'a.epub', title: 'A', timestamp: 1 },
  ]);
});

test('bridge library split: save → load → delete round-trip with legacy dual-write', async () => {
  const { saveEpubBufferToDB, getRecentBooksFromDB, deleteFromDB } = await import('../src/db.ts');
  const store = new Map<string, string>();
  const bridge = {
    async setLocalStorage(key: string, value: string) { store.set(key, value); return true; },
    async getLocalStorage(key: string) { return store.get(key) ?? ''; },
  };

  const bytes = new TextEncoder().encode('fake epub bytes').buffer;
  const saved = await saveEpubBufferToDB(bytes, 'book.epub', 'Round Trip', bridge);
  assert.match(saved.bookId, /^epub-[a-f0-9]{64}$/);

  // Split keys written: index + one payload key.
  const index = JSON.parse(store.get('epub-book-index')!);
  assert.equal(index.length, 1);
  assert.ok(store.get(`epub-book-data-${saved.bookId}`)?.length, 'payload key written');
  // Legacy blob mirror dual-written for 1.4.6 rollback.
  const legacy = JSON.parse(store.get('epub-recent-books')!);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].bookId, saved.bookId);

  // Load resolves through the split keys.
  const loaded = await getRecentBooksFromDB(bridge);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].bookId, saved.bookId);
  assert.equal(new Uint8Array(loaded[0].buffer).byteLength, new Uint8Array(bytes).byteLength);

  // Delete clears index, payload, and legacy mirror.
  await deleteFromDB(saved.bookId, bridge);
  assert.equal(JSON.parse(store.get('epub-book-index')!).length, 0);
  assert.equal(store.get(`epub-book-data-${saved.bookId}`), '');
  assert.equal(JSON.parse(store.get('epub-recent-books')!).length, 0);
});

test('bridge library split: legacy-blob fallback loads when the index is missing', async () => {
  const { getRecentBooksFromDB } = await import('../src/db.ts');
  const store = new Map<string, string>();
  const bridge = {
    async setLocalStorage(key: string, value: string) { store.set(key, value); return true; },
    async getLocalStorage(key: string) { return store.get(key) ?? ''; },
  };
  // Simulate a 1.4.6 device: only the legacy blob exists.
  store.set('epub-recent-books', JSON.stringify([{
    bookId: 'legacy-1', filename: 'old.epub', title: 'Old',
    base64: btoa('old bytes'), timestamp: 1,
  }]));

  const loaded = await getRecentBooksFromDB(bridge);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].bookId, 'legacy-1');
});
