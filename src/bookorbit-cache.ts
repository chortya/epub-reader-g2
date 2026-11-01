/**
 * Which BookOrbit books are downloaded into the local library.
 *
 * The book bytes themselves live in the reader's normal library (IndexedDB +
 * the bridge-storage copy that survives device restarts, see db.ts). This
 * index only links a BookOrbit book to its local copy, so the BookOrbit list
 * can show "On device", open the local copy without the network, and offer
 * an update when the book changed in BookOrbit. Entries are scoped to the
 * account (server + username).
 */

export const BOOKORBIT_CACHE_KEY = 'epub-bookorbit-cache';

export type BookOrbitCacheEntry = {
  account: string;
  bookOrbitId: number;
  fileId: number;
  /** Local library id (content SHA-256), see makeContentBookId. */
  localBookId: string;
  title: string;
  /** BookOrbit's updatedAt when downloaded; a newer one means "update available". */
  remoteUpdatedAt: string | null;
  sizeBytes: number;
  downloadedAt: number;
};

export type CacheStatus =
  | { kind: 'none' }
  | { kind: 'onDevice'; entry: BookOrbitCacheEntry }
  | { kind: 'updateAvailable'; entry: BookOrbitCacheEntry };

type StorageLike = {
  getLocalStorage(key: string): Promise<string | null | undefined>;
  setLocalStorage(key: string, value: string): Promise<boolean | void>;
};

export function parseCacheIndex(raw: string | null | undefined): BookOrbitCacheEntry[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((e): e is BookOrbitCacheEntry =>
      e && typeof e.account === 'string' && typeof e.bookOrbitId === 'number'
      && typeof e.fileId === 'number' && typeof e.localBookId === 'string'
      && typeof e.title === 'string' && typeof e.sizeBytes === 'number' && typeof e.downloadedAt === 'number'
      && (e.remoteUpdatedAt === null || typeof e.remoteUpdatedAt === 'string'));
  } catch {
    return [];
  }
}

export function upsertCacheEntry(entries: BookOrbitCacheEntry[], entry: BookOrbitCacheEntry): BookOrbitCacheEntry[] {
  return [
    entry,
    ...entries.filter((e) => !(e.account === entry.account && e.bookOrbitId === entry.bookOrbitId)),
  ];
}

/** Drop entries whose local copy is gone (deleted from the library or lost). */
export function pruneCacheIndex(entries: BookOrbitCacheEntry[], localBookIds: Set<string>): BookOrbitCacheEntry[] {
  return entries.filter((e) => localBookIds.has(e.localBookId));
}

export function cacheStatus(
  entries: BookOrbitCacheEntry[],
  account: string,
  book: { id: number; updatedAt: string | null },
  localBookIds: Set<string>,
): CacheStatus {
  const entry = entries.find((e) => e.account === account && e.bookOrbitId === book.id);
  if (!entry || !localBookIds.has(entry.localBookId)) return { kind: 'none' };
  const remote = book.updatedAt ? Date.parse(book.updatedAt) : NaN;
  const local = entry.remoteUpdatedAt ? Date.parse(entry.remoteUpdatedAt) : NaN;
  if (Number.isFinite(remote) && Number.isFinite(local) && remote > local) return { kind: 'updateAvailable', entry };
  return { kind: 'onDevice', entry };
}

/** Bridge storage first (survives device restarts), browser storage as fallback. */
export async function loadCacheIndex(bridge: StorageLike | null, browser?: Storage): Promise<BookOrbitCacheEntry[]> {
  if (bridge) {
    try {
      const raw = await bridge.getLocalStorage(BOOKORBIT_CACHE_KEY);
      if (raw) return parseCacheIndex(raw);
    } catch { /* fall through */ }
  }
  return parseCacheIndex(browser?.getItem(BOOKORBIT_CACHE_KEY));
}

export async function saveCacheIndex(entries: BookOrbitCacheEntry[], bridge: StorageLike | null, browser?: Storage): Promise<void> {
  const raw = JSON.stringify(entries);
  browser?.setItem(BOOKORBIT_CACHE_KEY, raw);
  if (bridge) {
    const ok = await bridge.setLocalStorage(BOOKORBIT_CACHE_KEY, raw);
    if (ok === false) throw new Error('Could not save the BookOrbit download list');
  }
}
