/**
 * KOReader progress sync (kosync protocol, issue #1).
 *
 * Protocol (koreader/plugins/kosync.koplugin/api.json):
 *   POST /users/create        {username, password: md5(pw)}       -> 201 | 402 (exists)
 *   GET  /users/auth          x-auth-user / x-auth-key headers    -> 200 | 401
 *   PUT  /syncs/progress      {document, progress, percentage, device, device_id}
 *   GET  /syncs/progress/:doc -> {document, progress, percentage, device, device_id, timestamp}
 * All requests carry `Accept: application/vnd.koreader.v1+json`.
 *
 * Even Hub only lets the WebView reach whitelisted origins that also send CORS
 * headers; stock kosync servers send none. When RELAY_ORIGIN is configured the
 * requests go through that relay (see relay/), which forwards them to the
 * user's server named in `X-Kosync-Server`. Without a relay they go direct,
 * which works in the browser/dev build against a CORS-enabled server.
 */

import { md5Hex } from './md5.ts';

export const KOSYNC_STORAGE_KEY = 'epub-kosync';
export const DEFAULT_KOSYNC_SERVER = 'https://sync.koreader.rocks';
export const KOSYNC_DEVICE_NAME = 'Even G2';
const ACCEPT = 'application/vnd.koreader.v1+json';

export type KosyncChecksum = 'binary' | 'filename';

/**
 * Which kind of server `server` points at. A BookOrbit server speaks kosync
 * under <origin>/api/v1/koreader and adds a library catalog, reading stats
 * and read status on top (see bookorbit.ts).
 */
export type SyncProvider = 'kosync' | 'bookorbit';

/** kosync base path of a BookOrbit server, relative to its origin. */
export const BOOKORBIT_KOSYNC_PATH = '/api/v1/koreader';

export type KosyncSettings = {
  provider: SyncProvider;
  /** kosync base URL (for BookOrbit: origin + BOOKORBIT_KOSYNC_PATH). */
  server: string;
  username: string;
  /** md5(password), as KOReader stores it. Empty = logged out. */
  userkey: string;
  checksum: KosyncChecksum;
  /** Stable per-install id so pulls can skip our own pushes. */
  deviceId: string;
};

export type RemoteProgress = {
  document: string;
  progress: string;
  percentage: number;
  device?: string;
  device_id?: string;
  /** Unix seconds, set by the server. */
  timestamp?: number;
};

export type ProgressUpdate = {
  document: string;
  progress: string;
  percentage: number;
};

type StorageLike = {
  getLocalStorage(key: string): Promise<string | null | undefined>;
  setLocalStorage(key: string, value: string): Promise<boolean | void>;
};

export function makeDeviceId(random: () => number = Math.random): string {
  let id = '';
  for (let i = 0; i < 32; i++) id += Math.floor(random() * 16).toString(16);
  return id.toUpperCase();
}

/**
 * A sync server base URL: https, or http only on this device (loopback, for
 * development) - the username and MD5 key work like a password and must not
 * cross a network unencrypted. No credentials, query or fragment.
 */
export function normalizeServerUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    if (url.search || url.hash || url.username || url.password) return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function defaultKosyncSettings(): KosyncSettings {
  return {
    provider: 'kosync',
    server: DEFAULT_KOSYNC_SERVER,
    username: '',
    userkey: '',
    checksum: 'binary',
    deviceId: makeDeviceId(),
  };
}

export function parseKosyncSettings(raw: string | null | undefined): KosyncSettings | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    const base = defaultKosyncSettings();
    return {
      provider: v.provider === 'bookorbit' ? 'bookorbit' : 'kosync',
      server: typeof v.server === 'string' && normalizeServerUrl(v.server) ? normalizeServerUrl(v.server)! : base.server,
      username: typeof v.username === 'string' ? v.username : '',
      userkey: typeof v.userkey === 'string' && /^[a-f0-9]{32}$/.test(v.userkey) ? v.userkey : '',
      checksum: v.checksum === 'filename' ? 'filename' : 'binary',
      deviceId: typeof v.deviceId === 'string' && /^[A-F0-9]{32}$/.test(v.deviceId) ? v.deviceId : base.deviceId,
    };
  } catch {
    return null;
  }
}

/**
 * kosync base for what the user typed as their BookOrbit address: accepts the
 * site origin (https://books.example.org) or a URL already ending in the API path.
 */
export function bookOrbitKosyncBase(address: string): string | null {
  const normalized = normalizeServerUrl(address);
  if (!normalized) return null;
  return normalized.endsWith(BOOKORBIT_KOSYNC_PATH) ? normalized : `${normalized}${BOOKORBIT_KOSYNC_PATH}`;
}

/** The BookOrbit site address for a stored kosync base (inverse of bookOrbitKosyncBase). */
export function bookOrbitAddress(server: string): string {
  return server.endsWith(BOOKORBIT_KOSYNC_PATH) ? server.slice(0, -BOOKORBIT_KOSYNC_PATH.length) : server;
}

export function isKosyncLoggedIn(s: KosyncSettings | null): s is KosyncSettings {
  return !!s && s.username.length > 0 && s.userkey.length === 32;
}

/** Bridge storage first (survives device restarts), browser storage as fallback. */
export async function loadKosyncSettings(bridge: StorageLike | null, browser?: Storage): Promise<KosyncSettings> {
  let parsed: KosyncSettings | null = null;
  if (bridge) {
    try {
      parsed = parseKosyncSettings(await bridge.getLocalStorage(KOSYNC_STORAGE_KEY));
    } catch { /* fall through */ }
  }
  if (!parsed && browser) parsed = parseKosyncSettings(browser.getItem(KOSYNC_STORAGE_KEY));
  return parsed ?? defaultKosyncSettings();
}

export async function saveKosyncSettings(
  settings: KosyncSettings,
  bridge: StorageLike | null,
  browser?: Storage,
): Promise<void> {
  const raw = JSON.stringify(settings);
  browser?.setItem(KOSYNC_STORAGE_KEY, raw);
  if (bridge) {
    const ok = await bridge.setLocalStorage(KOSYNC_STORAGE_KEY, raw);
    if (ok === false) throw new Error('Could not save sync settings');
  }
}

/** KOReader document id: partial MD5 of the file, or md5 of the file name. */
export function documentDigest(
  checksum: KosyncChecksum,
  partialMd5: string | undefined,
  filename: string | null | undefined,
): string | null {
  if (checksum === 'filename') {
    if (!filename) return null;
    const base = filename.split(/[\\/]/).pop() ?? filename;
    return md5Hex(base);
  }
  return partialMd5 ?? null;
}

export class KosyncError extends Error {
  status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

export type KosyncRequestOptions = {
  body?: unknown;
  auth?: boolean;
  keepalive?: boolean;
  /** Defaults to the kosync media type; BookOrbit's own routes take JSON. */
  accept?: string;
  timeoutMs?: number;
};

export type KosyncClientOptions = {
  server: string;
  username?: string;
  userkey?: string;
  relayOrigin?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class KosyncClient {
  protected opts: KosyncClientOptions;

  constructor(opts: KosyncClientOptions) {
    this.opts = opts;
  }

  /** Create an account. Resolves false when the username is taken (402). */
  async register(username: string, password: string): Promise<boolean> {
    const res = await this.request('POST', '/users/create', { body: { username, password: md5Hex(password) }, auth: false });
    if (res.status === 201) return true;
    if (res.status === 402) return false;
    throw await this.errorFrom(res, 'Registration failed');
  }

  async authorize(): Promise<boolean> {
    const res = await this.request('GET', '/users/auth');
    if (res.status === 200) return true;
    if (res.status === 401) return false;
    throw await this.errorFrom(res, 'Login failed');
  }

  async getProgress(document: string): Promise<RemoteProgress | null> {
    const res = await this.request('GET', `/syncs/progress/${encodeURIComponent(document)}`);
    if (res.status === 401) throw new KosyncError('Not authorized', 401);
    // Some kosync-compatible servers answer 404/204 for a never-synced book.
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) throw await this.errorFrom(res, 'Fetching progress failed');
    const body = await this.readJson(res);
    if (!body || typeof body !== 'object' || typeof body.percentage !== 'number') return null;
    return {
      document: String(body.document ?? document),
      progress: typeof body.progress === 'string' ? body.progress : String(body.progress ?? ''),
      percentage: body.percentage,
      device: typeof body.device === 'string' ? body.device : undefined,
      device_id: typeof body.device_id === 'string' ? body.device_id : undefined,
      timestamp: typeof body.timestamp === 'number' ? body.timestamp : undefined,
    };
  }

  /**
   * Server clock minus this device's clock (ms), learned from the timestamp
   * kosync servers return for a PUT; null until the first push. Lets pulls
   * compare the server's timestamps with local save times fairly when the
   * phone's clock is off.
   */
  /** Identifies server + login, so cached/queued state never crosses accounts. */
  get accountKey(): string {
    return `${this.opts.server}|${this.opts.username ?? ''}`;
  }

  get clockOffsetMs(): number | null {
    return KosyncClient.clockOffsets.get(this.opts.server) ?? null;
  }

  set clockOffsetMs(value: number | null) {
    if (value === null) KosyncClient.clockOffsets.delete(this.opts.server);
    else KosyncClient.clockOffsets.set(this.opts.server, value);
  }

  /** Lets body readers abort the request that produced a response. */
  private static controllers = new WeakMap<Response, AbortController>();

  /** Per server, shared by every client instance (a new one is made per book). */
  private static clockOffsets = new Map<string, number>();

  async updateProgress(update: ProgressUpdate, deviceId: string, keepalive = false): Promise<void> {
    const sentAt = Date.now();
    const res = await this.request('PUT', '/syncs/progress', {
      body: {
        document: update.document,
        progress: update.progress,
        percentage: update.percentage,
        device: KOSYNC_DEVICE_NAME,
        device_id: deviceId,
      },
      keepalive,
    });
    if (res.status === 401) throw new KosyncError('Not authorized', 401);
    if (!res.ok) throw await this.errorFrom(res, 'Pushing progress failed');
    const body = await this.readJson(res).catch(() => null); // the PUT itself succeeded
    if (body && typeof body.timestamp === 'number' && Number.isFinite(body.timestamp)) {
      const local = (sentAt + Date.now()) / 2; // midpoint of the round trip
      this.clockOffsetMs = body.timestamp * 1000 - local;
    }
  }

  /**
   * JSON body with its own timeout: request()'s timer stops once headers
   * arrive, and a body that stalls afterwards must not hang the caller.
   * Throws on a timeout or an unparsable body: neither may be mistaken for
   * "the server has no progress" (that would push over the real one).
   * An empty body resolves to null.
   */
  protected async readJson(res: Response, timeoutMs = this.opts.timeoutMs ?? 10_000): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Abort the fetch itself: that also ends a body stream already being read.
        KosyncClient.controllers.get(res)?.abort();
        reject(new KosyncError('Sync server response timed out', null));
      }, timeoutMs);
    });
    try {
      const text = await Promise.race([readTextLimited(res, MAX_JSON_BYTES), timeout]);
      if (text.trim() === '') return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new KosyncError('Sync server sent an invalid response', res.status);
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  protected async request(method: string, path: string, opts: KosyncRequestOptions = {}): Promise<Response> {
    const { body, auth = true, keepalive = false } = opts;
    const headers: Record<string, string> = { Accept: opts.accept ?? ACCEPT };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      headers['x-auth-user'] = this.opts.username ?? '';
      headers['x-auth-key'] = this.opts.userkey ?? '';
    }
    let url: string;
    if (this.opts.relayOrigin) {
      url = `${this.opts.relayOrigin}/kosync${path}`;
      headers['X-Kosync-Server'] = this.opts.server;
    } else {
      url = `${this.opts.server}${path}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.opts.timeoutMs ?? 10_000);
    try {
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      const res = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        keepalive,
        // Never follow a redirect with x-auth-key: it would hand the reusable
        // key to whatever origin the redirect names.
        redirect: 'error',
      });
      KosyncClient.controllers.set(res, controller);
      return res;
    } catch (e) {
      const aborted = (e as Error)?.name === 'AbortError';
      throw new KosyncError(aborted ? 'Sync server timed out' : 'Sync server unreachable', null);
    } finally {
      clearTimeout(timer);
    }
  }

  protected async errorFrom(res: Response, fallback: string): Promise<KosyncError> {
    let message = `${fallback} (HTTP ${res.status})`;
    const body = await this.readJson(res, 3000).catch(() => null);
    if (body && typeof body.message === 'string') message = `${fallback}: ${body.message.slice(0, 200)}`;
    return new KosyncError(message, res.status);
  }
}

/** Largest JSON body accepted from a sync/BookOrbit server. */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;

/** Response text, rejecting once more than maxBytes arrive (cancels the stream). */
async function readTextLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.body?.cancel().catch(() => {});
    throw new KosyncError('Sync server response too large', res.status);
  }
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      throw new KosyncError('Sync server response too large', res.status);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export type PullDecision = 'apply' | 'none' | 'same' | 'ownDevice' | 'older';

/** Order of two save times this close is uncertain (device clocks drift). */
export const CLOCK_SKEW_WINDOW_MS = 5 * 60_000;
/**
 * ...once the server-vs-phone offset is measured. Kept at a minute: the
 * remote timestamp may come from another device's own (skewed) clock.
 */
export const CLOCK_SKEW_WINDOW_KNOWN_MS = 60_000;

/** BookOrbit's reset marker and the position a device sends to accept it. */
export const RESET_PROGRESS = '/body/DocFragment[1]/body';
const RESET_PERCENTAGE = 0.01;

/**
 * BookOrbit answers a pull with this after "reset progress" in its UI, and
 * holds the device's later pushes until the device reports the book start
 * (DocFragment[1], <= 1 %) - see KosyncSession.acknowledgeReset.
 */
export function isBookOrbitReset(remote: RemoteProgress): boolean {
  return remote.device_id === 'bookorbit-web'
    && remote.percentage <= RESET_PERCENTAGE
    && /^\/body\/DocFragment\[1\](\/|$)/.test(remote.progress.trim());
}

/**
 * Whether a remote position should replace the local one. Mirrors KOReader's
 * defaults: a newer remote position moves us forward (KOReader prompts; the
 * glasses apply it and say so), an older one is ignored unless the user asked
 * for the pull explicitly.
 */
export function decidePull(
  remote: RemoteProgress | null,
  local: { percentage: number; savedAtMs: number | null } | null,
  deviceId: string,
  interactive: boolean,
  clockOffsetMs: number | null = null,
): PullDecision {
  if (!remote || typeof remote.percentage !== 'number') return 'none';
  // A reset made in BookOrbit is a deliberate "start over"; it always wins.
  if (isBookOrbitReset(remote)) return local && local.percentage <= RESET_PERCENTAGE ? 'same' : 'apply';
  if (remote.device_id === deviceId) return 'ownDevice';
  if (local && Math.abs(remote.percentage - local.percentage) < 0.0001) return 'same';
  if (!local) return 'apply';
  // Both sides know when they moved: the newer position wins, also for an
  // explicit sync (whose caller then pushes ours instead). Local save times
  // are moved onto the server's clock when the offset is known; within the
  // remaining uncertainty the order is unknown, so both kinds of sync only
  // move forward (never throw away pages just read on either device).
  if (typeof remote.timestamp === 'number' && local.savedAtMs !== null) {
    const localOnServerClock = local.savedAtMs + (clockOffsetMs ?? 0);
    const window = clockOffsetMs === null ? CLOCK_SKEW_WINDOW_MS : CLOCK_SKEW_WINDOW_KNOWN_MS;
    const delta = remote.timestamp * 1000 - localOnServerClock;
    if (delta > window) return 'apply';
    if (delta < -window) return 'older';
    return remote.percentage > local.percentage ? 'apply' : 'older';
  }
  if (interactive) return 'apply';
  // Old servers send no timestamp: only move forward.
  return remote.percentage > local.percentage ? 'apply' : 'older';
}

/** KOReader rounds percentages to 4 decimals before comparing/sending. */
export function roundPercentage(p: number): number {
  return Math.floor(Math.min(1, Math.max(0, p)) * 10000) / 10000;
}
