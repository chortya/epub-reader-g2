/**
 * BookOrbit integration (https://github.com/bookorbit/bookorbit).
 *
 * BookOrbit serves kosync under <origin>/api/v1/koreader (so KosyncClient and
 * KosyncSession handle progress unchanged) and, with the same KOReader
 * credentials, the routes its KOReader plugin uses:
 *   GET  plugin/catalog/books?q&page&size&sort&format   library page
 *   GET  plugin/catalog/books/:id                        detail incl. files
 *   GET  plugin/catalog/files/:fileId/download           the file's bytes
 *   POST plugin/match-check                              KOReader hash -> book id
 *   POST plugin/page-stats                               reading-time events
 *   PUT  plugin/catalog/books/:id/read-status            e.g. "read"
 * Checked against BookOrbit 3.3.0. These are the plugin's routes, not a
 * documented public API, so every call degrades to an error message rather
 * than breaking reading.
 */

import { KosyncClient, KosyncError } from './kosync.ts';

export type BookOrbitBook = {
  id: number;
  title: string;
  authors: string[];
  seriesName: string | null;
  /** 0-100, BookOrbit's scale. */
  progressPercentage: number | null;
  readStatus: string | null;
  formats: string[];
  lastReadAt: string | null;
  /** Changes when the book (file or metadata) changes in BookOrbit. */
  updatedAt: string | null;
};

export type BookOrbitBookPage = {
  items: BookOrbitBook[];
  total: number;
  page: number;
  hasNext: boolean;
};

export type BookOrbitFile = {
  id: number;
  format: string;
  role: string;
  downloadVariant: string;
  sizeBytes: number | null;
};

export type BookOrbitSort = 'title' | 'author' | 'recently_added' | 'recently_read';

export type PageStatEvent = {
  /** 1-based page in the whole book (current layout). */
  page: number;
  /** Unix seconds when the page was shown. */
  startTime: number;
  durationSeconds: number;
  totalPages: number;
};

export type DeviceInfo = { deviceId: string; deviceModel: string; pluginVersion: string };

const JSON_ACCEPT = 'application/json';

export class BookOrbitClient extends KosyncClient {
  async listBooks(query: { q?: string; page?: number; size?: number; sort?: BookOrbitSort } = {}): Promise<BookOrbitBookPage> {
    const params = new URLSearchParams({
      format: 'epub',
      page: String(query.page ?? 1),
      size: String(query.size ?? 20),
      sort: query.sort ?? 'recently_read',
    });
    if (query.q?.trim()) params.set('q', query.q.trim());
    const body = await this.getJson(`/plugin/catalog/books?${params}`, 'Listing your library failed');
    const items = Array.isArray(body?.items) ? body.items : [];
    return {
      items: items.map(toBook).filter((b: BookOrbitBook | null): b is BookOrbitBook => b !== null),
      total: Number(body?.total) || 0,
      page: Number(body?.page) || 1,
      hasNext: body?.hasNext === true,
    };
  }

  /** The book's EPUB file to download (primary original first), or null. */
  async epubFile(bookId: number): Promise<BookOrbitFile | null> {
    const body = await this.getJson(`/plugin/catalog/books/${bookId}`, 'Loading the book failed');
    const files: BookOrbitFile[] = (Array.isArray(body?.files) ? body.files : [])
      .filter((f: any) => f && typeof f.id === 'number' && String(f.format).toLowerCase() === 'epub')
      .map((f: any) => ({
        id: f.id,
        format: 'epub',
        role: String(f.role ?? ''),
        downloadVariant: String(f.downloadVariant ?? 'original'),
        sizeBytes: typeof f.sizeBytes === 'number' ? f.sizeBytes : null,
      }));
    const rank = (f: BookOrbitFile) => (f.role === 'primary' ? 0 : 2) + (f.downloadVariant === 'original' ? 0 : 1);
    return files.sort((a, b) => rank(a) - rank(b))[0] ?? null;
  }

  /**
   * Download a file unchanged, so KOReader's partial MD5 matches the library
   * copy. Streams with a stall timeout (not a total one: big books on a slow
   * link are fine as long as bytes keep coming), checks the result is a
   * complete ZIP/EPUB, and retries once on a network failure or stall.
   */
  async download(
    fileId: number,
    opts: { expectedBytes?: number | null; onProgress?: (received: number, total: number | null) => void; stallMs?: number } = {},
  ): Promise<ArrayBuffer> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.downloadOnce(fileId, opts);
      } catch (e) {
        lastError = e;
        // HTTP errors (auth, missing file) won't get better on retry.
        if (e instanceof KosyncError && e.status !== null) throw e;
      }
    }
    throw lastError;
  }

  private async downloadOnce(
    fileId: number,
    opts: { expectedBytes?: number | null; onProgress?: (received: number, total: number | null) => void; stallMs?: number },
  ): Promise<ArrayBuffer> {
    const res = await this.request('GET', `/plugin/catalog/files/${fileId}/download`, {
      accept: 'application/epub+zip, application/octet-stream',
      timeoutMs: opts.stallMs ?? DOWNLOAD_STALL_MS,
    });
    if (!res.ok) {
      // Don't wait on an error body (it isn't covered by the stall timer).
      res.body?.cancel().catch(() => {});
      const reason = res.status === 401 || res.status === 403 ? 'BookOrbit rejected the login'
        : res.status === 404 ? 'File not found in BookOrbit' : `Download failed (HTTP ${res.status})`;
      throw new KosyncError(reason, res.status);
    }
    const header = Number(res.headers.get('content-length') ?? '');
    const total = Number.isFinite(header) && header > 0 ? header : (opts.expectedBytes ?? null);
    if (total !== null && total > MAX_DOWNLOAD_BYTES) {
      res.body?.cancel().catch(() => {});
      throw new KosyncError(`Book is too large (${Math.round(total / 1048576)} MB)`, res.status);
    }
    const bytes = await readWithStallTimeout(res, opts.stallMs ?? DOWNLOAD_STALL_MS, total, (n) => opts.onProgress?.(n, total));
    if (total !== null && bytes.byteLength !== total) {
      throw new KosyncError(`Download incomplete (${bytes.byteLength} of ${total} bytes)`, null);
    }
    if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
      throw new KosyncError('Downloaded file is not an EPUB', null);
    }
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }

  /** BookOrbit book ids for KOReader document hashes it recognises. */
  async matchCheck(hashes: string[], device: DeviceInfo): Promise<Map<string, number>> {
    const res = await this.request('POST', '/plugin/match-check', { body: { ...device, hashes }, accept: JSON_ACCEPT });
    if (!res.ok) throw await this.errorFrom(res, 'Matching the book failed');
    const body = await res.json().catch(() => null);
    const out = new Map<string, number>();
    for (const m of Array.isArray(body?.matches) ? body.matches : []) {
      if (typeof m?.hash === 'string' && typeof m?.bookId === 'number') out.set(m.hash, m.bookId);
    }
    return out;
  }

  /** Identifies server + login, so cached state never crosses accounts. */
  get accountKey(): string {
    return `${this.opts.server}|${this.opts.username ?? ''}`;
  }

  async uploadPageStats(device: DeviceInfo, books: { hash: string; events: PageStatEvent[] }[], keepalive = false): Promise<void> {
    const res = await this.request('POST', '/plugin/page-stats', {
      body: { ...device, books },
      accept: JSON_ACCEPT,
      keepalive,
    });
    if (!res.ok) throw await this.errorFrom(res, 'Uploading reading time failed');
  }

  async setReadStatus(bookId: number, status: 'reading' | 'read'): Promise<void> {
    const res = await this.request('PUT', `/plugin/catalog/books/${bookId}/read-status`, {
      body: { status },
      accept: JSON_ACCEPT,
    });
    if (!res.ok) throw await this.errorFrom(res, 'Updating the read status failed');
  }

  private async getJson(path: string, fallback: string): Promise<any> {
    const res = await this.request('GET', path, { accept: JSON_ACCEPT });
    if (res.status === 401 || res.status === 403) throw new KosyncError('BookOrbit rejected the login', res.status);
    if (!res.ok) throw await this.errorFrom(res, fallback);
    return res.json().catch(() => null);
  }
}

/** No bytes for this long = stalled download. */
export const DOWNLOAD_STALL_MS = 30_000;

/** Hard cap on a single download (EPUBs are rarely above a few tens of MB). */
export const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;

/**
 * Read a body with a per-chunk stall timeout. With a known size the bytes go
 * straight into one preallocated buffer (no chunk list + copy).
 */
async function readWithStallTimeout(
  res: Response,
  stallMs: number,
  expected: number | null,
  onProgress: (received: number) => void,
): Promise<Uint8Array> {
  if (!res.body) {
    const whole = new Uint8Array(await res.arrayBuffer());
    onProgress(whole.byteLength);
    return whole;
  }
  const reader = res.body.getReader();
  const target = expected !== null ? new Uint8Array(expected) : null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new KosyncError('Download stalled', null)), stallMs);
    });
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await Promise.race([reader.read(), stalled]);
    } catch (e) {
      reader.cancel().catch(() => {});
      throw e;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    if (step.done) break;
    const chunk = step.value;
    if (received + chunk.byteLength > (target ? target.byteLength : MAX_DOWNLOAD_BYTES)) {
      reader.cancel().catch(() => {});
      throw new KosyncError(target ? 'Download larger than announced' : 'Book is too large', null);
    }
    if (target) target.set(chunk, received);
    else chunks.push(chunk);
    received += chunk.byteLength;
    onProgress(received);
  }
  if (target) return received === target.byteLength ? target : target.subarray(0, received);
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function toBook(raw: any): BookOrbitBook | null {
  if (!raw || typeof raw.id !== 'number' || typeof raw.title !== 'string') return null;
  return {
    id: raw.id,
    title: raw.title,
    authors: Array.isArray(raw.authors) ? raw.authors.filter((a: unknown) => typeof a === 'string') : [],
    seriesName: typeof raw.seriesName === 'string' ? raw.seriesName : null,
    progressPercentage: typeof raw.progressPercentage === 'number' ? raw.progressPercentage : null,
    readStatus: typeof raw.readStatus === 'string' ? raw.readStatus : null,
    formats: Array.isArray(raw.formats) ? raw.formats.map(String) : [],
    lastReadAt: typeof raw.lastReadAt === 'string' ? raw.lastReadAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

// --- Reading tracker (glasses side) ---

/** KOReader statistics defaults: ignore glances, cap idle pages. */
export const MIN_PAGE_SECONDS = 5;
export const MAX_PAGE_SECONDS = 120;
/** Upload when this many events are queued... */
const BATCH_SIZE = 20;
/** ...or this long after the first queued event (and always on background/exit). */
export const STATS_FLUSH_DELAY_MS = 60_000;
const MAX_PENDING_PER_BOOK = 300;

type Clock = () => number;

/**
 * Turns "page N of T is now on screen" notifications into KOReader-style
 * page-stat events for BookOrbit's reading statistics, and marks the book
 * read once its last page is reached. One tracker per open book.
 */
export class BookOrbitTracker {
  private client: BookOrbitClient;
  private hash: string;
  private device: DeviceInfo;
  private now: Clock;
  private current: { page: number; totalPages: number; shownAt: number } | null = null;
  private uploading: Promise<void> = Promise.resolve();
  private finishedSent = false;
  private onError: (e: unknown) => void;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: { client: BookOrbitClient; hash: string; device: DeviceInfo; now?: Clock; onError?: (e: unknown) => void }) {
    this.client = opts.client;
    this.hash = opts.hash;
    this.device = opts.device;
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError ?? (() => {});
  }

  /**
   * Unsent events live in an outbox per account and book, shared by all
   * trackers: a failed upload survives the tracker being replaced (book
   * switch, reopen) and goes out with the next flush of any book.
   */
  private static outboxes = new Map<string, Map<string, PageStatEvent[]>>();

  private get outbox(): Map<string, PageStatEvent[]> {
    const key = this.client.accountKey;
    let box = BookOrbitTracker.outboxes.get(key);
    if (!box) {
      box = new Map();
      BookOrbitTracker.outboxes.set(key, box);
    }
    return box;
  }

  private get queue(): PageStatEvent[] {
    let q = this.outbox.get(this.hash);
    if (!q) {
      q = [];
      this.outbox.set(this.hash, q);
    }
    return q;
  }

  get pendingEvents(): number {
    return this.queue.length;
  }

  /** A reading page is on screen (paged turn or Flow page change). */
  pageShown(page: number, totalPages: number): void {
    if (this.current && this.current.page === page && this.current.totalPages === totalPages) return;
    this.closeCurrent();
    this.current = { page, totalPages, shownAt: this.now() };
    if (this.queue.length >= BATCH_SIZE) void this.flush();
    if (page >= totalPages && totalPages > 0) void this.markFinished();
  }

  /** Reading stopped (background, menus, exit): end the current page's time. */
  pause(): void {
    this.closeCurrent();
    this.current = null;
  }

  /** Upload queued events (serialized). Failed batches are kept for the next try. */
  flush(keepalive = false): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.uploading = this.uploading.then(async () => {
      // Drain in batches within BookOrbit's 500-events-per-request limit,
      // covering every book with pending events in this account.
      for (let round = 0; round < 10; round++) {
        const books: { hash: string; events: PageStatEvent[] }[] = [];
        let budget = 400;
        for (const [hash, events] of this.outbox) {
          if (events.length === 0 || budget === 0) continue;
          const take = events.splice(0, budget);
          budget -= take.length;
          books.push({ hash, events: take });
        }
        if (books.length === 0) return;
        try {
          await this.client.uploadPageStats(this.device, books, keepalive);
        } catch (e) {
          for (const b of books) {
            const q = this.outbox.get(b.hash) ?? [];
            // Bounded retry buffer per book; BookOrbit dedupes resent events.
            this.outbox.set(b.hash, [...b.events, ...q].slice(-MAX_PENDING_PER_BOOK));
          }
          this.onError(e);
          this.scheduleFlush(); // try again later
          return;
        }
      }
      this.scheduleFlush(); // still more after 10 rounds: continue later
    });
    return this.uploading;
  }

  /** Mark the book read in BookOrbit (once per tracker). */
  async markFinished(): Promise<boolean> {
    if (this.finishedSent) return false;
    this.finishedSent = true;
    try {
      const bookId = (await this.client.matchCheck([this.hash], this.device)).get(this.hash);
      if (bookId === undefined) return false; // not a book in the BookOrbit library
      await this.client.setReadStatus(bookId, 'read');
      return true;
    } catch (e) {
      this.finishedSent = false; // retry on the next last-page view
      this.onError(e);
      return false;
    }
  }

  private closeCurrent(): void {
    const c = this.current;
    if (!c) return;
    const seconds = Math.floor((this.now() - c.shownAt) / 1000);
    if (seconds < MIN_PAGE_SECONDS) return;
    this.queue.push({
      page: c.page,
      startTime: Math.floor(c.shownAt / 1000),
      durationSeconds: Math.min(seconds, MAX_PAGE_SECONDS),
      totalPages: c.totalPages,
    });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, STATS_FLUSH_DELAY_MS);
    // Never keep a Node test process alive for it.
    (this.flushTimer as { unref?: () => void }).unref?.();
  }
}
