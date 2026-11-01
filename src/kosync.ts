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

export function normalizeServerUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.search || url.hash) return null;
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
    const body = await res.json().catch(() => null);
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

  async updateProgress(update: ProgressUpdate, deviceId: string, keepalive = false): Promise<void> {
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
      return await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        keepalive,
      });
    } catch (e) {
      const aborted = (e as Error)?.name === 'AbortError';
      throw new KosyncError(aborted ? 'Sync server timed out' : 'Sync server unreachable', null);
    } finally {
      clearTimeout(timer);
    }
  }

  protected async errorFrom(res: Response, fallback: string): Promise<KosyncError> {
    let message = `${fallback} (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (body && typeof body.message === 'string') message = `${fallback}: ${body.message}`;
    } catch { /* non-JSON error body */ }
    return new KosyncError(message, res.status);
  }
}

export type PullDecision = 'apply' | 'none' | 'same' | 'ownDevice' | 'older';

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
): PullDecision {
  if (!remote || typeof remote.percentage !== 'number') return 'none';
  if (remote.device_id === deviceId) return 'ownDevice';
  if (local && Math.abs(remote.percentage - local.percentage) < 0.0001) return 'same';
  if (!local) return 'apply';
  // Both sides know when they moved: the newer position wins, also for an
  // explicit sync (whose caller then pushes ours instead).
  if (typeof remote.timestamp === 'number' && local.savedAtMs !== null) {
    return remote.timestamp * 1000 > local.savedAtMs ? 'apply' : 'older';
  }
  if (interactive) return 'apply';
  // Old servers send no timestamp: only move forward.
  return remote.percentage > local.percentage ? 'apply' : 'older';
}

/** KOReader rounds percentages to 4 decimals before comparing/sending. */
export function roundPercentage(p: number): number {
  return Math.floor(Math.min(1, Math.max(0, p)) * 10000) / 10000;
}
