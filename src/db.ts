export const DB_NAME = 'epub-reader-db';
export const STORE_NAME = 'books';
const BRIDGE_BOOKS_KEY = 'epub-recent-books';
const MAX_BOOKS = 3;

export interface StoredBook {
    filename: string;
    title: string;
    buffer: ArrayBuffer;
    timestamp: number;
}

interface BridgeLike {
    setLocalStorage(key: string, value: string): Promise<boolean>;
    getLocalStorage(key: string): Promise<string>;
}

interface SerializedBook {
    filename: string;
    title: string;
    base64: string;
    timestamp: number;
}

export function pruneBridgeBooks(entries: SerializedBook[], filename: string): SerializedBook[] {
    return entries.filter((book) => book.filename !== filename);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    const chunks: string[] = [];
    for (let i = 0; i < bytes.length; i += 8192) {
        chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
    }
    return btoa(chunks.join(''));
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

function getDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 2); // Upgrade DB version to 2
        request.onupgradeneeded = () => {
            const db = request.result;
            // Clear old store if exists to change keyPath
            if (db.objectStoreNames.contains(STORE_NAME)) {
                db.deleteObjectStore(STORE_NAME);
            }
            db.createObjectStore(STORE_NAME, { keyPath: 'filename' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function saveEpubBufferToDB(buffer: ArrayBuffer, filename: string, title: string, bridge?: BridgeLike): Promise<void> {
    // Save to IndexedDB (fast cache)
    try {
        const db = await getDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const data: StoredBook = { filename, title, buffer, timestamp: Date.now() };

            const putRequest = store.put(data);
            putRequest.onsuccess = () => {
                const getAllReq = store.getAll();
                getAllReq.onsuccess = () => {
                    const books = getAllReq.result as StoredBook[];
                    books.sort((a, b) => b.timestamp - a.timestamp);
                    if (books.length > MAX_BOOKS) {
                        for (let i = MAX_BOOKS; i < books.length; i++) {
                            store.delete(books[i].filename);
                        }
                    }
                    resolve();
                };
            };
            putRequest.onerror = () => reject(putRequest.error);
        });
    } catch (e) {
        console.warn('IndexedDB save failed:', e);
    }

    // Save to bridge storage in background (persistent across app restarts)
    if (bridge) {
        saveToBridgeStorage(bridge, { filename, title, buffer, timestamp: Date.now() })
            .catch(e => console.warn('Bridge storage save failed:', e));
    }
}

export async function getRecentBooksFromDB(bridge?: BridgeLike): Promise<StoredBook[]> {
    // Try IndexedDB first (fast)
    try {
        const db = await getDB();
        const books = await new Promise<StoredBook[]>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.getAll();
            request.onsuccess = () => {
                const result = request.result as StoredBook[];
                result.sort((a, b) => b.timestamp - a.timestamp);
                resolve(result.slice(0, MAX_BOOKS));
            };
            request.onerror = () => reject(request.error);
        });
        if (books.length > 0) return books;
    } catch (e) {
        console.warn('IndexedDB read failed:', e);
    }

    // Fall back to bridge storage
    if (bridge) {
        try {
            return await loadFromBridgeStorage(bridge);
        } catch (e) {
            console.warn('Bridge storage read failed:', e);
        }
    }

  return [];
}

export async function deleteFromDB(filename: string, bridge?: BridgeLike): Promise<void> {
    try {
        const db = await getDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.delete(filename);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.warn('IndexedDB delete failed:', e);
    }

    if (bridge) {
        removeFromBridgeStorage(bridge, filename)
            .catch(e => console.warn('Bridge storage delete failed:', e));
    }
}

async function saveToBridgeStorage(bridge: BridgeLike, book: StoredBook): Promise<void> {
    let existing: SerializedBook[] = [];
    try {
        const raw = await bridge.getLocalStorage(BRIDGE_BOOKS_KEY);
        if (raw) existing = JSON.parse(raw);
    } catch { /* empty */ }

    const entry: SerializedBook = {
        filename: book.filename,
        title: book.title,
        base64: arrayBufferToBase64(book.buffer),
        timestamp: book.timestamp,
    };

    // Replace existing entry with same filename or add new
    const idx = existing.findIndex(b => b.filename === book.filename);
    if (idx >= 0) {
        existing[idx] = entry;
    } else {
        existing.unshift(entry);
    }

    existing.sort((a, b) => b.timestamp - a.timestamp);
    if (existing.length > MAX_BOOKS) existing = existing.slice(0, MAX_BOOKS);

    await bridge.setLocalStorage(BRIDGE_BOOKS_KEY, JSON.stringify(existing));
}

async function loadFromBridgeStorage(bridge: BridgeLike): Promise<StoredBook[]> {
    const raw = await bridge.getLocalStorage(BRIDGE_BOOKS_KEY);
    if (!raw) return [];

    const entries: SerializedBook[] = JSON.parse(raw);
    return entries.map(e => ({
        filename: e.filename,
        title: e.title,
        buffer: base64ToArrayBuffer(e.base64),
        timestamp: e.timestamp,
    }));
}

async function removeFromBridgeStorage(bridge: BridgeLike, filename: string): Promise<void> {
    let existing: SerializedBook[] = [];
    try {
        const raw = await bridge.getLocalStorage(BRIDGE_BOOKS_KEY);
        if (raw) existing = JSON.parse(raw);
    } catch {
        return;
    }

    const filtered = pruneBridgeBooks(existing, filename);
    if (filtered.length === existing.length) return;

    await bridge.setLocalStorage(BRIDGE_BOOKS_KEY, JSON.stringify(filtered));
}
