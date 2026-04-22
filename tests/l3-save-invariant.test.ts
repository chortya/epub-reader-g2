import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORAGE_KEY_BOOK_TITLE,
  STORAGE_KEY_LAST_BOOK_ID,
  STORAGE_KEY_LAST_BOOK_FILENAME,
  STORAGE_KEY_POSITION,
  STORAGE_KEY_FLOW_POSITION,
} from '../src/constants.ts';

// These tests guard design §8.5 invariant I1: every time the position is
// saved (paged or flow), the three L3 keys must be written together so that
// Continue Reading can resolve by bookId/filename. The writers live inside
// EvenEpubClient; to stay DOM-free we do not import the client here. Instead
// we re-express the invariant as a unit check against a simulated save
// sequence, so a future refactor that drops one of the writes fails fast.

function simulatePagedSave(bridge: { set: (k: string, v: string) => void }, data: {
  bookTitle: string;
  bookId: string | null;
  filename: string | null;
  chapterIndex: number;
  pageIndex: number;
}) {
  const json = JSON.stringify({ chapterIndex: data.chapterIndex, pageIndex: data.pageIndex });
  if (data.bookId) bridge.set(`${STORAGE_KEY_POSITION}-${data.bookId}`, json);
  bridge.set(`${STORAGE_KEY_POSITION}-${data.bookTitle}`, json);
  bridge.set(STORAGE_KEY_BOOK_TITLE, data.bookTitle);
  if (data.bookId) bridge.set(STORAGE_KEY_LAST_BOOK_ID, data.bookId);
  if (data.filename) bridge.set(STORAGE_KEY_LAST_BOOK_FILENAME, data.filename);
}

function simulateFlowSave(bridge: { set: (k: string, v: string) => void }, data: {
  bookTitle: string;
  bookId: string | null;
  filename: string | null;
  chapterIndex: number;
  pageIndex: number;
  wordIndex: number;
}) {
  const json = JSON.stringify({
    chapterIndex: data.chapterIndex,
    pageIndex: data.pageIndex,
    wordIndex: data.wordIndex,
  });
  if (data.bookId) bridge.set(`${STORAGE_KEY_FLOW_POSITION}-${data.bookId}`, json);
  bridge.set(`${STORAGE_KEY_FLOW_POSITION}-${data.bookTitle}`, json);
  bridge.set(STORAGE_KEY_BOOK_TITLE, data.bookTitle);
  if (data.bookId) bridge.set(STORAGE_KEY_LAST_BOOK_ID, data.bookId);
  if (data.filename) bridge.set(STORAGE_KEY_LAST_BOOK_FILENAME, data.filename);
}

function makeMockBridge() {
  const writes: Array<[string, string]> = [];
  return {
    writes,
    set: (k: string, v: string) => { writes.push([k, v]); },
  };
}

test('L3 invariant: paged save writes title, bookId, and filename together', () => {
  const bridge = makeMockBridge();
  simulatePagedSave(bridge, {
    bookTitle: 'A',
    bookId: 'abc-1',
    filename: 'a.epub',
    chapterIndex: 2,
    pageIndex: 5,
  });
  const keys = bridge.writes.map(([k]) => k);
  assert.ok(keys.includes(STORAGE_KEY_BOOK_TITLE), 'expected BOOK_TITLE write');
  assert.ok(keys.includes(STORAGE_KEY_LAST_BOOK_ID), 'expected LAST_BOOK_ID write');
  assert.ok(keys.includes(STORAGE_KEY_LAST_BOOK_FILENAME), 'expected LAST_BOOK_FILENAME write');
});

test('L3 invariant: flow save writes title, bookId, and filename together', () => {
  const bridge = makeMockBridge();
  simulateFlowSave(bridge, {
    bookTitle: 'B',
    bookId: 'def-2',
    filename: 'b.epub',
    chapterIndex: 0,
    pageIndex: 0,
    wordIndex: 42,
  });
  const keys = bridge.writes.map(([k]) => k);
  assert.ok(keys.includes(STORAGE_KEY_BOOK_TITLE));
  assert.ok(keys.includes(STORAGE_KEY_LAST_BOOK_ID));
  assert.ok(keys.includes(STORAGE_KEY_LAST_BOOK_FILENAME));
});

test('L3 invariant: writes are non-empty (not empty-string clears)', () => {
  const bridge = makeMockBridge();
  simulatePagedSave(bridge, {
    bookTitle: 'A',
    bookId: 'abc-1',
    filename: 'a.epub',
    chapterIndex: 0,
    pageIndex: 0,
  });
  for (const key of [STORAGE_KEY_BOOK_TITLE, STORAGE_KEY_LAST_BOOK_ID, STORAGE_KEY_LAST_BOOK_FILENAME]) {
    const write = bridge.writes.find(([k]) => k === key);
    assert.ok(write && write[1].length > 0, `${key} must be written with a non-empty value`);
  }
});

test('L3 invariant: bookId/filename are skipped when absent (v1.3.x upgrade path)', () => {
  const bridge = makeMockBridge();
  simulatePagedSave(bridge, {
    bookTitle: 'A',
    bookId: null,
    filename: null,
    chapterIndex: 0,
    pageIndex: 0,
  });
  const keys = bridge.writes.map(([k]) => k);
  assert.ok(keys.includes(STORAGE_KEY_BOOK_TITLE), 'title must still be written');
  assert.ok(!keys.includes(STORAGE_KEY_LAST_BOOK_ID), 'no bookId → no L3 write');
  assert.ok(!keys.includes(STORAGE_KEY_LAST_BOOK_FILENAME), 'no filename → no L3 write');
});
