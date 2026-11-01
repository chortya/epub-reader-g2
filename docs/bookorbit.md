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

## Availability

BookOrbit is offered in two kinds of build:
- dev builds, which have no relay;
- personal builds (`npm run pack:personal`, which sets `VITE_PERSONAL_BUILD`).

In those builds the user's BookOrbit origin can be whitelisted. Public relay builds offer only
plain KOReader sync servers.

## Downloads and offline reading

Books from BookOrbit are downloaded into the reader's own library and read from there, so
reading never needs the server.

- **Storage.** The library keeps each book twice:
  - in IndexedDB, for fast loading;
  - in the Even app's bridge storage, which survives device app restarts.
  If the durable copy can't be written (storage full), the phone says that the book is only kept
  for this session.
- **Download index.** `bookorbit-cache.ts`, stored in bridge storage, links each BookOrbit book
  (per server and login) to its local copy. The BookOrbit list shows:
  - **On device** when the local copy exists. **Read** opens it without the network.
  - **Update available** when BookOrbit's `updatedAt` is newer than at download time.
    **Update** re-downloads the book and removes the superseded copy. Your place comes back
    through sync, because BookOrbit links the new file to the same book.
  - **Download** fetches a book for later without opening it. It then shows up in the glasses'
    book picker.
- **Robust downloads:**
  - the download is streamed with a 30 s stall timeout, so big books on a slow link are fine as
    long as data keeps arriving;
  - the result is checked against the expected size and the EPUB (ZIP) signature;
  - a network failure gets one retry;
  - the book is parsed before it's stored, so a broken file never enters the library.
- **Local first, always.**
  - Opening the section lists the downloaded books straight away from the local index; the
    server list replaces them once it arrives.
  - If BookOrbit can't be reached, the downloaded books stay listed and searchable, and **Read**
    opens them from the device.
  - Read never needs the network for a downloaded book, even when an update is available.
  - If the index lost track of a book, Read falls back offline to the single local copy saved
    under that book's download name.
  - The glasses' library, Continue Reading and position saving never depend on BookOrbit.
- **Catching up.**
  - Progress is pulled, and pushed when newer, whenever the app returns to the foreground, the
    page becomes visible, or the network comes back.
  - Reading time is kept in an outbox in bridge storage until BookOrbit acknowledges it. It
    survives app restarts and is uploaded at startup.
- **Deleting** a book from the Library updates its BookOrbit badge. **Download** gets it back.

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
- **Reset.** After "reset progress" in BookOrbit:
  - the reader goes back to the start on the next pull;
  - it reports `DocFragment[1]` at 0 %, the exact position BookOrbit waits for before it accepts
    the device's pushes again, even for books whose first chapter is a later fragment (a skipped
    cover page);
  - the reset always wins over the clock comparison.
- **Clocks.**
  - Each push's response calibrates the phone clock against the server's.
  - When two save times are too close to order safely, sync only moves forward, so it never
    throws away pages read on either device.
- **Hostile input.**
  - Server values are validated: positions must be in 0..1, absurd timestamps are ignored, JSON
    bodies are capped at 2 MB, catalog pages at the requested size.
  - Credentials never follow redirects and only travel over https (plain http is allowed only
    on loopback).
