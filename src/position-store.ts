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

/** One bridge write that treats `false` as the failure it is. */
async function writeKey(bridge: PositionBridge, key: string, value: string): Promise<void> {
  const ok = await bridge.setLocalStorage(key, value);
  if (!ok) throw new Error(`bridge rejected write: ${key}`);
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
  await writeKey(bridge, STORAGE_KEY_BOOK_TITLE, ref.title);
  if (ref.bookId) {
    await writeKey(bridge, STORAGE_KEY_LAST_BOOK_ID, ref.bookId);
  }
  if (ref.filename) {
    await writeKey(bridge, STORAGE_KEY_LAST_BOOK_FILENAME, ref.filename);
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
 * Copy saved positions from a legacy book identity (pre-content-ID
 * `makeBookId(filename, title)` shape) to a content identity after the
 * library re-keys the book (db.ts replaces the migrated row on re-upload).
 *
 * The target key wins when it already holds a position: a content-ID position
 * can only exist if the same bytes were opened under the new identity, which
 * is always the more recent session. Corrupt source JSON is copied verbatim —
 * the restore path validates it.
 */
export async function migrateLegacyPositionKeys(
  bridge: PositionBridge,
  fromBookId: string,
  toBookId: string,
  browserFallback?: Storage,
): Promise<void> {
  const pairs: Array<[string, string]> = [
    [`${STORAGE_KEY_POSITION}-${fromBookId}`, `${STORAGE_KEY_POSITION}-${toBookId}`],
    [`${STORAGE_KEY_FLOW_POSITION}-${fromBookId}`, `${STORAGE_KEY_FLOW_POSITION}-${toBookId}`],
  ];
  for (const [fromKey, toKey] of pairs) {
    let source = '';
    try {
      source = await bridge.getLocalStorage(fromKey);
    } catch {
      continue;
    }
    if (!source) continue;
    let target = '';
    try {
      target = await bridge.getLocalStorage(toKey);
    } catch {
      target = '';
    }
    if (target) continue;
    try {
      await bridge.setLocalStorage(toKey, source);
    } catch { /* keep going; the legacy key remains readable */ }

    if (browserFallback) {
      try {
        if (!browserFallback.getItem(toKey) && browserFallback.getItem(fromKey)) {
          browserFallback.setItem(toKey, browserFallback.getItem(fromKey)!);
        }
      } catch { /* localStorage unavailable */ }
    }
  }
}

/**
 * Persist a paged reading position. The title lane is only written for legacy
 * (non-content) identities: the read path skips it for content IDs (same-titled
 * books must never inherit one another's position), so writing it would be
 * waste plus cross-book pollution. 1.4.6 rollback stays safe either way — it
 * restores from the bookId key.
 *
 * L3 "last book" keys are NOT written here; they only change when the open
 * book changes, so the client writes them once per book open (`writeLastBookKeys`).
 */
export async function savePagedPosition(
  bridge: PositionBridge,
  ref: BookRef,
  pos: ReadingPosition,
  browserFallback?: Storage,
): Promise<void> {
  const json = JSON.stringify(pos);
  const titleLane = !isContentBookId(ref.bookId);
  if (ref.bookId) {
    await writeKey(bridge, `${STORAGE_KEY_POSITION}-${ref.bookId}`, json);
  }
  if (titleLane) {
    await writeKey(bridge, `${STORAGE_KEY_POSITION}-${ref.title}`, json);
  }

  if (browserFallback) {
    try {
      if (titleLane) {
        browserFallback.setItem(`${STORAGE_KEY_POSITION}-${ref.title}`, json);
      }
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
 * available, because it is local and cheap. L3 keys are not written here
 * (see savePagedPosition).
 */
export async function saveFlowPosition(
  bridge: PositionBridge,
  ref: BookRef,
  pos: ReadingPosition,
  persistToBridge: boolean,
  browserFallback?: Storage,
): Promise<void> {
  const json = JSON.stringify(pos);
  const titleLane = !isContentBookId(ref.bookId);
  if (persistToBridge) {
    if (ref.bookId) {
      await writeKey(bridge, `${STORAGE_KEY_FLOW_POSITION}-${ref.bookId}`, json);
    }
    if (titleLane) {
      await writeKey(bridge, `${STORAGE_KEY_FLOW_POSITION}-${ref.title}`, json);
    }
  }
  if (browserFallback) {
    try {
      if (titleLane) {
        browserFallback.setItem(`${STORAGE_KEY_FLOW_POSITION}-${ref.title}`, json);
      }
      if (ref.bookId) {
        browserFallback.setItem(`${STORAGE_KEY_FLOW_POSITION}-${ref.bookId}`, json);
      }
    } catch { /* localStorage unavailable */ }
  }
}

/**
 * Debounced position persister. Page turns and flow ticks schedule a save;
 * a trailing timer lands the latest snapshot after `delayMs` of quiet.
 * Lifecycle exits pass `{ immediate: true }` to land the position right away,
 * and `flush()` lands any pending snapshot before the open book changes so a
 * stale position can never be written under a new book's ref.
 *
 * Each scheduled save snapshots the ref alongside the position: a flush that
 * happens after a book switch still writes under the ref the position came
 * from (latest-wins per snapshot, never cross-book).
 */
export interface PositionPersister {
  /** Point subsequent debounced saves at this book identity. */
  setRef(ref: BookRef): void;
  savePaged(pos: ReadingPosition, opts?: { immediate?: boolean }): void;
  saveFlow(pos: ReadingPosition, persistToBridge: boolean, opts?: { immediate?: boolean }): void;
  /** Land any pending snapshot now (no-op when nothing is pending). */
  flush(): Promise<void>;
  hasPending(): boolean;
}

export function createPositionPersister(
  bridge: PositionBridge,
  opts: {
    delayMs: number;
    browserFallback?: Storage;
    onError?: (error: unknown) => void;
  },
): PositionPersister {
  let ref: BookRef = { title: '' };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending:
    | { kind: 'paged'; pos: ReadingPosition; ref: BookRef }
    | { kind: 'flow'; pos: ReadingPosition; persistToBridge: boolean; ref: BookRef }
    | null = null;

  const report = (error: unknown): void => {
    if (opts.onError) opts.onError(error);
    else console.warn('Position save failed:', error);
  };

  const run = async (): Promise<void> => {
    const snapshot = pending;
    pending = null;
    if (!snapshot) return;
    try {
      if (snapshot.kind === 'paged') {
        await savePagedPosition(bridge, snapshot.ref, snapshot.pos, opts.browserFallback);
      } else {
        await saveFlowPosition(bridge, snapshot.ref, snapshot.pos, snapshot.persistToBridge, opts.browserFallback);
      }
    } catch (error) {
      // A failed debounced write must not kill the timer chain.
      report(error);
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, opts.delayMs);
  };

  return {
    setRef(next: BookRef): void {
      ref = next;
    },
    savePaged(pos, writeOpts): void {
      pending = { kind: 'paged', pos, ref };
      if (writeOpts?.immediate) {
        if (timer) { clearTimeout(timer); timer = null; }
        void run();
      } else {
        schedule();
      }
    },
    saveFlow(pos, persistToBridge, writeOpts): void {
      pending = { kind: 'flow', pos, persistToBridge, ref };
      if (writeOpts?.immediate) {
        if (timer) { clearTimeout(timer); timer = null; }
        void run();
      } else {
        schedule();
      }
    },
    async flush(): Promise<void> {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!pending) return;
      const snapshot = pending;
      pending = null;
      try {
        if (snapshot.kind === 'paged') {
          await savePagedPosition(bridge, snapshot.ref, snapshot.pos, opts.browserFallback);
        } else {
          await saveFlowPosition(bridge, snapshot.ref, snapshot.pos, snapshot.persistToBridge, opts.browserFallback);
        }
      } catch (error) {
        report(error);
      }
    },
    hasPending(): boolean {
      return pending !== null;
    },
  };
}

/**
 * Read a saved position by trying each candidate key in order (bridge first,
 * then the browser fallback lane). Returns the first record that parses to a
 * sane {chapterIndex, pageIndex} — callers apply their own clamp/bounds logic.
 */
export async function readPositionFromKeys(
  bridge: PositionBridge,
  keys: string[],
  browserFallback?: Storage,
): Promise<ReadingPosition | null> {
  for (const key of keys) {
    let raw = '';
    try {
      raw = await bridge.getLocalStorage(key);
    } catch { /* fall through to the next lane */ }
    if (!raw && browserFallback) {
      try {
        raw = browserFallback.getItem(key) || '';
      } catch { /* localStorage unavailable */ }
    }
    if (!raw) continue;
    try {
      const pos = JSON.parse(raw) as ReadingPosition;
      if (
        Number.isInteger(pos.chapterIndex) &&
        Number.isInteger(pos.pageIndex) &&
        pos.chapterIndex >= 0 &&
        pos.pageIndex >= 0
      ) {
        return pos;
      }
    } catch { /* corrupt record — try the next key */ }
  }
  return null;
}
