export const DB_NAME = 'epub-reader-db';
export const STORE_NAME = 'books';

export interface StoredBook {
    filename: string;
    title: string;
    buffer: ArrayBuffer;
    timestamp: number;
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

export async function saveEpubBufferToDB(buffer: ArrayBuffer, filename: string, title: string): Promise<void> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const data: StoredBook = { filename, title, buffer, timestamp: Date.now() };

        const putRequest = store.put(data);
        putRequest.onsuccess = () => {
            const getAllReq = store.getAll();
            getAllReq.onsuccess = () => {
                const books = getAllReq.result as StoredBook[];
                books.sort((a, b) => b.timestamp - a.timestamp);
                if (books.length > 3) {
                    // Delete oldest
                    for (let i = 3; i < books.length; i++) {
                        store.delete(books[i].filename);
                    }
                }
                resolve();
            };
        };
        putRequest.onerror = () => reject(putRequest.error);
    });
}

export async function getRecentBooksFromDB(): Promise<StoredBook[]> {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => {
            const books = request.result as StoredBook[];
            books.sort((a, b) => b.timestamp - a.timestamp);
            resolve(books.slice(0, 3));
        };
        request.onerror = () => reject(request.error);
    });
}
