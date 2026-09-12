import { makeBookId, makeContentBookId } from './book-id.ts';
import { createSerialExecutor } from './operation-queue.ts';
import { migrateLegacyPositionKeys } from './position-store.ts';

export const DB_NAME = 'epub-reader-db';
export const STORE_NAME = 'books';
const DB_VERSION = 3;
const BRIDGE_BOOKS_KEY = 'epub-recent-books';

export interface StoredBook {
  bookId: string;
  filename: string;
  title: string;
  buffer: ArrayBuffer;
  timestamp: number;
}

interface BridgeLike {
  setLocalStorage(key: string, value: string): Promise<boolean>;
  getLocalStorage(key: string): Promise<string>;
}

export interface SerializedBook {
  bookId: string;
  filename: string;
  title: string;
  base64: string;
  timestamp: number;
}

type LegacySerializedBook = Omit<SerializedBook, 'bookId'> & { bookId?: unknown };
type LegacyStoredBook = Omit<StoredBook, 'bookId'> & { bookId?: unknown };

// Bridge storage is a read-modify-write API. Serialize mutations so two quick
// uploads cannot both read the same old list and make one another disappear.
const runBridgeMutation = createSerialExecutor();

export function upsertBridgeBook(
  entries: SerializedBook[],
  entry: SerializedBook,
): SerializedBook[] {
  return [entry, ...entries.filter((book) => book.bookId !== entry.bookId)]
    .sort((a, b) => b.timestamp - a.timestamp);
}

export function pruneBridgeBooks(entries: SerializedBook[], bookId: string): SerializedBook[] {
  return entries.filter((book) => book.bookId !== bookId);
}

function normalizeSerializedBook(value: LegacySerializedBook): SerializedBook | null {
  if (
    typeof value.filename !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.base64 !== 'string' ||
    typeof value.timestamp !== 'number'
  ) {
    return null;
  }

  return {
    bookId: typeof value.bookId === 'string' && value.bookId
      ? value.bookId
      : makeBookId(value.filename, value.title),
    filename: value.filename,
    title: value.title,
    base64: value.base64,
    timestamp: value.timestamp,
  };
}

function parseBridgeBooks(raw: string): SerializedBook[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => normalizeSerializedBook(entry as LegacySerializedBook))
      .filter((entry): entry is SerializedBook => entry !== null)
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(''));
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function getDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const transaction = request.transaction;
      if (!transaction) return;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'bookId' });
        return;
      }

      const oldStore = transaction.objectStore(STORE_NAME);
      if (oldStore.keyPath === 'bookId') return;

      // v2 keyed books by filename, which made same-named EPUBs overwrite one
      // another. Preserve every surviving entry while migrating to bookId.
      const readRequest = oldStore.getAll();
      readRequest.onsuccess = () => {
        const legacyBooks = readRequest.result as LegacyStoredBook[];
        db.deleteObjectStore(STORE_NAME);
        const nextStore = db.createObjectStore(STORE_NAME, { keyPath: 'bookId' });
        for (const legacy of legacyBooks) {
          nextStore.put({
            ...legacy,
            bookId: typeof legacy.bookId === 'string' && legacy.bookId
              ? legacy.bookId
              : makeBookId(legacy.filename, legacy.title),
          } satisfies StoredBook);
        }
      };
      readRequest.onerror = () => transaction.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Book database upgrade is blocked by another tab.'));
  });
}

/**
 * Insert or replace a book row. Returns the legacy bookId of a row that was
 * replaced (v3-migrated rows keyed by `makeBookId(filename, title)` on the
 * first re-upload), or null when nothing was replaced. The caller uses it to
 * migrate position keys to the new identity.
 */
async function putIndexedDB(book: StoredBook): Promise<string | null> {
  const db = await getDB();
  return new Promise<string | null>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const legacyBookId = makeBookId(book.filename, book.title);
    if (legacyBookId === book.bookId) {
      store.put(book);
    } else {
      // The v3 migration assigns legacy filename/title IDs because the old
      // database did not retain a content hash. On the first exact re-upload,
      // replace that migrated row instead of showing the same book twice.
      const legacyRequest = store.get(legacyBookId);
      legacyRequest.onsuccess = () => {
        const legacy = legacyRequest.result as StoredBook | undefined;
        let replaced: string | null = null;
        if (legacy?.filename === book.filename && legacy.title === book.title) {
          store.delete(legacyBookId);
          replaced = legacyBookId;
        }
        store.put(book);
        transaction.oncomplete = () => resolve(replaced);
      };
      legacyRequest.onerror = () => transaction.abort();
    }
    transaction.oncomplete = () => resolve(null);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function saveEpubBufferToDB(
  buffer: ArrayBuffer,
  filename: string,
  title: string,
  bridge?: BridgeLike,
): Promise<StoredBook> {
  const book: StoredBook = {
    bookId: await makeContentBookId(buffer),
    filename,
    title,
    buffer,
    timestamp: Date.now(),
  };
  let saved = false;
  let replacedLegacyBookId: string | null = null;

  try {
    replacedLegacyBookId = await putIndexedDB(book);
    saved = true;
  } catch (error) {
    console.warn('IndexedDB save failed:', error);
  }

  if (bridge) {
    try {
      await runBridgeMutation(() => saveToBridgeStorage(bridge, book));
      saved = true;
    } catch (error) {
      console.warn('Bridge storage save failed:', error);
    }

    if (replacedLegacyBookId) {
      // The re-keyed row's positions would be orphaned under the legacy ID.
      // Carry them to the content identity (browser lane included when present).
      try {
        const browserStore: Storage | undefined =
          typeof window !== 'undefined' ? window.localStorage : undefined;
        await runBridgeMutation(() =>
          migrateLegacyPositionKeys(bridge, replacedLegacyBookId, book.bookId, browserStore),
        );
      } catch (error) {
        console.warn('Position key migration failed:', error);
      }
    }
  }

  if (!saved) throw new Error('The EPUB could not be saved to local storage.');
  return book;
}

export async function getRecentBooksFromDB(bridge?: BridgeLike): Promise<StoredBook[]> {
  try {
    const db = await getDB();
    const books = await new Promise<StoredBook[]>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as StoredBook[]);
      request.onerror = () => reject(request.error);
    });
    books.sort((a, b) => b.timestamp - a.timestamp);
    if (books.length > 0) return books;
  } catch (error) {
    console.warn('IndexedDB read failed:', error);
  }

  if (bridge) {
    try {
      const bridgeBooks = await loadFromBridgeStorage(bridge);
      if (bridgeBooks.length > 0) {
        backfillIndexedDB(bridgeBooks).catch((error) =>
          console.warn('IndexedDB backfill failed:', error),
        );
        return bridgeBooks;
      }
    } catch (error) {
      console.warn('Bridge storage read failed:', error);
    }
  }

  return [];
}

async function backfillIndexedDB(books: StoredBook[]): Promise<void> {
  const db = await getDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    for (const book of books) store.put(book);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function deleteFromDB(bookId: string, bridge?: BridgeLike): Promise<void> {
  let deleted = false;
  try {
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(bookId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    deleted = true;
  } catch (error) {
    console.warn('IndexedDB delete failed:', error);
  }

  if (bridge) {
    try {
      const bridgeDeleted = await runBridgeMutation(() => removeFromBridgeStorage(bridge, bookId));
      deleted = deleted || bridgeDeleted;
    } catch (error) {
      console.warn('Bridge storage delete failed:', error);
    }
  }

  if (!deleted) throw new Error('The book could not be deleted from local storage.');
}

async function writeBridgeBooks(bridge: BridgeLike, entries: SerializedBook[]): Promise<void> {
  const stored = await bridge.setLocalStorage(BRIDGE_BOOKS_KEY, JSON.stringify(entries));
  if (!stored) throw new Error('Even Hub rejected the book-library write.');
}

async function saveToBridgeStorage(bridge: BridgeLike, book: StoredBook): Promise<void> {
  const legacyBookId = makeBookId(book.filename, book.title);
  const existing = parseBridgeBooks(await bridge.getLocalStorage(BRIDGE_BOOKS_KEY))
    .filter((entry) => !(
      entry.bookId === legacyBookId &&
      legacyBookId !== book.bookId &&
      entry.filename === book.filename &&
      entry.title === book.title
    ));
  const entry: SerializedBook = {
    bookId: book.bookId,
    filename: book.filename,
    title: book.title,
    base64: arrayBufferToBase64(book.buffer),
    timestamp: book.timestamp,
  };
  await writeBridgeBooks(bridge, upsertBridgeBook(existing, entry));
}

async function loadFromBridgeStorage(bridge: BridgeLike): Promise<StoredBook[]> {
  const entries = parseBridgeBooks(await bridge.getLocalStorage(BRIDGE_BOOKS_KEY));
  return entries.map((entry) => ({
    bookId: entry.bookId,
    filename: entry.filename,
    title: entry.title,
    buffer: base64ToArrayBuffer(entry.base64),
    timestamp: entry.timestamp,
  }));
}

async function removeFromBridgeStorage(bridge: BridgeLike, bookId: string): Promise<boolean> {
  const existing = parseBridgeBooks(await bridge.getLocalStorage(BRIDGE_BOOKS_KEY));
  const filtered = pruneBridgeBooks(existing, bookId);
  if (filtered.length === existing.length) return false;
  await writeBridgeBooks(bridge, filtered);
  return true;
}
