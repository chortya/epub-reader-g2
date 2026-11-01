import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';

import {
  KosyncClient,
  KosyncError,
  decidePull,
  documentDigest,
  isBookOrbitReset,
  isKosyncLoggedIn,
  loadKosyncSettings,
  makeDeviceId,
  normalizeServerUrl,
  parseKosyncSettings,
  roundPercentage,
  saveKosyncSettings,
  KOSYNC_STORAGE_KEY,
  bookOrbitAddress,
  bookOrbitKosyncBase,
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
  provider: 'kosync',
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
  const notFound = new KosyncClient({ server: SETTINGS.server, fetchImpl: fakeFetch(() => ({ status: 404 })).impl });
  assert.equal(await notFound.getProgress('never-synced'), null, '404 = no progress (Calibre-Web & co.)');
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

test('BookOrbit address <-> kosync base', () => {
  assert.equal(bookOrbitKosyncBase('https://bookorbit.home.example.org/'), 'https://bookorbit.home.example.org/api/v1/koreader');
  assert.equal(bookOrbitKosyncBase('https://b.example.org/api/v1/koreader'), 'https://b.example.org/api/v1/koreader');
  assert.equal(bookOrbitKosyncBase('nonsense'), null);
  assert.equal(bookOrbitAddress('https://b.example.org/api/v1/koreader'), 'https://b.example.org');
  assert.equal(parseKosyncSettings(JSON.stringify({ provider: 'bookorbit' }))!.provider, 'bookorbit');
  assert.equal(parseKosyncSettings(JSON.stringify({ provider: 'other' }))!.provider, 'kosync');
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

test('decidePull: newer position wins; without times, forward only (explicit sync applies)', () => {
  const remote = { document: 'd', progress: 'p', percentage: 0.5, device_id: 'OTHER', timestamp: 2_000 };
  assert.equal(decidePull(null, null, 'ME', false), 'none');
  assert.equal(decidePull({ ...remote, device_id: 'ME' }, null, 'ME', true), 'ownDevice');
  assert.equal(decidePull(remote, { percentage: 0.5, savedAtMs: 0 }, 'ME', false), 'same');
  assert.equal(decidePull(remote, null, 'ME', false), 'apply');
  assert.equal(decidePull(remote, { percentage: 0.2, savedAtMs: 1_000_000 }, 'ME', false), 'apply');
  assert.equal(decidePull(remote, { percentage: 0.8, savedAtMs: 3_000_000 }, 'ME', false), 'older');
  // Explicit sync with known times still lets the newer side win (caller pushes ours).
  assert.equal(decidePull(remote, { percentage: 0.8, savedAtMs: 3_000_000 }, 'ME', true), 'older');
  assert.equal(decidePull(remote, { percentage: 0.8, savedAtMs: null }, 'ME', true), 'apply');
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

test('pushes are serialized and a superseded queued push is dropped', async () => {
  const releases: Array<() => void> = [];
  const order: number[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    await new Promise<void>((r) => releases.push(r));
    order.push(body.percentage);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const client = new KosyncClient({ server: SETTINGS.server, fetchImpl: impl });
  const session = new KosyncSession({ book: book(), filename: null, settings: SETTINGS, client, parseBody });
  const b = book();
  const first = session.push({ chapterIndex: 0, offset: 0 });
  await new Promise((r) => setImmediate(r));
  const second = session.push({ chapterIndex: 1, offset: 0 }); // queued behind the first
  const third = session.push({ chapterIndex: 1, offset: b.chapters[1].text.length - 1 }); // supersedes the second
  while (releases.length < 1) await new Promise((r) => setImmediate(r));
  releases.shift()!();
  while (releases.length < 1) await new Promise((r) => setImmediate(r));
  releases.shift()!();
  assert.deepEqual(await Promise.all([first, second, third]), [true, false, true]);
  assert.equal(order.length, 2);
  assert.ok(order[0] < order[1], 'older position never lands last');
});

test('pull reports "same" when remote and local land on the same paragraph', async () => {
  const b = book();
  const second = b.chapters[0].text.indexOf('Second');
  const { impl } = fakeFetch(() => ({
    status: 200,
    // KOReader's page-based percentage differs from ours for the same place.
    body: { document: 'x', progress: '/body/DocFragment[2]/body/p[2]/text().5', percentage: 0.31, device_id: 'KOBO', timestamp: 10_000 },
  }));
  const client = new KosyncClient({ server: SETTINGS.server, fetchImpl: impl });
  const session = new KosyncSession({ book: b, filename: null, settings: SETTINGS, client, parseBody });
  const result = await session.pull({ location: { chapterIndex: 0, offset: second + 2 }, savedAtMs: 1 }, false);
  assert.equal(result.decision, 'same');
});

test('upload order holds across sessions of the same book, and flush waits for an upload in flight', async () => {
  const releases: Array<() => void> = [];
  const landed: number[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    await new Promise<void>((r) => releases.push(r));
    landed.push(body.percentage);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const client = new KosyncClient({ server: SETTINGS.server, fetchImpl: impl });
  const mk = () => new KosyncSession({ book: book(), filename: null, settings: SETTINGS, client, parseBody });
  const oldSession = mk();
  const first = oldSession.push({ chapterIndex: 0, offset: 0 });
  while (releases.length < 1) await new Promise((r) => setImmediate(r));
  // Book reopened: a new session pushes a newer position while the old PUT hangs.
  const newSession = mk();
  const second = newSession.push({ chapterIndex: 1, offset: 5 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(releases.length, 1, 'the new PUT waits for the old one');
  let flushed = false;
  const flushing = newSession.flush().then(() => { flushed = true; });
  releases.shift()!();
  while (releases.length < 1) await new Promise((r) => setImmediate(r));
  assert.equal(flushed, false, 'flush waits for the upload in flight');
  releases.shift()!();
  await Promise.all([first, second, flushing]);
  assert.equal(landed.length, 2);
  assert.ok(landed[0] < landed[1], 'newer position lands last');
});

test('markSynced drops a push that was still preparing (locator await)', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
  const client = new KosyncClient({ server: SETTINGS.server, fetchImpl: impl });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slowBook: Book = { ...book(), loadChapterXhtml: async (i) => { await gate; return book().loadChapterXhtml!(i); } };
  const session = new KosyncSession({ book: slowBook, filename: null, settings: SETTINGS, client, parseBody });
  const pushing = session.push({ chapterIndex: 0, offset: 0 });
  await new Promise((r) => setImmediate(r));
  const marking = session.markSynced({ chapterIndex: 1, offset: 0 });
  release();
  assert.equal(await pushing, false);
  await marking;
  assert.equal(calls.length, 0);
});

test('decidePull: clock skew window and measured offset', () => {
  const remote = { document: 'd', progress: 'p', percentage: 0.6, device_id: 'KOBO', timestamp: 43_260 }; // 12:01 server
  const local = { percentage: 0.4, savedAtMs: 43_380_000 }; // phone says 12:03, 3 min fast
  // Unknown offset: 2 min apart is within the 5 min window -> order unknown,
  // so even an explicit sync only moves forward (never discards pages read).
  assert.equal(decidePull(remote, local, 'ME', true), 'apply');
  assert.equal(decidePull({ ...remote, percentage: 0.2 }, local, 'ME', true), 'older');
  // Automatic: inside the window, only forward.
  assert.equal(decidePull(remote, local, 'ME', false), 'apply');
  assert.equal(decidePull({ ...remote, percentage: 0.2 }, local, 'ME', false), 'older');
  // Offset measured (phone 3 min fast): local is really 12:00; a remote save at
  // 12:02 is clearly newer even though the phone's clock says otherwise.
  assert.equal(decidePull({ ...remote, percentage: 0.2, timestamp: 43_320 }, local, 'ME', false, -180_000), 'apply');
  // Far apart: plain ordering.
  assert.equal(decidePull({ ...remote, timestamp: 40_000 }, local, 'ME', true), 'older');
});

test('updateProgress learns the server clock offset; stalled JSON bodies time out', async () => {
  const serverNow = Math.floor(Date.now() / 1000) + 600; // server 10 min ahead
  const { impl } = fakeFetch(() => ({ status: 200, body: { document: 'd', timestamp: serverNow } }));
  const c = new KosyncClient({ server: SETTINGS.server, fetchImpl: impl });
  await c.updateProgress({ document: 'd', progress: 'p', percentage: 0.1 }, 'X');
  assert.ok(Math.abs(c.clockOffsetMs! - 600_000) < 2_000, String(c.clockOffsetMs));
  const stalled = (async () => new Response(new ReadableStream({ start(ctrl) { ctrl.enqueue(new TextEncoder().encode('{"perc')); } }), { status: 200 })) as unknown as typeof fetch;
  const slow = new KosyncClient({ server: 'https://other.example.com', fetchImpl: stalled, timeoutMs: 50 });
  const t0 = Date.now();
  // A stalled body is an error, never "no progress" (which would push over it).
  await assert.rejects(slow.getProgress('d'), /timed out/);
  assert.ok(Date.now() - t0 < 2_000);
  const garbage = new KosyncClient({ server: 'https://other.example.com', fetchImpl: (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch });
  await assert.rejects(garbage.getProgress('d'), /invalid response/);
});

test('pull: an exact remote position pages away in the same paragraph is not "same"', async () => {
  const long = 'word '.repeat(900).trim(); // one ~4,500-char paragraph
  const xhtml = `<html><body><p>${long}</p></body></html>`;
  const b: Book = {
    title: 'L', partialMd5: 'e'.repeat(32),
    chapters: [{ title: 'L', text: long, spineIndex: 0 }],
    loadChapterXhtml: async () => xhtml,
  };
  const { impl } = fakeFetch(() => ({ status: 200, body: { document: 'x', progress: '/body/DocFragment[1]/body/p/text().3000', percentage: 0.66, device_id: 'KOBO', timestamp: 2_000_000_000 } }));
  const session = new KosyncSession({ book: b, filename: null, settings: SETTINGS, client: new KosyncClient({ server: SETTINGS.server, fetchImpl: impl }), parseBody });
  const r = await session.pull({ location: { chapterIndex: 0, offset: 0 }, savedAtMs: 1 }, false);
  assert.equal(r.decision, 'apply');
  assert.equal(r.target?.offset, 3000);
  const near = await session.pull({ location: { chapterIndex: 0, offset: 2950 }, savedAtMs: 1 }, false);
  assert.equal(near.decision, 'same');
});

test('a failed push is kept and retried by the next flush', async () => {
  let fail = true;
  const { impl, calls } = fakeFetch(() => (fail ? { status: 503, body: {} } : { status: 200, body: {} }));
  const clock = fakeTimers();
  const session = new KosyncSession({ book: book(), filename: null, settings: SETTINGS, client: new KosyncClient({ server: SETTINGS.server, fetchImpl: impl }), parseBody, timers: clock.timers });
  session.schedulePush({ chapterIndex: 0, offset: 5 });
  await session.flush().catch(() => {});
  assert.equal(session.hasUnsentPosition, true);
  fail = false;
  await session.flush();
  assert.equal(session.hasUnsentPosition, false);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 2);
});

test('BookOrbit reset marker always wins and is recognised strictly', () => {
  const reset = { document: 'd', progress: '/body/DocFragment[1]/body', percentage: 0, device: 'web', device_id: 'bookorbit-web', timestamp: 1 };
  assert.equal(isBookOrbitReset(reset), true);
  assert.equal(isBookOrbitReset({ ...reset, device_id: 'KOBO' }), false);
  assert.equal(isBookOrbitReset({ ...reset, progress: '/body/DocFragment[12]/body' }), false);
  assert.equal(isBookOrbitReset({ ...reset, percentage: 0.4 }), false);
  // Old timestamp, local far ahead and newer: the reset still applies.
  assert.equal(decidePull(reset, { percentage: 0.8, savedAtMs: 9_999_999_999 }, 'ME', false), 'apply');
  assert.equal(decidePull(reset, { percentage: 0.005, savedAtMs: 1 }, 'ME', false), 'same');
});

test('acknowledgeReset reports DocFragment[1] at 0% even when the first chapter is a later fragment', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
  const session = new KosyncSession({ book: book(), filename: null, settings: SETTINGS, client: new KosyncClient({ server: 'https://reset.example.com', fetchImpl: impl }), parseBody });
  assert.equal(book().chapters[0].spineIndex, 1, 'fixture: chapter 0 is DocFragment[2]');
  await session.acknowledgeReset();
  assert.deepEqual([calls[0].body.progress, calls[0].body.percentage], ['/body/DocFragment[1]/body', 0]);
});

test('credentials never follow redirects and only travel over https (or loopback)', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: { authorized: 'OK' } }));
  let seenRedirect: unknown;
  const spy = (async (url: string, init: RequestInit) => { seenRedirect = init.redirect; return impl(url, init); }) as unknown as typeof fetch;
  await new KosyncClient({ server: SETTINGS.server, username: 'u', userkey: 'k', fetchImpl: spy }).authorize();
  assert.equal(seenRedirect, 'error');
  assert.equal(calls.length, 1);
  assert.equal(normalizeServerUrl('http://books.example.org'), null);
  assert.equal(normalizeServerUrl('http://192.168.1.5:3005'), null);
  assert.equal(normalizeServerUrl('http://127.0.0.1:3106'), 'http://127.0.0.1:3106');
  assert.equal(normalizeServerUrl('http://localhost:8080/kosync'), 'http://localhost:8080/kosync');
  assert.equal(normalizeServerUrl('https://user:pw@books.example.org'), null);
});

test('oversized JSON bodies are rejected', async () => {
  const huge = JSON.stringify({ percentage: 0.1, progress: 'x'.repeat(3 * 1024 * 1024) });
  const c = new KosyncClient({ server: 'https://big.example.com', fetchImpl: (async () => new Response(huge, { status: 200 })) as unknown as typeof fetch });
  await assert.rejects(c.getProgress('d'), /too large/);
});
