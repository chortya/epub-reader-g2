/**
 * Per-book KOSync orchestration: converts reader positions to KOReader
 * progress (XPointer + percentage) and back, and paces pushes.
 */

import type { Book } from './types.ts';
import {
  KosyncClient,
  decidePull,
  documentDigest,
  isKosyncLoggedIn,
  roundPercentage,
  type KosyncSettings,
  type PullDecision,
  type RemoteProgress,
} from './kosync.ts';
import {
  ChapterLocator,
  bookPercentage,
  fragmentPrefix,
  parseXPointer,
  positionForPercentage,
} from './kosync-locator.ts';

export type ReaderLocation = { chapterIndex: number; offset: number };

export type PullResult = {
  decision: PullDecision;
  remote: RemoteProgress | null;
  target: ReaderLocation | null;
};

/** Trailing delay after the last position change before pushing. */
export const PUSH_DEBOUNCE_MS = 15_000;
/** Upper bound between pushes while positions keep changing (Flow mode). */
export const PUSH_MAX_WAIT_MS = 60_000;

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  now: () => number;
};

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

function parseChapterBody(xhtml: string): Element | null {
  const parser = new DOMParser();
  let doc = parser.parseFromString(xhtml, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    doc = parser.parseFromString(xhtml, 'text/html');
  }
  return doc.getElementsByTagName('body')[0] ?? null;
}

export class KosyncSession {
  private book: Book;
  private filename: string | null;
  private settings: KosyncSettings;
  private client: KosyncClient;
  private locators = new Map<number, Promise<ChapterLocator | null>>();
  private chapterLengths: number[];
  private timers: Timers;
  private pushTimer: unknown = null;
  private firstPendingAt: number | null = null;
  private pending: ReaderLocation | null = null;
  private lastPushed: string | null = null;
  // Upload ordering is shared by every session (a book reopened gets a new
  // session, and its PUTs must still queue behind the old session's). The
  // sequence is per document: a newer push or an adopted remote position
  // invalidates older queued or in-preparation pushes for that document.
  private static uploads: Promise<unknown> = Promise.resolve();
  private static pushSeq = new Map<string, number>();

  private static bumpSeq(document: string): number {
    const next = (KosyncSession.pushSeq.get(document) ?? 0) + 1;
    KosyncSession.pushSeq.set(document, next);
    return next;
  }

  private static isCurrent(document: string, seq: number): boolean {
    return KosyncSession.pushSeq.get(document) === seq;
  }
  private parseBody: (xhtml: string) => Element | null;

  constructor(opts: {
    book: Book;
    filename: string | null;
    settings: KosyncSettings;
    client: KosyncClient;
    timers?: Timers;
    parseBody?: (xhtml: string) => Element | null;
  }) {
    this.book = opts.book;
    this.filename = opts.filename;
    this.settings = opts.settings;
    this.client = opts.client;
    this.timers = opts.timers ?? defaultTimers;
    this.parseBody = opts.parseBody ?? parseChapterBody;
    this.chapterLengths = this.book.chapters.map((c) => c.text.length);
  }

  static isUsable(settings: KosyncSettings | null): settings is KosyncSettings {
    return isKosyncLoggedIn(settings);
  }

  get document(): string | null {
    return documentDigest(this.settings.checksum, this.book.partialMd5, this.filename);
  }

  percentageAt(loc: ReaderLocation): number {
    return roundPercentage(bookPercentage(this.chapterLengths, loc.chapterIndex, loc.offset));
  }

  private locator(chapterIndex: number): Promise<ChapterLocator | null> {
    let entry = this.locators.get(chapterIndex);
    if (!entry) {
      const load = this.book.loadChapterXhtml;
      const text = this.book.chapters[chapterIndex]?.text;
      entry = (async () => {
        if (!load || text === undefined) return null;
        try {
          const body = this.parseBody(await load(chapterIndex));
          return body ? new ChapterLocator(body, text) : null;
        } catch (e) {
          console.warn('KOSync: chapter locator failed', e);
          return null;
        }
      })();
      this.locators.set(chapterIndex, entry);
    }
    return entry;
  }

  /** KOReader XPointer for a reader location (paragraph precision). */
  async xpointerAt(loc: ReaderLocation): Promise<string | null> {
    const spineIndex = this.book.chapters[loc.chapterIndex]?.spineIndex;
    if (spineIndex === undefined) return null;
    const locator = await this.locator(loc.chapterIndex);
    const path = locator?.pathForOffset(loc.offset) ?? '';
    return `${fragmentPrefix(spineIndex)}${path}`;
  }

  /** Reader location for a remote progress: XPointer first, percentage fallback. */
  async locationFor(remote: RemoteProgress): Promise<ReaderLocation | null> {
    const xp = parseXPointer(remote.progress);
    if (xp) {
      const spineIndex = xp.fragment - 1;
      const chapters = this.book.chapters;
      const exact = chapters.findIndex((c) => c.spineIndex === spineIndex);
      if (exact >= 0) {
        const locator = await this.locator(exact);
        const offset = locator?.offsetForSteps(xp.steps, xp.point) ?? 0;
        return { chapterIndex: exact, offset: Math.max(0, offset) };
      }
      // The fragment was too short to become a chapter: next chapter start.
      const next = chapters.findIndex((c) => (c.spineIndex ?? -1) > spineIndex);
      if (next >= 0) return { chapterIndex: next, offset: 0 };
    }
    if (typeof remote.percentage === 'number' && Number.isFinite(remote.percentage)) {
      return positionForPercentage(this.chapterLengths, remote.percentage);
    }
    return null;
  }

  async pull(
    local: { location: ReaderLocation; savedAtMs: number | null } | null,
    interactive: boolean,
  ): Promise<PullResult> {
    const document = this.document;
    if (!document) return { decision: 'none', remote: null, target: null };
    const remote = await this.client.getProgress(document);
    const decision = decidePull(
      remote,
      local ? { percentage: this.percentageAt(local.location), savedAtMs: local.savedAtMs } : null,
      this.settings.deviceId,
      interactive,
    );
    let target = decision === 'apply' && remote ? await this.locationFor(remote) : null;
    // Percentages differ between KOReader (pages) and us (characters), so
    // also compare where the two positions land: same paragraph = in sync.
    if (target && local && await this.xpointerAt(target) === await this.xpointerAt(local.location)) {
      return { decision: 'same', remote, target: null };
    }
    return { decision: target || decision !== 'apply' ? decision : 'none', remote, target };
  }

  /** Push now. Skips unchanged positions unless forced. */
  async push(loc: ReaderLocation, opts: { force?: boolean; keepalive?: boolean } = {}): Promise<boolean> {
    this.cancelScheduledPush();
    // Uploads run one at a time in request order, and a push superseded by a
    // newer one while it waited is dropped: a slow older PUT must never land
    // after (and overwrite) a newer position.
    const document = this.document;
    if (!document) return false;
    const seq = KosyncSession.bumpSeq(document);
    const run = KosyncSession.uploads.then(async () => {
      if (!KosyncSession.isCurrent(document, seq)) return false;
      const progress = await this.xpointerAt(loc);
      // Re-check after the await: markSynced or a newer push may have landed.
      if (!progress || !KosyncSession.isCurrent(document, seq)) return false;
      const percentage = this.percentageAt(loc);
      const key = `${progress}|${percentage}`;
      if (!opts.force && key === this.lastPushed) return false;
      await this.client.updateProgress({ document, progress, percentage }, this.settings.deviceId, opts.keepalive);
      if (KosyncSession.isCurrent(document, seq)) this.lastPushed = key;
      return true;
    });
    KosyncSession.uploads = run.catch(() => false);
    return run;
  }

  /**
   * Record a position adopted from the server as already pushed, so the save
   * that follows the jump does not echo it back under this device's name.
   */
  async markSynced(loc: ReaderLocation): Promise<void> {
    this.cancelScheduledPush();
    const document = this.document;
    if (document) KosyncSession.bumpSeq(document); // drop uploads queued before the jump
    const progress = await this.xpointerAt(loc);
    if (progress) this.lastPushed = `${progress}|${this.percentageAt(loc)}`;
  }

  /** Trailing-debounced push with a max wait, for page turns and Flow ticks. */
  schedulePush(loc: ReaderLocation, onError?: (e: unknown) => void): void {
    this.pending = loc;
    // Warm the chapter's locator now, so a flush at app exit can send the
    // keepalive request without first unzipping and parsing XHTML.
    void this.locator(loc.chapterIndex);
    const now = this.timers.now();
    if (this.firstPendingAt === null) this.firstPendingAt = now;
    if (this.pushTimer !== null) this.timers.clearTimeout(this.pushTimer);
    const waited = now - this.firstPendingAt;
    const delay = Math.max(0, Math.min(PUSH_DEBOUNCE_MS, PUSH_MAX_WAIT_MS - waited));
    this.pushTimer = this.timers.setTimeout(() => {
      const target = this.pending;
      this.pushTimer = null;
      this.firstPendingAt = null;
      this.pending = null;
      if (target) this.push(target).catch((e) => onError?.(e));
    }, delay);
  }

  /** Push whatever is pending right away (app backgrounding, book switch). */
  async flush(opts: { keepalive?: boolean } = {}): Promise<void> {
    const target = this.pending;
    this.cancelScheduledPush();
    if (target) await this.push(target, { keepalive: opts.keepalive });
    else await KosyncSession.uploads; // an upload already under way
  }

  cancelScheduledPush(): void {
    if (this.pushTimer !== null) this.timers.clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.firstPendingAt = null;
    this.pending = null;
  }
}
