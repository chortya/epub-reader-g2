# ePub Reader relay

A small Cloudflare Worker that the app's developer runs. Packaged builds of
the reader send their network requests here.

## Why it exists

Even Hub apps can only reach origins listed in the `app.json` network
whitelist, and the WebView still applies normal CORS rules. Two services the
reader needs fail one or both of those checks:

- **Project Gutenberg** sends no CORS headers.
- **KOReader sync servers** (`koreader-sync-server` and compatible) send no
  CORS headers either. Each user also picks their own server, so a fixed
  whitelist can't list it.

The relay is one fixed origin that sits in the whitelist and adds the CORS
headers. Before this, Gutenberg went through `api.codetabs.com`. That public
proxy goes down often, and Even's docs advise against it.

## Routes

| Route | Upstream |
|---|---|
| `GET /gutenberg/top` | `https://www.gutenberg.org/browse/scores/top`, cached for 6 h |
| `GET /gutenberg/epub/<id>` | `https://www.gutenberg.org/cache/epub/<id>/pg<id>[-images[-3]].epub`, cached for 7 days |
| `POST /kosync/users/create`, `GET /kosync/users/auth`, `PUT /kosync/syncs/progress`, `GET /kosync/syncs/progress/<doc>` | the server named in the `X-Kosync-Server` header |
| `GET /health` | – |

The relay is kept deliberately narrow, so it can't be used as an open proxy:

- Only the four kosync calls above are forwarded.
- The target must be a public `https://` address with a DNS name. IP literals,
  `localhost`, `.local`, `.internal`, credentials and query strings are rejected.
- Request bodies are capped at 16 KB.
- Upstream redirects aren't followed.
- Only `Accept`, `Content-Type`, `x-auth-user` and `x-auth-key` are forwarded,
  and `Set-Cookie` is stripped from responses.
- Nothing is stored. The Worker doesn't log request headers or bodies.

## Deploy

```bash
cd relay
npx wrangler login            # once, opens the Cloudflare login in a browser
npx wrangler deploy           # prints https://epub-reader-relay.<subdomain>.workers.dev
```

To use your own domain instead, uncomment `routes` in `wrangler.toml`, set
the hostname, and deploy again.

Then point the app at the relay and build the package:

1. Put the relay origin, and nothing else, in the `app.json` network whitelist.
2. Run `VITE_RELAY_ORIGIN=https://<relay origin> npm run pack`.

`npm run pack` fails if the variable is missing or doesn't match the whitelist
(`scripts/check-release.mjs`).

## Test

```bash
npm test                      # tests/relay.test.ts covers routing and filters with a fake upstream
curl https://<relay origin>/health
curl -s https://<relay origin>/gutenberg/top | head
```

## Privacy

The relay sees what a KOReader sync server sees: the kosync username, the
MD5-derived key, the document hash, the position and the device name. It
sees them only in transit. List the relay origin in the privacy policy (see
`../PRIVACY.md`).
