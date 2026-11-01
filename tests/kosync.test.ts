import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';

import {
  KosyncClient,
  KosyncError,
  decidePull,
  documentDigest,
  isKosyncLoggedIn,
  loadKosyncSettings,
  makeDeviceId,
  normalizeServerUrl,
  parseKosyncSettings,
  roundPercentage,
  saveKosyncSettings,
  KOSYNC_STORAGE_KEY,
  type KosyncSettings,
} from '../src/kosync.ts';
import { KosyncSession, PUSH_DEBOUNCE_MS, PUSH_MAX_WAIT_MS } from '../src/kosync-session.ts';
import type { Book } from '../src/types.ts';

type Call = { url: string; method: string; headers: Record<string, string>; body: any; keepalive?: boolean };

function fakeFetch(responder: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      keepalive: init.keepalive,
    };
    calls.push(call);
    const r = responder(call);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const SETTINGS: KosyncSettings = {
  server: 'https://sync.example.com',
  username: 'reader',
  userkey: '5f4dcc3b5aa765d61d8327deb882cf99',
  checksum: 'binary',
  deviceId: 'A'.repeat(32),
};

test('client sends kosync headers and md5 password; relay mode rewrites the URL', async () => {
  const { impl, calls } = fakeFetch((c) => (c.url.endsWith('/users/create') ? { status: 201 } : { status: 200, body: { authorized: 'OK' } }));
  const direct = new KosyncClient({ server: SETTINGS.server, username: 'reader', userkey: SETTINGS.userkey, fetchImpl: impl });
  assert.equal(await direct.register('reader', 'password'), true);
  assert.deepEqual(calls[0].body, { username: 'reader', password: '5f4dcc3b5aa765d61d8327deb882cf99' });
  assert.equal(calls[0].headers['x-auth-user'], undefined);
  assert.equal(await direct.authorize(), true);
  assert.equal(calls[1].url, 'https://sync.example.com/users/auth');
  assert.equal(calls[1].headers.Accept, 'application/vnd.koreader.v1+json');
  assert.equal(calls[1].headers['x-auth-user'], 'reader');
  assert.equal(calls[1].headers['x-auth-key'], SETTINGS.userkey);

  const relayed = new KosyncClient({
    server: SETTINGS.server, username: 'reader', userkey: SETTINGS.userkey, fetchImpl: impl,
    relayOrigin: 'https://relay.example.net',
  });
  await relayed.authorize();
  assert.equal(calls[2].url, 'https://relay.example.net/kosync/users/auth');
  assert.equal(calls[2].headers['X-Kosync-Server'], 'https://sync.example.com');
});

test('client maps status codes', async () => {
  const { impl } = fakeFetch((c) => {
    if (c.url.endsWith('/users/create')) return { status: 402, body: { message: 'Username is already registered.' } };
    if (c.url.endsWith('/users/auth')) return { status: 401, body: { message: 'Unauthorized' } };
    if (c.url.includes('/syncs/progress/missing')) return { status: 200, body: {} };
    return { status: 500, body: { message: 'boom' } };
  });
  const client = new KosyncClient({ server: SETTINGS.server, fetchImpl: impl });
  assert.equal(await client.register('taken', 'pw'), false);
  assert.equal(await client.authorize(), false);
  assert.equal(await client.getProgress('missing'), null);
  await assert.rejects(client.getProgress('x'), (e: unknown) => e instanceof KosyncError && /boom/.test(e.message) && e.status === 500);
});

test('client turns network failures into KosyncError', async () => {
  const impl = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
  const client = new KosyncClient({ server: SETTINGS.server, fetchImpl: impl });
  await assert.rejects(client.authorize(), (e: unknown) => e instanceof KosyncError && e.status === null);
});

test('settings parse defensively and round-trip through storage', async () => {
  assert.equal(parseKosyncSettings('not json'), null);
  const parsed = parseKosyncSettings(JSON.stringify({ server: 'https://x.org/', username: 'u', userkey: 'nope', deviceId: 'bad' }))!;
  assert.equal(parsed.server, 'https://x.org');
  assert.equal(parsed.userkey, '');
  assert.match(parsed.deviceId, /^[A-F0-9]{32}$/);
  assert.equal(isKosyncLoggedIn(parsed), false);
  assert.equal(isKosyncLoggedIn(SETTINGS), true);

  const store = new Map<string, string>();
  const bridge = {
    getLocalStorage: async (k: string) => store.get(k) ?? '',
    setLocalStorage: async (k: string, v: string) => { store.set(k, v); return true; },
  };
  await saveKosyncSettings(SETTINGS, bridge);
  assert.ok(store.has(KOSYNC_STORAGE_KEY));
  assert.deepEqual(await loadKosyncSettings(bridge), SETTINGS);
  await assert.rejects(saveKosyncSettings(SETTINGS, { ...bridge, setLocalStorage: async () => false }));
});

test('normalizeServerUrl accepts http(s) bases with paths only', () => {
  assert.equal(normalizeServerUrl(' https://host.tld/kosync/ '), 'https://host.tld/kosync');
  assert.equal(normalizeServerUrl('ftp://host'), null);
  assert.equal(normalizeServerUrl('https://host/?a=1'), null);
  assert.equal(normalizeServerUrl(''), null);
  assert.match(makeDeviceId(() => 0.99), /^F{32}$/);
});

test('documentDigest: binary uses the partial MD5, filename hashes the basename', () => {
  assert.equal(documentDigest('binary', 'abc', 'x.epub'), 'abc');
  assert.equal(documentDigest('binary', undefined, 'x.epub'), null);
  // md5("alice.epub")
  assert.equal(documentDigest('filename', 'abc', 'books/alice.epub'), documentDigest('filename', undefined, 'alice.epub'));
  assert.equal(documentDigest('filename', 'abc', null), null);
});

test('decidePull follows KOReader defaults (forward applies, backward is ignored)', () => {
  const remote = { document: 'd', progress: 'p', percentage: 0.5, device_id: 'OTHER', timestamp: 2_000 };
  assert.equal(decidePull(null, null, 'ME', false), 'none');
  assert.equal(decidePull({ ...remote, device_id: 'ME' }, null, 'ME', true), 'ownDevice');
  assert.equal(decidePull(remote, { percentage: 0.5, savedAtMs: 0 }, 'ME', false), 'same');
  assert.equal(decidePull(remote, null, 'ME', false), 'apply');
  assert.equal(decidePull(remote, { percentage: 0.2, savedAtMs: 1_000_000 }, 'ME', false), 'apply');
  assert.equal(decidePull(remote, { percentage: 0.8, savedAtMs: 3_000_000 }, 'ME', false), 'older');
  assert.equal(decidePull(remote, { percentage: 0.8, savedAtMs: 3_000_000 }, 'ME', true), 'apply');
  // No timestamps: forward only.
  assert.equal(decidePull({ ...remote, timestamp: undefined }, { percentage: 0.8, savedAtMs: null }, 'ME', false), 'older');
  assert.equal(decidePull({ ...remote, timestamp: undefined }, { percentage: 0.2, savedAtMs: null }, 'ME', false), 'apply');
  assert.equal(roundPercentage(0.123456), 0.1234);
});

const CH1 = '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>One</h1><p>First paragraph text here.</p><p>Second paragraph text.</p></body></html>';
const CH2 = '<html xmlns="http://www.w3.org/1999/xhtml"><body><div><p>Third paragraph in chapter two.</p><p>Fourth and final.</p></div></body></html>';

function book(): Book {
  const sources = [CH1, CH2];
  return {
    title: 'T',
    partialMd5: 'f'.repeat(32),
    chapters: [
      { title: 'One', text: 'One\n  First paragraph text here.\n  Second paragraph text.', spineIndex: 1 },
      { title: 'Two', text: 'Third paragraph in chapter two.\n  Fourth and final.', spineIndex: 3 },
    ],
    loadChapterXhtml: async (i) => sources[i],
  };
}

const parseBody = (xhtml: string) =>
  new DOMParser().parseFromString(xhtml, 'text/html').querySelector('body') as unknown as Element;

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
      clearTimeout: (id: unknown) => { timers.delete(id as number); },
      now: () => now,
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) { timers.delete(id); t.fn(); }
      }
    },
    pending: () => timers.size,
  };
}

test('session pushes DocFragment XPointers and maps remote XPointers back', async () => {
  const { impl, calls } = fakeFetch((c) => {
    if (c.method === 'PUT') return { status: 200, body: { document: c.body.document } };
    return {
      status: 200,
      body: { document: 'x', progress: '/body/DocFragment[4]/body/div/p[2]/text().0', percentage: 0.9, device_id: 'KOBO', timestamp: 10 },
    };
  });
  const client = new KosyncClient({ server: SETTINGS.server, username: 'reader', userkey: SETTINGS.userkey, fetchImpl: impl });
  const session = new KosyncSession({ book: book(), filename: 'b.epub', settings: SETTINGS, client, parseBody });

  const b = book();
  const offset = b.chapters[0].text.indexOf('Second');
  assert.equal(await session.push({ chapterIndex: 0, offset }), true);
  assert.equal(calls[0].body.progress, '/body/DocFragment[2]/body/p[2]');
  assert.equal(calls[0].body.document, 'f'.repeat(32));
  assert.equal(calls[0].body.device, 'Even G2');
  assert.equal(calls[0].body.device_id, SETTINGS.deviceId);
  assert.ok(calls[0].body.percentage > 0 && calls[0].body.percentage < 0.6);
  // Unchanged position is not re-sent unless forced.
  assert.equal(await session.push({ chapterIndex: 0, offset }), false);
  assert.equal(await session.push({ chapterIndex: 0, offset }, { force: true }), true);

  const pulled = await session.pull({ location: { chapterIndex: 0, offset: 0 }, savedAtMs: 1_000 }, false);
  assert.equal(pulled.decision, 'apply');
  assert.deepEqual(pulled.target, { chapterIndex: 1, offset: b.chapters[1].text.indexOf('Fourth') });
});

test('session falls back to percentage and to the next chapter for skipped fragments', async () => {
  const client = new KosyncClient({ server: SETTINGS.server, fetchImpl: fakeFetch(() => ({ status: 200 })).impl });
  const session = new KosyncSession({ book: book(), filename: null, settings: SETTINGS, client, parseBody });
  // DocFragment[3] = spine 2, which produced no chapter -> start of the next one.
  assert.deepEqual(await session.locationFor({ document: 'd', progress: '/body/DocFragment[3]/body/p', percentage: 0 }), { chapterIndex: 1, offset: 0 });
  // Not an XPointer (e.g. a PDF page number) -> percentage.
  assert.deepEqual(await session.locationFor({ document: 'd', progress: '12', percentage: 0 }), { chapterIndex: 0, offset: 0 });
  // Filename checksum without a filename -> no document id, nothing to do.
  const byName = new KosyncSession({ book: book(), filename: null, settings: { ...SETTINGS, checksum: 'filename' }, client, parseBody });
  assert.equal((await byName.pull(null, true)).decision, 'none');
});

test('schedulePush debounces and caps the wait during continuous movement', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
  const client = new KosyncClient({ server: SETTINGS.server, fetchImpl: impl });
  const clock = fakeTimers();
  const session = new KosyncSession({ book: book(), filename: null, settings: SETTINGS, client, parseBody, timers: clock.timers });

  // A change every 5 s keeps resetting the debounce, but the max wait forces a push.
  let pushedAt = -1;
  for (let t = 0; t <= PUSH_MAX_WAIT_MS; t += 5_000) {
    session.schedulePush({ chapterIndex: 0, offset: t / 1000 });
    clock.advance(5_000);
    await new Promise((r) => setImmediate(r));
    if (calls.length > 0 && pushedAt < 0) pushedAt = t + 5_000;
  }
  assert.ok(pushedAt > 0 && pushedAt <= PUSH_MAX_WAIT_MS, `pushed at ${pushedAt}`);

  // Quiet period: exactly one trailing push.
  const before = calls.length;
  session.schedulePush({ chapterIndex: 1, offset: 3 });
  clock.advance(PUSH_DEBOUNCE_MS - 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, before);
  clock.advance(1);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, before + 1);

  // flush() sends pending work immediately with keepalive.
  session.schedulePush({ chapterIndex: 1, offset: 20 });
  await session.flush({ keepalive: true });
  assert.equal(calls.at(-1)!.keepalive, true);
  assert.equal(clock.pending(), 0);
});
