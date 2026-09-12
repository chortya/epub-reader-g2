import {
  STORAGE_KEY_BOOK_TITLE,
  STORAGE_KEY_LAST_BOOK_FILENAME,
  STORAGE_KEY_LAST_BOOK_ID,
  STORAGE_KEY_POSITION,
  STORAGE_KEY_FLOW_POSITION,
} from './constants.ts';
import type { ReadingPosition } from './types.ts';
import { isContentBookId } from './book-id.ts';

/**
 * Minimal bridge surface for writing position/L3 keys. Matches the subset of
 * the Even Hub SDK + MockBridge that the reader actually calls.
 */
export interface PositionBridge {
  setLocalStorage(key: string, value: string): Promise<boolean>;
  getLocalStorage(key: string): Promise<string>;
}

/** Identifies a book for the L3 "last book" keys written on every save. */
export interface BookRef {
  title: string;
  bookId?: string | null;
  filename?: string | null;
}

/**
 * Write the three L3 "last book" keys together (design §8.5 invariant I1):
 * title, last-book-id, last-book-filename. Continue Reading resolves by
 * bookId first, then filename+title, so all three must be present after every
 * save. bookId/filename writes are skipped when absent (v1.3.x upgrade path).
 *
 * Pure over the bridge: takes the store to mutate, returns the ordered list of
 * writes performed so a unit test can assert the invariant without re-implementing it.
 */
export async function writeLastBookKeys(
  bridge: PositionBridge,
  ref: BookRef,
): Promise<void> {
  await bridge.setLocalStorage(STORAGE_KEY_BOOK_TITLE, ref.title);
  if (ref.bookId) {
    await bridge.setLocalStorage(STORAGE_KEY_LAST_BOOK_ID, ref.bookId);
  }
  if (ref.filename) {
    await bridge.setLocalStorage(STORAGE_KEY_LAST_BOOK_FILENAME, ref.filename);
  }
}

/** Position keys tried on restore, strongest signal (bookId) first. */
export function pagedPositionKeys(ref: BookRef): string[] {
  const keys: string[] = [];
  if (ref.bookId) keys.push(`${STORAGE_KEY_POSITION}-${ref.bookId}`);
  // Content-addressed books must never inherit a same-titled book's position.
  // The title lane remains read-compatible only for pre-content-ID records.
  if (!isContentBookId(ref.bookId)) keys.push(`${STORAGE_KEY_POSITION}-${ref.title}`);
  return keys;
}

export function flowPositionKeys(ref: BookRef): string[] {
  const keys: string[] = [];
  if (ref.bookId) keys.push(`${STORAGE_KEY_FLOW_POSITION}-${ref.bookId}`);
  if (!isContentBookId(ref.bookId)) keys.push(`${STORAGE_KEY_FLOW_POSITION}-${ref.title}`);
  return keys;
}

/**
 * Persist a paged reading position: the position JSON under both keys, plus the
 * L3 last-book keys. Mirrors to a browser-localStorage fallback when provided
 * so a cold WebView reload can still recover.
 */
export async function savePagedPosition(
  bridge: PositionBridge,
  ref: BookRef,
  pos: ReadingPosition,
  browserFallback?: Storage,
): Promise<void> {
  const json = JSON.stringify(pos);
  if (ref.bookId) {
    await bridge.setLocalStorage(`${STORAGE_KEY_POSITION}-${ref.bookId}`, json);
  }
  await bridge.setLocalStorage(`${STORAGE_KEY_POSITION}-${ref.title}`, json);
  await writeLastBookKeys(bridge, ref);

  if (browserFallback) {
    try {
      browserFallback.setItem(`${STORAGE_KEY_POSITION}-${ref.title}`, json);
      if (ref.bookId) {
        browserFallback.setItem(`${STORAGE_KEY_POSITION}-${ref.bookId}`, json);
      }
    } catch { /* localStorage unavailable */ }
  }
}

/**
 * Persist a flow reading position (includes wordIndex). `persistToBridge`
 * gates the bridge writes (flow ticks skip them mid-page to avoid flooding the
 * bridge) but the browser-localStorage fallback still mirrors every tick when
 * available, because it is local and cheap.
 */
export async function saveFlowPosition(
  bridge: PositionBridge,
  ref: BookRef,
  pos: ReadingPosition,
  persistToBridge: boolean,
  browserFallback?: Storage,
): Promise<void> {
  const json = JSON.stringify(pos);
  if (persistToBridge) {
    if (ref.bookId) {
      await bridge.setLocalStorage(`${STORAGE_KEY_FLOW_POSITION}-${ref.bookId}`, json);
    }
    await bridge.setLocalStorage(`${STORAGE_KEY_FLOW_POSITION}-${ref.title}`, json);
    await writeLastBookKeys(bridge, ref);
  }
  if (browserFallback) {
    try {
      browserFallback.setItem(`${STORAGE_KEY_FLOW_POSITION}-${ref.title}`, json);
      if (ref.bookId) {
        browserFallback.setItem(`${STORAGE_KEY_FLOW_POSITION}-${ref.bookId}`, json);
      }
    } catch { /* localStorage unavailable */ }
  }
}
