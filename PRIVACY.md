# Privacy Policy: ePub Reader for Even Realities G2

Last updated: 2026-11-01

ePub Reader is local-first. It has no accounts of its own, no analytics and
no advertising.

## Data stored on your phone

- **Books** you upload or download, kept in the app's local storage (IndexedDB
  and the Even Realities App storage) so you can read offline.
- **Reading positions, bookmarks and settings**, stored the same way.
- **If you turn on Progress sync:** the sync server address, your username,
  the MD5 key derived from your password (the password itself is never
  stored) and a random device ID.

You can delete a book from the library at any time. Uninstalling the app
removes all of this data.

## Network access

The app declares the `network` permission. It uses it in two cases, and only
when you start them:

1. **Project Gutenberg.** When you open "Gutenberg Top 100" or download a book,
   the app requests the public catalog page or the book's EPUB file.
2. **Progress sync (KOReader), optional and off by default.** When you log in
   to a KOReader-compatible sync server, the app sends this to the server you
   chose:
   - your username and password key;
   - an identifier for each book you open: a hash of the file, or of its file
     name;
   - your reading position: the place in the book and a percentage;
   - the device name "Even G2" and the random device ID.

   It sends this when a book opens, while you read, when the app goes to the
   background, and when you choose "Sync progress". It also reads back the
   last position stored for that book.

Both kinds of request go through the developer's relay at **RELAY_ORIGIN**.
The relay exists because Even Hub apps can only contact approved addresses
that support CORS (see `relay/README.md`). It forwards the request and
returns the response. It does not store or log the contents, and it is
operated by the app's developer.

Your sync server is run by whoever you chose (for example KOReader's public
server or your own). Its own privacy policy applies to the data stored there.

The app has no other network access and sends no data to the developer.

## Contact

Andriy, evendev@proton.me. Source code: https://github.com/chortya/epub-reader-g2
