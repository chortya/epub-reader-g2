import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORAGE_KEY_BOOK_TITLE,
  STORAGE_KEY_LAST_BOOK_ID,
  STORAGE_KEY_LAST_BOOK_FILENAME,
  STORAGE_KEY_POSITION,
  STORAGE_KEY_FLOW_POSITION,
} from '../src/constants.ts';
import {
  writeLastBookKeys,
  savePagedPosition,
  saveFlowPosition,
  type PositionBridge,
} from '../src/position-store.ts';

// These tests guard the revised design §8.5 invariant I1 (Phase 1.4): the
// three L3 "last book" keys are written together exactly when a book is
// opened (the only time the open-book identity changes) — NOT on every
// position save. Page-turn saves write only position keys, debounced by
// createPositionPersister. A refactor that drops one of the L3 writes on
// open, or starts re-writing L3 keys per save, fails here.

function makeBridge(): PositionBridge & { store: Map<string, string>; writes: Array<[string, string]> } {
  const store = new Map<string, string>();
  const writes: Array<[string, string]> = [];
  return {
    store,
    writes,
    async setLocalStorage(key: string, value: string): Promise<boolean> {
      store.set(key, value);
      writes.push([key, value]);
      return true;
    },
    async getLocalStorage(key: string): Promise<string> {
      return store.get(key) ?? '';
    },
  };
}

test('I1: opening a book writes all three L3 keys together', async () => {
  const bridge = makeBridge();
  // Mirrors EvenEpubClient.loadBook's book-open sequence.
  await writeLastBookKeys(bridge, { title: 'Moby Dick', bookId: 'epub-' + 'c'.repeat(64), filename: 'moby.epub' });
  const keys = bridge.writes.map(([k]) => k);
  assert.ok(keys.includes(STORAGE_KEY_BOOK_TITLE), 'expected BOOK_TITLE write');
  assert.ok(keys.includes(STORAGE_KEY_LAST_BOOK_ID), 'expected LAST_BOOK_ID write');
  assert.ok(keys.includes(STORAGE_KEY_LAST_BOOK_FILENAME), 'expected LAST_BOOK_FILENAME write');
});

test('I1: opening a legacy-identified book still writes the title key alone', async () => {
  const bridge = makeBridge();
  await writeLastBookKeys(bridge, { title: 'Old Book', bookId: null, filename: null });
  assert.deepEqual(bridge.writes.map(([k]) => k), [STORAGE_KEY_BOOK_TITLE]);
});

test('I1: position saves (paged + flow) do not write any L3 key', async () => {
  const bridge = makeBridge();
  const paged = { chapterIndex: 1, pageIndex: 2 };
  const flow = { chapterIndex: 1, pageIndex: 2, wordIndex: 4 };
  await savePagedPosition(bridge, { title: 'B', bookId: 'abc-1', filename: 'b.epub' }, paged);
  await saveFlowPosition(bridge, { title: 'B', bookId: 'abc-1', filename: 'b.epub' }, flow, true);

  const l3Writes = bridge.writes.filter(
    ([k]) => k === STORAGE_KEY_BOOK_TITLE || k === STORAGE_KEY_LAST_BOOK_ID || k === STORAGE_KEY_LAST_BOOK_FILENAME,
  );
  assert.deepEqual(l3Writes, [], 'saves must not touch L3 keys');
  // Position keys were still written.
  assert.ok(bridge.store.has(`${STORAGE_KEY_POSITION}-abc-1`));
  assert.ok(bridge.store.has(`${STORAGE_KEY_FLOW_POSITION}-abc-1`));
});

test('I1: a rejected L3 write throws so the caller can surface it', async () => {
  const bridge = makeBridge();
  const failing: PositionBridge = {
    async setLocalStorage() { return false; },
    async getLocalStorage() { return ''; },
  };
  await assert.rejects(() => writeLastBookKeys(failing, { title: 'X', bookId: 'x-1', filename: 'x.epub' }));
  // And a save through the same bridge surfaces the rejection too.
  await assert.rejects(() =>
    savePagedPosition(failing, { title: 'X', bookId: 'x-1' }, { chapterIndex: 0, pageIndex: 0 }),
  );
});
