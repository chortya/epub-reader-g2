import test from 'node:test';
import assert from 'node:assert/strict';

// @ts-ignore — plain-JS Cloudflare Worker module
import { handle, parseKosyncTarget } from '../relay/src/worker.js';

type Seen = { url: string; init: any };

function upstream(respond: (url: string, init: any) => Response) {
  const seen: Seen[] = [];
  const impl = async (url: string, init: any) => {
    seen.push({ url, init });
    return respond(url, init);
  };
  return { impl, seen };
}

const req = (path: string, init: RequestInit = {}) => new Request(`https://relay.test${path}`, init);

test('preflight and health answer with CORS', async () => {
  const pre = await handle(req('/kosync/users/auth', { method: 'OPTIONS' }));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /x-auth-key/);
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /X-Kosync-Server/);
  assert.equal((await handle(req('/health'))).status, 200);
});

test('kosync target must be a public https origin', () => {
  assert.equal(parseKosyncTarget('https://sync.koreader.rocks'), 'https://sync.koreader.rocks');
  assert.equal(parseKosyncTarget('https://example.org/kosync/'), 'https://example.org/kosync');
  for (const bad of [
    null, '', 'http://sync.example.org', 'https://localhost', 'https://10.0.0.1', 'https://[::1]',
    'https://nas.local', 'https://user:pw@example.org', 'https://example.org/?x=1', 'not a url',
    'https://localhost.', 'https://metadata.internal.', 'https://nas.local.', 'https://router.lan',
    'https://example.org:8443', 'https://0x7f000001',
  ]) {
    assert.equal(parseKosyncTarget(bad as any), null, String(bad));
  }
});

test('kosync calls are forwarded with auth headers only, and responses get CORS', async () => {
  const { impl, seen } = upstream(() => new Response('{"authorized":"OK"}', {
    status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' },
  }));
  const res = await handle(req('/kosync/users/auth', {
    headers: {
      'X-Kosync-Server': 'https://sync.example.org/base',
      'x-auth-user': 'reader',
      'x-auth-key': 'k',
      Cookie: 'secret=1',
      Accept: 'application/vnd.koreader.v1+json',
    },
  }), impl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(seen[0].url, 'https://sync.example.org/base/users/auth');
  assert.equal(seen[0].init.headers['x-auth-user'], 'reader');
  assert.equal(seen[0].init.headers['x-auth-key'], 'k');
  assert.equal(seen[0].init.headers.cookie, undefined);
  assert.equal(seen[0].init.redirect, 'manual');

  await handle(req('/kosync/syncs/progress', {
    method: 'PUT',
    headers: { 'X-Kosync-Server': 'https://sync.example.org', 'content-type': 'application/json' },
    body: JSON.stringify({ document: 'd', progress: 'p', percentage: 0.5 }),
  }), impl);
  assert.equal(seen[1].init.method, 'PUT');
  assert.deepEqual(JSON.parse(seen[1].init.body), { document: 'd', progress: 'p', percentage: 0.5 });
});

test('kosync relay rejects other paths, bad targets, big bodies and redirects', async () => {
  const { impl, seen } = upstream(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere' } }));
  const target = { 'X-Kosync-Server': 'https://sync.example.org' };
  assert.equal((await handle(req('/kosync/admin', { headers: target }), impl)).status, 404);
  assert.equal((await handle(req('/kosync/users/auth', { method: 'DELETE', headers: target }), impl)).status, 404);
  assert.equal((await handle(req('/kosync/users/auth', { headers: { 'X-Kosync-Server': 'https://127.0.0.1' } }), impl)).status, 400);
  assert.equal((await handle(req('/kosync/users/create', {
    method: 'POST', headers: { ...target, 'content-type': 'application/json' }, body: 'x'.repeat(20_000),
  }), impl)).status, 413);
  assert.equal((await handle(req('/kosync/users/create', {
    method: 'POST', headers: { ...target, 'content-type': 'text/plain' }, body: '{}',
  }), impl)).status, 415);
  // Document ids are MD5 hex only: no encoded path segments reach the server.
  assert.equal((await handle(req('/kosync/syncs/progress/..%2F..%2Fadmin', { headers: target }), impl)).status, 404);
  assert.equal((await handle(req('/kosync/syncs/progress/' + 'a'.repeat(31) + 'g', { headers: target }), impl)).status, 404);
  assert.equal(seen.length, 0);
  assert.equal((await handle(req('/kosync/users/auth', { headers: target }), impl)).status, 502);
});

test('gutenberg routes fetch fixed URLs only', async () => {
  const { impl, seen } = upstream((url) => {
    if (url.endsWith('/browse/scores/top')) return new Response('<h2 id="books-last1">Top</h2>', { status: 200 });
    if (url.endsWith('/pg84.epub')) return new Response(null, { status: 404 });
    if (url.endsWith('/pg84-images-3.epub')) return new Response('PK', { status: 200, headers: { 'content-length': '2' } });
    return new Response(null, { status: 404 });
  });
  const top = await handle(req('/gutenberg/top'), impl);
  assert.equal(top.status, 200);
  assert.equal(top.headers.get('access-control-allow-origin'), '*');
  assert.match(await top.text(), /books-last1/);

  const epub = await handle(req('/gutenberg/epub/84'), impl);
  assert.equal(epub.status, 200);
  assert.equal(epub.headers.get('content-type'), 'application/epub+zip');
  assert.equal(await epub.text(), 'PK');
  assert.deepEqual(seen.slice(1).map((s) => s.url), [
    'https://www.gutenberg.org/cache/epub/84/pg84.epub',
    'https://www.gutenberg.org/cache/epub/84/pg84-images-3.epub',
  ]);

  assert.equal((await handle(req('/gutenberg/epub/84;rm'), impl)).status, 404);
  assert.equal((await handle(req('/gutenberg/epub/999999'), upstream(() => new Response(null, { status: 404 })).impl)).status, 404);
  assert.equal((await handle(req('/gutenberg/top', { method: 'POST' }), impl)).status, 405);
  assert.equal((await handle(req('/elsewhere'), impl)).status, 404);
});

test('kosync body cap applies to streamed bodies without content-length', async () => {
  const { impl, seen } = upstream(() => new Response('{}', { status: 200 }));
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulled++;
      if (pulled > 100) { controller.close(); return; }
      controller.enqueue(new Uint8Array(1024));
    },
  });
  const res = await handle(new Request('https://relay.test/kosync/syncs/progress', {
    method: 'PUT', headers: { 'X-Kosync-Server': 'https://sync.example.org', 'content-type': 'application/json' }, body: stream, duplex: 'half',
  } as RequestInit), impl);
  assert.equal(res.status, 413);
  assert.ok(pulled < 30, `stopped reading early (read ${pulled} chunks)`);
  assert.equal(seen.length, 0);
});

test('gutenberg EPUB bodies are capped even without Content-Length', async () => {
  // @ts-ignore — plain-JS module
  const { capStream } = await import('../relay/src/worker.js');
  const big = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024)); },
  });
  const capped = new Response(capStream(big, 10 * 1024));
  await assert.rejects(capped.arrayBuffer());
});
