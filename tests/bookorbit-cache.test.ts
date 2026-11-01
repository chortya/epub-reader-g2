import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOKORBIT_CACHE_KEY,
  cacheStatus,
  cachedBooks,
  loadCacheIndex,
  parseCacheIndex,
  pruneCacheIndex,
  saveCacheIndex,
  upsertCacheEntry,
  type BookOrbitCacheEntry,
} from '../src/bookorbit-cache.ts';

const entry = (over: Partial<BookOrbitCacheEntry> = {}): BookOrbitCacheEntry => ({
  account: 'https://bo/api/v1/koreader|u',
  bookOrbitId: 1,
  fileId: 10,
  localBookId: 'epub-aaa',
  title: 'Alice',
  remoteUpdatedAt: '2026-11-01T10:00:00.000Z',
  sizeBytes: 1000,
  downloadedAt: 1,
  ...over,
});

test('cache status: none, on device, update available, local copy gone', () => {
  const index = [entry()];
  const local = new Set(['epub-aaa']);
  const acct = 'https://bo/api/v1/koreader|u';
  assert.equal(cacheStatus(index, acct, { id: 2, updatedAt: null }, local).kind, 'none');
  assert.equal(cacheStatus(index, acct, { id: 1, updatedAt: '2026-11-01T10:00:00.000Z' }, local).kind, 'onDevice');
  assert.equal(cacheStatus(index, acct, { id: 1, updatedAt: '2026-11-02T08:00:00.000Z' }, local).kind, 'updateAvailable');
  assert.equal(cacheStatus(index, acct, { id: 1, updatedAt: null }, local).kind, 'onDevice');
  assert.equal(cacheStatus(index, acct, { id: 1, updatedAt: null }, new Set()).kind, 'none', 'deleted locally');
  assert.equal(cacheStatus(index, 'other|u', { id: 1, updatedAt: null }, local).kind, 'none', 'other account');
});

test('upsert replaces per account+book; prune drops entries without a local copy', () => {
  let index = upsertCacheEntry([], entry());
  index = upsertCacheEntry(index, entry({ localBookId: 'epub-bbb', downloadedAt: 2 }));
  index = upsertCacheEntry(index, entry({ account: 'other|u', localBookId: 'epub-ccc' }));
  assert.equal(index.length, 2);
  assert.equal(index[1].localBookId, 'epub-bbb');
  assert.deepEqual(pruneCacheIndex(index, new Set(['epub-bbb'])).map((e) => e.localBookId), ['epub-bbb']);
});

test('index round-trips through bridge storage and ignores junk', async () => {
  assert.deepEqual(parseCacheIndex('nope'), []);
  assert.deepEqual(parseCacheIndex(JSON.stringify([{ account: 1 }, entry()])), [entry()]);
  const store = new Map<string, string>();
  const bridge = {
    getLocalStorage: async (k: string) => store.get(k) ?? '',
    setLocalStorage: async (k: string, v: string) => { store.set(k, v); return true; },
  };
  await saveCacheIndex([entry()], bridge);
  assert.ok(store.has(BOOKORBIT_CACHE_KEY));
  assert.deepEqual(await loadCacheIndex(bridge), [entry()]);
  await assert.rejects(saveCacheIndex([entry()], { ...bridge, setLocalStorage: async () => false }));
});

test('cachedBooks: this account, still on the device, newest first, searchable offline', () => {
  const acct = 'https://bo/api/v1/koreader|u';
  const index = [
    entry({ bookOrbitId: 1, localBookId: 'a', title: 'Alice', authors: ['Lewis Carroll'], downloadedAt: 1 }),
    entry({ bookOrbitId: 2, localBookId: 'b', title: 'Dracula', authors: ['Bram Stoker'], downloadedAt: 3 }),
    entry({ bookOrbitId: 3, localBookId: 'gone', title: 'Emma', downloadedAt: 2 }),
    entry({ account: 'other|u', bookOrbitId: 4, localBookId: 'c', title: 'Other' }),
  ];
  const local = new Set(['a', 'b', 'c']);
  assert.deepEqual(cachedBooks(index, acct, local).map((e) => e.title), ['Dracula', 'Alice']);
  assert.deepEqual(cachedBooks(index, acct, local, 'carroll').map((e) => e.title), ['Alice']);
  assert.deepEqual(cachedBooks(index, acct, local, 'DRAC').map((e) => e.title), ['Dracula']);
});
