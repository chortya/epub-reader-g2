export const DB_NAME = 'epub-reader-db';
export const STORE_NAME = 'books';
export const LAST_BOOK_KEY = 'last-book';

interface StoredBook {
    filename: string;
    buffer: ArrayBuffer;
}

function getDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function saveEpubBufferToDB(buffer: ArrayBuffer, filename: string): Promise<void> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const data: StoredBook = { filename, buffer };
        const request = store.put(data, LAST_BOOK_KEY);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

export async function loadSavedEpubBufferFromDB(): Promise<StoredBook | null> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(LAST_BOOK_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}
