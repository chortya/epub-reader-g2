import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveLastBook, makeBookId } from '../src/book-id.ts';
import type { CachedBookMeta } from '../src/types.ts';

function book(filename: string, title: string, uploadedAt = 0): CachedBookMeta {
  return {
    bookId: makeBookId(filename, title),
    title,
    filename,
    uploadedAt,
  };
}

// Drift-table rows correspond to docs/1.4.0-on-device-settings-and-menu.md §8.5.

test('resolveLastBook: row 1 — bookId hit in a single-entry list', () => {
  const b = book('a.epub', 'A');
  const resolved = resolveLastBook([b], { bookId: b.bookId });
  assert.equal(resolved, b);
});

test('resolveLastBook: row 2 — bookId match is exact, ignoring others', () => {
  const a = book('a.epub', 'A');
  const z = book('z.epub', 'Z');
  const resolved = resolveLastBook([a, z], { bookId: z.bookId });
  assert.equal(resolved, z);
});

test('resolveLastBook: row 3 — bookId drift (key points to missing book) returns null', () => {
  const a = book('a.epub', 'A');
  const resolved = resolveLastBook([a], { bookId: 'no-such-book-id' });
  assert.equal(resolved, null);
});

test('resolveLastBook: row 4 — filename+title tiebreaker after bookId miss', () => {
  // l3 has stale bookId but the title/filename pair still resolves.
  const a = book('a.epub', 'A');
  const resolved = resolveLastBook([a], { bookId: 'stale-id', title: 'A', filename: 'a.epub' });
  assert.equal(resolved, a);
});

test('resolveLastBook: row 5 — duplicate titles without bookId/filename are unresolvable (Q6)', () => {
  const a1 = book('a.epub', 'Same Title', 100);
  const a2 = book('b.epub', 'Same Title', 200);
  // Per decision Q6 in design §16: no most-recent-title fallback. Title-only
  // legacy state returns null; user sees "(No recent book)".
  const resolved = resolveLastBook([a1, a2], { title: 'Same Title' });
  assert.equal(resolved, null);
});

test('resolveLastBook: row 6 — empty cache returns null', () => {
  const resolved = resolveLastBook([], { bookId: 'anything' });
  assert.equal(resolved, null);
});

test('resolveLastBook: row 7 — empty l3 returns null', () => {
  const a = book('a.epub', 'A');
  const resolved = resolveLastBook([a], {});
  assert.equal(resolved, null);
});
