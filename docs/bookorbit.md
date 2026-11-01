# BookOrbit integration

[BookOrbit](https://github.com/bookorbit/bookorbit) is a self-hosted library server. With the
same KOReader login it gives the reader:

| What | How | BookOrbit route (under `/api/v1/koreader`) |
|---|---|---|
| Progress sync with BookOrbit's web reader and your KOReader devices | the reader's kosync client, unchanged | `users/auth`, `syncs/progress` |
| Library: browse, search, download EPUBs on the phone | `BookOrbitClient` | `plugin/catalog/books`, `…/books/:id`, `…/files/:id/download` |
| Reading time in BookOrbit's statistics | `BookOrbitTracker` (page-stat events like KOReader's statistics plugin) | `plugin/page-stats` |
| "Finished" when the last page is reached | `BookOrbitTracker.markFinished` | `plugin/match-check`, `plugin/catalog/books/:id/read-status` |

These are the routes BookOrbit's own KOReader plugin uses. They were checked against BookOrbit
3.3.0 with a throwaway instance and are not a documented public API, so every call fails soft
(a status message, never a broken reading view).

Books are matched by KOReader's partial-MD5 document hash.
- A book downloaded from BookOrbit is byte-identical to the library file, so it matches
  automatically.
- A book uploaded to the reader by hand matches if it is the same file as in BookOrbit.

## Setup

1. **Create a KOReader login in BookOrbit.** Go to Settings → KOReader and set a username and
   password. The user needs the KOReader sync permission.
2. **Allow the reader through CORS.** BookOrbit sends no CORS headers in production; it answers
   OPTIONS with 404. The Even Hub WebView needs them, so add this to the reverse proxy, limited
   to the KOReader API. Caddy example, as deployed on 2026-11-01:

   ```caddy
   @bookorbit host bookorbit.example.org
   handle @bookorbit {
       @bookorbit_ko_preflight {
           method OPTIONS
           path /api/v1/koreader/*
       }
       handle @bookorbit_ko_preflight {
           header Access-Control-Allow-Origin "*"
           header Access-Control-Allow-Methods "GET, POST, PUT, OPTIONS"
           header Access-Control-Allow-Headers "Accept, Content-Type, x-auth-user, x-auth-key"
           header Access-Control-Max-Age "86400"
           respond 204
       }
       @bookorbit_ko path /api/v1/koreader/*
       header @bookorbit_ko Access-Control-Allow-Origin "*"
       header @bookorbit_ko Access-Control-Expose-Headers "Content-Length, Content-Disposition, ETag"
       reverse_proxy http://bookorbit:3000
   }
   ```

   The KOReader API authenticates with `x-auth-user`/`x-auth-key` headers, never cookies, so a
   wildcard origin grants nothing without the login. The rest of BookOrbit is not affected.
3. **Build with your BookOrbit whitelisted.** Run:

   ```bash
   PERSONAL_ORIGINS=https://bookorbit.example.org npm run pack:personal
   npx evenhub upload epub-reader-personal.ehpk -m "Personal build"
   ```

   Install it from the Even app under Me → Apps → Private builds. Promote it to Beta if you
   want to launch it from the glasses menu.
4. **Log in from the phone.** On the phone page, open Sync server, choose BookOrbit, and enter
   the BookOrbit address and the KOReader login. The BookOrbit library section appears.

The phone must be able to reach BookOrbit. With a private ingress such as `*.home.example.org`,
that means home Wi-Fi or Tailscale. Away from both, the reader works offline and syncs the next
time it can reach the server.

## Public Hub builds

The public app can't whitelist each user's server. Plain kosync goes through the developer relay
(`relay/`). The relay forwards only the four kosync calls, so BookOrbit's library and stats
routes aren't available in public builds yet. A public build would need either:
- the relay extended for those routes, with the user's BookOrbit publicly reachable over https;
- or an opt-in CORS setting in BookOrbit plus a relay-free path.

## Behaviour details

- **Reading time.**
  - Each reading page on screen becomes `{page, startTime, durationSeconds, totalPages}`. Pages
    are numbered across the whole book in the current layout.
  - Pages shown for under 5 s are dropped, and idle time is capped at 120 s, matching KOReader's
    statistics defaults.
  - Events upload 60 s after the first one is queued, after 20 events, and on background, exit or
    book switch. Failed uploads are retried.
- **Finished.** Reaching the last page marks the BookOrbit book "read", once per open book.
- **First sync of a book.** BookOrbit attributes the position to its web reader (`bookorbit-web`)
  when the timestamps tie. It is the same position, so the reader treats it as in sync.
- **Reset.** BookOrbit's "reset progress" serves a fresh start-of-book position. The reader
  follows it on the next pull, as KOReader does.
