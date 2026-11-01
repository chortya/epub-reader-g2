/**
 * ePub Reader relay — a Cloudflare Worker the app's developer operates.
 *
 * Even Hub apps may only reach origins whitelisted in app.json, and the
 * WebView enforces CORS. Project Gutenberg and stock KOReader sync servers
 * send no CORS headers, so the app talks to this relay instead:
 *
 *   GET  /gutenberg/top           -> https://www.gutenberg.org/browse/scores/top
 *   GET  /gutenberg/epub/:id      -> the book's EPUB from gutenberg.org
 *   *    /kosync/<kosync path>    -> the user's sync server (X-Kosync-Server)
 *
 * The relay is deliberately narrow: fixed Gutenberg URLs, and only the four
 * kosync API calls, forwarded to a public https origin. It stores nothing
 * and logs no request headers or bodies.
 */

const GUTENBERG = 'https://www.gutenberg.org';
const USER_AGENT = 'ePubReaderRelay/1.0 (+https://github.com/chortya/epub-reader-g2)';
const KOSYNC_ACCEPT = 'application/vnd.koreader.v1+json';
const MAX_KOSYNC_BODY = 16 * 1024;
const MAX_EPUB_BYTES = 50 * 1024 * 1024;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type, x-auth-user, x-auth-key, X-Kosync-Server',
  'Access-Control-Max-Age': '86400',
};

function withCors(response, extra = {}) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries({ ...CORS_HEADERS, ...extra })) headers.set(k, v);
  headers.delete('set-cookie');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** Only https origins with a DNS name (no IP literals, no localhost, no credentials). */
export function parseKosyncTarget(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return null;
  return url.origin + url.pathname.replace(/\/+$/, '');
}

const KOSYNC_ROUTES = [
  { method: 'POST', re: /^\/users\/create$/ },
  { method: 'GET', re: /^\/users\/auth$/ },
  { method: 'PUT', re: /^\/syncs\/progress$/ },
  { method: 'GET', re: /^\/syncs\/progress\/[A-Za-z0-9_.%-]{1,128}$/ },
];

async function handleKosync(request, path, fetchImpl) {
  if (!KOSYNC_ROUTES.some((r) => r.method === request.method && r.re.test(path))) {
    return json(404, { message: 'Unsupported sync call' });
  }
  const target = parseKosyncTarget(request.headers.get('X-Kosync-Server'));
  if (!target) return json(400, { message: 'Sync server must be a public https:// address' });

  const headers = { Accept: KOSYNC_ACCEPT, 'User-Agent': USER_AGENT };
  for (const name of ['content-type', 'x-auth-user', 'x-auth-key']) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  let body;
  if (request.method === 'POST' || request.method === 'PUT') {
    body = await request.text();
    if (body.length > MAX_KOSYNC_BODY) return json(413, { message: 'Request too large' });
  }
  let upstream;
  try {
    upstream = await fetchImpl(`${target}${path}`, { method: request.method, headers, body, redirect: 'manual' });
  } catch {
    return json(502, { message: 'Sync server unreachable' });
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return json(502, { message: 'Sync server redirected; use its final address' });
  }
  return withCors(upstream, { 'Cache-Control': 'no-store' });
}

async function fetchGutenberg(path, fetchImpl, cacheTtl) {
  return fetchImpl(`${GUTENBERG}${path}`, {
    headers: { 'User-Agent': USER_AGENT },
    cf: { cacheTtl, cacheEverything: true },
  });
}

async function handleGutenberg(request, path, fetchImpl) {
  if (request.method !== 'GET') return json(405, { message: 'GET only' });
  if (path === '/top') {
    const res = await fetchGutenberg('/browse/scores/top', fetchImpl, 6 * 3600);
    if (!res.ok) return json(502, { message: `Gutenberg returned ${res.status}` });
    return withCors(new Response(res.body, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=21600' },
    }));
  }
  const m = /^\/epub\/(\d{1,7})$/.exec(path);
  if (m) {
    const id = m[1];
    // The reader shows text only, so the no-images build (smallest) comes first.
    // (/ebooks/<id>.epub* are redirects to these same cache files.)
    const candidates = [
      `/cache/epub/${id}/pg${id}.epub`,
      `/cache/epub/${id}/pg${id}-images-3.epub`,
      `/cache/epub/${id}/pg${id}-images.epub`,
    ];
    for (const candidate of candidates) {
      const res = await fetchGutenberg(candidate, fetchImpl, 7 * 86400);
      const length = Number(res.headers.get('content-length') ?? '0');
      if (res.ok && length <= MAX_EPUB_BYTES) {
        return withCors(new Response(res.body, {
          status: 200,
          headers: {
            'Content-Type': 'application/epub+zip',
            'Cache-Control': 'public, max-age=604800',
            ...(length ? { 'Content-Length': String(length) } : {}),
          },
        }));
      }
    }
    return json(404, { message: 'EPUB not found for this book' });
  }
  return json(404, { message: 'Not found' });
}

export async function handle(request, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (url.pathname.startsWith('/kosync/')) return handleKosync(request, url.pathname.slice('/kosync'.length), fetchImpl);
  if (url.pathname.startsWith('/gutenberg/')) return handleGutenberg(request, url.pathname.slice('/gutenberg'.length), fetchImpl);
  if (url.pathname === '/' || url.pathname === '/health') return json(200, { ok: true, service: 'epub-reader-relay' });
  return json(404, { message: 'Not found' });
}

export default {
  fetch(request) {
    return handle(request);
  },
};
