import test from 'node:test';
import assert from 'node:assert/strict';

import { BookOrbitClient, BookOrbitTracker, MAX_PAGE_SECONDS, type DeviceInfo } from '../src/bookorbit.ts';

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

function fake(respond: (c: Call) => { status: number; body?: unknown; raw?: BodyInit }) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const r = respond(call);
    return new Response(r.raw ?? (r.body === undefined ? null : JSON.stringify(r.body)), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const BASE = 'https://bookorbit.example.org/api/v1/koreader';
const DEVICE: DeviceInfo = { deviceId: 'A'.repeat(32), deviceModel: 'Even G2', pluginVersion: 'g2-1.7.0' };
const client = (impl: typeof fetch) => new BookOrbitClient({ server: BASE, username: 'u', userkey: 'k'.repeat(32), fetchImpl: impl });

test('listBooks asks for EPUBs with auth headers and maps the page', async () => {
  const { impl, calls } = fake(() => ({
    status: 200,
    body: {
      items: [
        { id: 1, title: 'Alice', authors: ['Lewis Carroll'], seriesName: null, progressPercentage: 16.5, readStatus: 'reading', formats: ['epub'], lastReadAt: null },
        { id: 'bad' },
      ],
      total: 1, page: 2, hasNext: true,
    },
  }));
  const page = await client(impl).listBooks({ q: ' alice ', page: 2 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/v1/koreader/plugin/catalog/books');
  assert.equal(url.searchParams.get('format'), 'epub');
  assert.equal(url.searchParams.get('q'), 'alice');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(calls[0].headers['x-auth-user'], 'u');
  assert.equal(calls[0].headers.Accept, 'application/json');
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].progressPercentage, 16.5);
  assert.equal(page.hasNext, true);
});

test('epubFile prefers the primary original EPUB', async () => {
  const { impl } = fake(() => ({
    status: 200,
    body: {
      files: [
        { id: 9, format: 'pdf', role: 'primary', downloadVariant: 'original' },
        { id: 7, format: 'epub', role: 'alternate', downloadVariant: 'original' },
        { id: 5, format: 'EPUB', role: 'primary', downloadVariant: 'audioless_epub' },
        { id: 3, format: 'epub', role: 'primary', downloadVariant: 'original', sizeBytes: 1000 },
      ],
    },
  }));
  assert.equal((await client(impl).epubFile(1))?.id, 3);
  const none = fake(() => ({ status: 200, body: { files: [{ id: 9, format: 'pdf' }] } }));
  assert.equal(await client(none.impl).epubFile(1), null);
});

test('download returns the bytes; login errors are explicit', async () => {
  const { impl } = fake(() => ({ status: 200, raw: new Uint8Array([0x50, 0x4b, 3, 4]) }));
  const seen: Array<[number, number | null]> = [];
  const bytes = new Uint8Array(await client(impl).download(3, { expectedBytes: 4, onProgress: (r, t) => seen.push([r, t]) }));
  assert.deepEqual([...bytes], [0x50, 0x4b, 3, 4]);
  assert.deepEqual(seen.at(-1), [4, 4]);
  const denied = fake(() => ({ status: 401, body: { message: 'Invalid credentials' } }));
  await assert.rejects(client(denied.impl).listBooks(), /rejected the login/);
});

test('matchCheck, page stats and read status send the plugin payloads', async () => {
  const { impl, calls } = fake((c) => {
    if (c.url.endsWith('/plugin/match-check')) return { status: 201, body: { matches: [{ hash: 'h1', bookId: 42, bookFileId: 1 }] } };
    return { status: 200, body: {} };
  });
  const c = client(impl);
  assert.equal((await c.matchCheck(['h1', 'h2'], DEVICE)).get('h1'), 42);
  assert.deepEqual(calls[0].body, { ...DEVICE, hashes: ['h1', 'h2'] });
  await c.uploadPageStats(DEVICE, [{ hash: 'h1', events: [{ page: 3, startTime: 100, durationSeconds: 30, totalPages: 50 }] }]);
  assert.deepEqual(calls[1].body.books, [{ hash: 'h1', events: [{ page: 3, startTime: 100, durationSeconds: 30, totalPages: 50 }] }]);
  await c.setReadStatus(42, 'read');
  assert.equal(calls[2].method, 'PUT');
  assert.ok(calls[2].url.endsWith('/plugin/catalog/books/42/read-status'));
  assert.deepEqual(calls[2].body, { status: 'read' });
});

test('tracker records page time like KOReader (skip glances, cap idle) and marks the end read once', async () => {
  let now = 1_000_000;
  const { impl, calls } = fake((c) => {
    if (c.url.endsWith('/plugin/match-check')) return { status: 201, body: { matches: [{ hash: 'h1', bookId: 7 }] } };
    return { status: 200, body: {} };
  });
  const tracker = new BookOrbitTracker({ client: client(impl), hash: 'h1', device: DEVICE, now: () => now });
  tracker.pageShown(1, 3); now += 2_000;        // glance: dropped
  tracker.pageShown(2, 3); now += 40_000;       // read 40 s
  tracker.pageShown(2, 3);                      // same page re-render: no new event
  now += 600_000;                               // idle 10 min on page 2
  tracker.pause();
  assert.equal(tracker.pendingEvents, 1);
  tracker.pageShown(3, 3);                      // last page: a glimpse is not "finished"
  assert.ok(!calls.some((c) => c.url.endsWith('/read-status')));
  now += 30_000;                                // ...staying on it is
  tracker.pause();
  await new Promise((r) => setTimeout(r, 0));
  await tracker.flush();
  const stats = calls.find((c) => c.url.endsWith('/plugin/page-stats'))!;
  assert.deepEqual(stats.body.books[0].events, [
    { page: 2, startTime: 1_002, durationSeconds: MAX_PAGE_SECONDS, totalPages: 3 },
    { page: 3, startTime: 1_642, durationSeconds: 30, totalPages: 3 },
  ]);
  assert.ok(calls.some((c) => c.url.endsWith('/books/7/read-status') && c.body.status === 'read'));
  tracker.pageShown(2, 3);
  tracker.pageShown(3, 3); now += 30_000; tracker.pause();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.filter((c) => c.url.endsWith('/read-status')).length, 1, 'only once');
  // Not before the opening sync settled.
  const early = new BookOrbitTracker({ client: client(impl), hash: 'h9', device: DEVICE, now: () => now });
  early.pageShown(3, 3, false, false); now += 30_000; early.pause();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.filter((c) => c.url.endsWith('/read-status')).length, 1);
});

test('tracker keeps a failed batch for the next flush', async () => {
  let now = 0;
  let fail = true;
  const { impl, calls } = fake(() => (fail ? { status: 500, body: { message: 'down' } } : { status: 200, body: {} }));
  const errors: unknown[] = [];
  const tracker = new BookOrbitTracker({ client: client(impl), hash: 'h', device: DEVICE, now: () => now, onError: (e) => errors.push(e) });
  tracker.pageShown(1, 9); now += 10_000; tracker.pause();
  await tracker.flush();
  assert.equal(errors.length, 1);
  assert.equal(tracker.pendingEvents, 1);
  fail = false;
  await tracker.flush();
  assert.equal(tracker.pendingEvents, 0);
  assert.equal(calls.length, 2);
});

test('download rejects truncated and non-EPUB files, retries a dropped connection once', async () => {
  const short = fake(() => ({ status: 200, raw: new Uint8Array([0x50, 0x4b, 3, 4]) }));
  await assert.rejects(client(short.impl).download(3, { expectedBytes: 10 }), /incomplete/);
  assert.equal(short.calls.length, 2, 'incomplete download retried once');
  const html = fake(() => ({ status: 200, raw: '<html>login</html>' }));
  await assert.rejects(client(html.impl).download(3), /not an EPUB/);
  let n = 0;
  const flaky = (async () => {
    n++;
    if (n === 1) throw new TypeError('network down');
    return new Response(new Uint8Array([0x50, 0x4b, 3, 4]), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal((await client(flaky).download(3)).byteLength, 4);
  assert.equal(n, 2);
  const missing = fake(() => ({ status: 404, body: { message: 'File not found' } }));
  await assert.rejects(client(missing.impl).download(3), /File not found/);
  assert.equal(missing.calls.length, 1, 'HTTP errors are not retried');
});

test('download aborts a stalled stream', async () => {
  const impl = (async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([0x50, 0x4b])); /* then nothing */ },
  }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(client(impl).download(3, { stallMs: 50 }), /stalled/);
});

test('failed reading-time uploads survive the tracker being replaced', async () => {
  let now = 0;
  let fail = true;
  const { impl, calls } = fake(() => (fail ? { status: 503, body: {} } : { status: 200, body: {} }));
  const c = new BookOrbitClient({ server: BASE, username: 'outbox-user', userkey: 'k'.repeat(32), fetchImpl: impl });
  const a = new BookOrbitTracker({ client: c, hash: 'book-a', device: DEVICE, now: () => now });
  a.pageShown(1, 9); now += 30_000; a.pause();
  await a.flush(); // fails
  // Book switch: a new tracker for another book; its flush carries book A too.
  fail = false;
  const b = new BookOrbitTracker({ client: c, hash: 'book-b', device: DEVICE, now: () => now });
  b.pageShown(4, 9); now += 20_000; b.pause();
  await b.flush();
  const last = calls.at(-1)!.body.books.map((x: any) => x.hash).sort();
  assert.deepEqual(last, ['book-a', 'book-b']);
  assert.equal(a.pendingEvents + b.pendingEvents, 0);
});

test('a download HTTP error does not wait for its body', async () => {
  const impl = (async () => new Response(new ReadableStream({ start() { /* body never arrives */ } }), { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(client(impl).download(3, { stallMs: 50 }), /HTTP 503/);
});

test('a download larger than announced is rejected', async () => {
  const impl = (async () => new Response(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]), {
    status: 200, headers: { 'content-length': '4' },
  })) as unknown as typeof fetch;
  // Node's Response normalises content-length to the real body, so pass the expectation directly.
  await assert.rejects(client(impl).download(3, { expectedBytes: 4 }), /larger than announced|incomplete/);
});

test('flush drains a large backlog in several requests', async () => {
  let now = 0;
  let fail = true;
  const { impl, calls } = fake(() => (fail ? { status: 503, body: {} } : { status: 200, body: {} }));
  const c = new BookOrbitClient({ server: BASE, username: 'drain-user', userkey: 'k'.repeat(32), fetchImpl: impl });
  const t = new BookOrbitTracker({ client: c, hash: 'big', device: DEVICE, now: () => now });
  for (let p = 1; p <= 300; p++) { t.pageShown(p, 1000); now += 10_000; }
  t.pause();
  await t.flush(); // fails, backlog kept (bounded)
  assert.equal(t.pendingEvents, 300);
  fail = false;
  const before = calls.length;
  await t.flush();
  assert.equal(t.pendingEvents, 0);
  assert.equal(calls.length - before, 1);
  const t2 = new BookOrbitTracker({ client: c, hash: 'big2', device: DEVICE, now: () => now });
  fail = true;
  for (let p = 1; p <= 300; p++) { t2.pageShown(p, 1000); now += 10_000; }
  t2.pause();
  t.pageShown(1, 9); now += 10_000; t.pause(); // a second book's events too
  await t2.flush();
  fail = false;
  const mark = calls.length;
  await t2.flush();
  assert.equal(t2.pendingEvents + t.pendingEvents, 0);
  assert.ok(calls.length - mark >= 1);
});

test('the reading-time outbox persists and is restored by a new run', async () => {
  let saved = '';
  const storage = { load: async () => saved, save: async (raw: string) => { saved = raw; } };
  await BookOrbitTracker.useStorage(storage);
  let now = 0;
  const { impl } = fake(() => ({ status: 503, body: {} }));
  const c = new BookOrbitClient({ server: BASE, username: 'persist-user', userkey: 'k'.repeat(32), fetchImpl: impl });
  const t = new BookOrbitTracker({ client: c, hash: 'p1', device: DEVICE, now: () => now });
  t.pageShown(1, 5); now += 30_000; t.pause();
  await t.flush(true); // offline; keepalive flush writes the outbox first
  await BookOrbitTracker.persist(true);
  assert.match(saved, /persist-user/);
  // "New run": restore from storage into a fresh outbox map.
  (BookOrbitTracker as any).outboxes = new Map();
  await BookOrbitTracker.useStorage(storage);
  const t2 = new BookOrbitTracker({ client: c, hash: 'p1', device: DEVICE, now: () => now });
  assert.equal(t2.pendingEvents, 1);
});

test('catalog pages are capped to the requested size and sane values', async () => {
  // 10k rows (under the 2 MB JSON cap), the first with a huge title and author list.
  const items = Array.from({ length: 10_000 }, (_, i) => ({
    id: i + 1,
    title: i === 0 ? 'T'.repeat(5000) : `Book ${i}`,
    authors: i === 0 ? Array(50).fill('A') : ['A'],
    progressPercentage: i === 0 ? null : 250,
  }));
  const { impl } = fake(() => ({ status: 200, body: { items, total: 10_000, page: 1, hasNext: true } }));
  const page = await client(impl).listBooks({ size: 20 });
  assert.equal(page.items.length, 20);
  assert.ok(page.items[0].title.length <= 300);
  assert.ok(page.items[0].authors.length <= 10);
  assert.equal(page.items[0].progressPercentage, null);
  assert.equal(page.items[1].progressPercentage, 100);
  // Over 2 MB in total: rejected outright instead of parsed.
  const fat = fake(() => ({ status: 200, body: { items: Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, title: 'x'.repeat(5000) })) } }));
  await assert.rejects(client(fat.impl).listBooks(), /too large/);
});

test('a disposed tracker stops uploading with its login', async () => {
  let now = 0;
  const { impl, calls } = fake(() => ({ status: 503, body: {} }));
  const c = new BookOrbitClient({ server: BASE, username: 'dispose-user', userkey: 'k'.repeat(32), fetchImpl: impl });
  const t = new BookOrbitTracker({ client: c, hash: 'd1', device: DEVICE, now: () => now });
  t.pageShown(1, 5); now += 30_000; t.pause();
  t.dispose();
  await t.flush();
  t.pageShown(2, 5);
  assert.equal(calls.length, 0);
  assert.equal(t.pendingEvents, 1, 'events stay queued for that account');
});

test('round 3: stats batches hold <= 50 books; unmatched books are dropped and untracked', async () => {
  let now = 0;
  const bodies: any[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    const unmatched = body.books.filter((b: any) => b.hash.startsWith('x')).map((b: any) => b.hash);
    return new Response(JSON.stringify({ results: [], unmatched }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new BookOrbitClient({ server: BASE, username: 'batch-user', userkey: 'k'.repeat(32), fetchImpl: impl });
  for (let i = 0; i < 51; i++) {
    const t = new BookOrbitTracker({ client: c, hash: `${i === 0 ? 'x' : 'h'}${i}`, device: DEVICE, now: () => now });
    t.pageShown(1, 9); now += 10_000; t.pause();
  }
  await BookOrbitTracker.drain(c, DEVICE);
  assert.ok(bodies.every((b) => b.books.length <= 50));
  assert.equal(BookOrbitTracker.hasPending(c.accountKey), false);
  // The unmatched book is no longer tracked.
  const again = new BookOrbitTracker({ client: c, hash: 'x0', device: DEVICE, now: () => now });
  again.pageShown(2, 9); now += 10_000; again.pause();
  assert.equal(again.pendingEvents, 0);
});

test('round 3: fast Flow pages (< 5 s) still count while Flow plays', () => {
  let now = 0;
  const { impl } = fake(() => ({ status: 200, body: {} }));
  const c = new BookOrbitClient({ server: BASE, username: 'flow-user', userkey: 'k'.repeat(32), fetchImpl: impl });
  const t = new BookOrbitTracker({ client: c, hash: 'f1', device: DEVICE, now: () => now });
  for (let p = 1; p <= 5; p++) { t.pageShown(p, 50, true); now += 4_000; }
  t.pause();
  assert.equal(t.pendingEvents, 5);
  const paged = new BookOrbitTracker({ client: c, hash: 'f2', device: DEVICE, now: () => now });
  for (let p = 1; p <= 5; p++) { paged.pageShown(p, 50, false); now += 4_000; }
  paged.pause();
  assert.equal(paged.pendingEvents, 0, 'paged skimming still ignored');
});
