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
  savePagedPosition,
  saveFlowPosition,
  pagedPositionKeys,
  flowPositionKeys,
  writeLastBookKeys,
  migrateLegacyPositionKeys,
  type PositionBridge,
} from '../src/position-store.ts';
import type { ReadingPosition } from '../src/types.ts';

/** In-memory bridge that records every setLocalStorage call. */
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

/** Minimal localStorage shim satisfying the Storage interface. */
function makeBrowserStore(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() { return data.size; },
    clear() { data.clear(); },
    getItem(k: string): string | null { return data.get(k) ?? null; },
    setItem(k: string, v: string) { data.set(k, v); },
    removeItem(k: string) { data.delete(k); },
    key(): string | null { return null; },
  };
}

// --- pagedPositionKeys / flowPositionKeys ---

test('pagedPositionKeys: bookId key comes first, title key second', () => {
  const keys = pagedPositionKeys({ title: 'My Book', bookId: 'abc-1' });
  assert.deepEqual(keys, [
    `${STORAGE_KEY_POSITION}-abc-1`,
    `${STORAGE_KEY_POSITION}-My Book`,
  ]);
});

test('pagedPositionKeys: omits bookId key when bookId is absent', () => {
  const keys = pagedPositionKeys({ title: 'My Book', bookId: null });
  assert.deepEqual(keys, [`${STORAGE_KEY_POSITION}-My Book`]);
});

test('pagedPositionKeys: omits bookId key when bookId is undefined', () => {
  const keys = pagedPositionKeys({ title: 'My Book' });
  assert.deepEqual(keys, [`${STORAGE_KEY_POSITION}-My Book`]);
});

test('pagedPositionKeys: content-addressed books never fall back to a colliding title', () => {
  const bookId = `epub-${'a'.repeat(64)}`;
  assert.deepEqual(pagedPositionKeys({ title: 'Shared Title', bookId }), [
    `${STORAGE_KEY_POSITION}-${bookId}`,
  ]);
});

test('flowPositionKeys: bookId key comes first, title key second', () => {
  const keys = flowPositionKeys({ title: 'My Book', bookId: 'abc-1' });
  assert.deepEqual(keys, [
    `${STORAGE_KEY_FLOW_POSITION}-abc-1`,
    `${STORAGE_KEY_FLOW_POSITION}-My Book`,
  ]);
});

test('flowPositionKeys: omits bookId key when bookId is absent', () => {
  const keys = flowPositionKeys({ title: 'My Book', bookId: null });
  assert.deepEqual(keys, [`${STORAGE_KEY_FLOW_POSITION}-My Book`]);
});

test('flowPositionKeys: content-addressed books never fall back to a colliding title', () => {
  const bookId = `epub-${'b'.repeat(64)}`;
  assert.deepEqual(flowPositionKeys({ title: 'Shared Title', bookId }), [
    `${STORAGE_KEY_FLOW_POSITION}-${bookId}`,
  ]);
});

// --- writeLastBookKeys ---

test('writeLastBookKeys: writes all three L3 keys when bookId and filename present', async () => {
  const bridge = makeBridge();
  await writeLastBookKeys(bridge, { title: 'A', bookId: 'abc-1', filename: 'a.epub' });
  const keys = bridge.writes.map(([k]) => k);
  assert.ok(keys.includes(STORAGE_KEY_BOOK_TITLE), 'expected BOOK_TITLE write');
  assert.ok(keys.includes(STORAGE_KEY_LAST_BOOK_ID), 'expected LAST_BOOK_ID write');
  assert.ok(keys.includes(STORAGE_KEY_LAST_BOOK_FILENAME), 'expected LAST_BOOK_FILENAME write');
});

test('writeLastBookKeys: writes only title when bookId/filename absent', async () => {
  const bridge = makeBridge();
  await writeLastBookKeys(bridge, { title: 'A', bookId: null, filename: null });
  const keys = bridge.writes.map(([k]) => k);
  assert.deepEqual(keys, [STORAGE_KEY_BOOK_TITLE]);
});

// --- savePagedPosition ---

test('savePagedPosition: writes position JSON under bookId and title keys + L3 keys', async () => {
  const bridge = makeBridge();
  const pos: ReadingPosition = { chapterIndex: 2, pageIndex: 5 };
  await savePagedPosition(bridge, { title: 'A', bookId: 'abc-1', filename: 'a.epub' }, pos);

  const byBookId = bridge.store.get(`${STORAGE_KEY_POSITION}-abc-1`);
  const byTitle = bridge.store.get(`${STORAGE_KEY_POSITION}-A`);
  assert.equal(byBookId, JSON.stringify(pos));
  assert.equal(byTitle, JSON.stringify(pos));

  // L3 invariant: all three last-book keys present
  assert.equal(bridge.store.get(STORAGE_KEY_BOOK_TITLE), 'A');
  assert.equal(bridge.store.get(STORAGE_KEY_LAST_BOOK_ID), 'abc-1');
  assert.equal(bridge.store.get(STORAGE_KEY_LAST_BOOK_FILENAME), 'a.epub');
});

test('savePagedPosition: skips bookId key when bookId absent', async () => {
  const bridge = makeBridge();
  const pos: ReadingPosition = { chapterIndex: 0, pageIndex: 0 };
  await savePagedPosition(bridge, { title: 'A', bookId: null }, pos);

  assert.ok(bridge.store.has(`${STORAGE_KEY_POSITION}-A`));
  assert.ok(!bridge.store.has(`${STORAGE_KEY_POSITION}-null`));
  assert.ok(!bridge.store.has(`${STORAGE_KEY_POSITION}-undefined`));
});

test('savePagedPosition: mirrors to browser fallback when provided', async () => {
  const bridge = makeBridge();
  const browser = makeBrowserStore();
  const pos: ReadingPosition = { chapterIndex: 1, pageIndex: 3 };
  await savePagedPosition(bridge, { title: 'A', bookId: 'abc-1' }, pos, browser);

  assert.equal(browser.data.get(`${STORAGE_KEY_POSITION}-A`), JSON.stringify(pos));
  assert.equal(browser.data.get(`${STORAGE_KEY_POSITION}-abc-1`), JSON.stringify(pos));
});

test('savePagedPosition: works without browser fallback', async () => {
  const bridge = makeBridge();
  const pos: ReadingPosition = { chapterIndex: 0, pageIndex: 0 };
  await savePagedPosition(bridge, { title: 'A', bookId: 'abc-1' }, pos);
  // No throw, position written to bridge
  assert.ok(bridge.store.has(`${STORAGE_KEY_POSITION}-A`));
});

// --- saveFlowPosition ---

test('saveFlowPosition: writes flow position JSON with wordIndex when persistToBridge=true', async () => {
  const bridge = makeBridge();
  const pos: ReadingPosition = { chapterIndex: 0, pageIndex: 0, wordIndex: 42 };
  await saveFlowPosition(bridge, { title: 'B', bookId: 'def-2', filename: 'b.epub' }, pos, true);

  const byBookId = bridge.store.get(`${STORAGE_KEY_FLOW_POSITION}-def-2`);
  const byTitle = bridge.store.get(`${STORAGE_KEY_FLOW_POSITION}-B`);
  assert.equal(byBookId, JSON.stringify(pos));
  assert.equal(byTitle, JSON.stringify(pos));

  // L3 keys written when persistToBridge is true
  assert.equal(bridge.store.get(STORAGE_KEY_BOOK_TITLE), 'B');
  assert.equal(bridge.store.get(STORAGE_KEY_LAST_BOOK_ID), 'def-2');
  assert.equal(bridge.store.get(STORAGE_KEY_LAST_BOOK_FILENAME), 'b.epub');
});

test('saveFlowPosition: skips bridge writes when persistToBridge=false (mid-tick)', async () => {
  const bridge = makeBridge();
  const pos: ReadingPosition = { chapterIndex: 0, pageIndex: 0, wordIndex: 5 };
  await saveFlowPosition(bridge, { title: 'B', bookId: 'def-2', filename: 'b.epub' }, pos, false);

  // No flow position keys on the bridge
  assert.ok(!bridge.store.has(`${STORAGE_KEY_FLOW_POSITION}-B`));
  assert.ok(!bridge.store.has(`${STORAGE_KEY_FLOW_POSITION}-def-2`));
  // No L3 keys either
  assert.ok(!bridge.store.has(STORAGE_KEY_BOOK_TITLE));
});

test('saveFlowPosition: still mirrors to browser fallback when persistToBridge=false', async () => {
  const bridge = makeBridge();
  const browser = makeBrowserStore();
  const pos: ReadingPosition = { chapterIndex: 0, pageIndex: 0, wordIndex: 5 };
  await saveFlowPosition(bridge, { title: 'B', bookId: 'def-2' }, pos, false, browser);

  // Bridge untouched
  assert.equal(bridge.writes.length, 0);
  // Browser fallback has the data
  assert.equal(browser.data.get(`${STORAGE_KEY_FLOW_POSITION}-B`), JSON.stringify(pos));
  assert.equal(browser.data.get(`${STORAGE_KEY_FLOW_POSITION}-def-2`), JSON.stringify(pos));
});

test('saveFlowPosition: skips bookId key when bookId absent', async () => {
  const bridge = makeBridge();
  const pos: ReadingPosition = { chapterIndex: 0, pageIndex: 0, wordIndex: 0 };
  await saveFlowPosition(bridge, { title: 'B', bookId: null }, pos, true);

  assert.ok(bridge.store.has(`${STORAGE_KEY_FLOW_POSITION}-B`));
  assert.ok(!bridge.store.has(`${STORAGE_KEY_FLOW_POSITION}-null`));
});

test('migrateLegacyPositionKeys: copies paged and flow positions to the content identity', async () => {
  const bridge = makeBridge();
  const paged = JSON.stringify({ chapterIndex: 2, pageIndex: 4 });
  const flow = JSON.stringify({ chapterIndex: 2, pageIndex: 4, wordIndex: 7 });
  bridge.store.set(`${STORAGE_KEY_POSITION}-legacy-1`, paged);
  bridge.store.set(`${STORAGE_KEY_FLOW_POSITION}-legacy-1`, flow);

  await migrateLegacyPositionKeys(bridge, 'legacy-1', 'epub-abc');

  assert.equal(bridge.store.get(`${STORAGE_KEY_POSITION}-epub-abc`), paged);
  assert.equal(bridge.store.get(`${STORAGE_KEY_FLOW_POSITION}-epub-abc`), flow);
  // Legacy keys remain (rollback safety for 1.4.6)
  assert.equal(bridge.store.get(`${STORAGE_KEY_POSITION}-legacy-1`), paged);
});

test('migrateLegacyPositionKeys: keeps an existing content-identity position', async () => {
  const bridge = makeBridge();
  const newer = JSON.stringify({ chapterIndex: 9, pageIndex: 0 });
  bridge.store.set(`${STORAGE_KEY_POSITION}-legacy-1`, JSON.stringify({ chapterIndex: 0, pageIndex: 0 }));
  bridge.store.set(`${STORAGE_KEY_POSITION}-epub-abc`, newer);

  await migrateLegacyPositionKeys(bridge, 'legacy-1', 'epub-abc');

  assert.equal(bridge.store.get(`${STORAGE_KEY_POSITION}-epub-abc`), newer);
});

test('migrateLegacyPositionKeys: skips empty sources and tolerates a throwing bridge', async () => {
  const bridge = makeBridge();
  bridge.store.set(`${STORAGE_KEY_POSITION}-legacy-1`, JSON.stringify({ chapterIndex: 1, pageIndex: 1 }));
  let calls = 0;
  const flaky: PositionBridge = {
    async setLocalStorage(key: string, value: string) {
      calls += 1;
      if (calls === 1) throw new Error('bridge busy');
      bridge.store.set(key, value);
      return true;
    },
    async getLocalStorage(key: string) {
      return bridge.store.get(key) ?? '';
    },
  };

  // No flow key on source — only the paged pair is considered; first write throws
  await migrateLegacyPositionKeys(flaky, 'legacy-1', 'epub-abc');
  assert.ok(!bridge.store.has(`${STORAGE_KEY_POSITION}-epub-abc`));

  // Second attempt succeeds
  await migrateLegacyPositionKeys(flaky, 'legacy-1', 'epub-abc');
  assert.ok(bridge.store.has(`${STORAGE_KEY_POSITION}-epub-abc`));

  // Unknown source id: no writes at all
  const before = bridge.writes.length;
  await migrateLegacyPositionKeys(bridge, 'missing-id', 'epub-xyz');
  assert.equal(bridge.writes.length, before);
});

test('migrateLegacyPositionKeys: mirrors to the browser fallback lane', async () => {
  const bridge = makeBridge();
  const browser = makeBrowserStore();
  const paged = JSON.stringify({ chapterIndex: 3, pageIndex: 2 });
  bridge.store.set(`${STORAGE_KEY_POSITION}-legacy-1`, paged);
  browser.data.set(`${STORAGE_KEY_POSITION}-legacy-1`, paged);

  await migrateLegacyPositionKeys(bridge, 'legacy-1', 'epub-abc', browser);

  assert.equal(browser.data.get(`${STORAGE_KEY_POSITION}-epub-abc`), paged);
});

test('savePagedPosition: content-ID books skip the title lane on bridge and browser', async () => {
  const bridge = makeBridge();
  const browser = makeBrowserStore();
  const pos: ReadingPosition = { chapterIndex: 1, pageIndex: 2 };
  const contentId = 'epub-' + 'a'.repeat(64);
  await savePagedPosition(bridge, { title: 'Same', bookId: contentId, filename: 'x.epub' }, pos, browser);

  assert.ok(bridge.store.has(`${STORAGE_KEY_POSITION}-${contentId}`));
  assert.ok(!bridge.store.has(`${STORAGE_KEY_POSITION}-Same`));
  assert.ok(browser.data.has(`${STORAGE_KEY_POSITION}-${contentId}`));
  assert.ok(!browser.data.has(`${STORAGE_KEY_POSITION}-Same`));
  // L3 keys still written
  assert.equal(bridge.store.get(STORAGE_KEY_BOOK_TITLE), 'Same');
});

test('saveFlowPosition: content-ID books skip the title lane', async () => {
  const bridge = makeBridge();
  const pos: ReadingPosition = { chapterIndex: 0, pageIndex: 0, wordIndex: 3 };
  const contentId = 'epub-' + 'b'.repeat(64);
  await saveFlowPosition(bridge, { title: 'Same', bookId: contentId }, pos, true);

  assert.ok(bridge.store.has(`${STORAGE_KEY_FLOW_POSITION}-${contentId}`));
  assert.ok(!bridge.store.has(`${STORAGE_KEY_FLOW_POSITION}-Same`));
});
