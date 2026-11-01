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
  tracker.pageShown(3, 3);                      // last page -> read status
  await new Promise((r) => setTimeout(r, 0));
  await tracker.flush();
  const stats = calls.find((c) => c.url.endsWith('/plugin/page-stats'))!;
  assert.deepEqual(stats.body.books[0].events, [
    { page: 2, startTime: 1_002, durationSeconds: MAX_PAGE_SECONDS, totalPages: 3 },
  ]);
  assert.ok(calls.some((c) => c.url.endsWith('/books/7/read-status') && c.body.status === 'read'));
  tracker.pageShown(2, 3);
  tracker.pageShown(3, 3);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.filter((c) => c.url.endsWith('/read-status')).length, 1, 'only once');
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
