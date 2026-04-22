import type { CachedBookMeta } from './types.ts';

export function makeBookId(filename: string, title: string): string {
  const input = `${filename}|${title}`.toLowerCase();
  let hash = 0;

  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }

  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  const slug = filename
    .replace(/\.epub$/i, '')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30)
    .toLowerCase();

  return slug ? `${slug}-${hex}` : hex;
}

/**
 * Resolve the "last book" L3 record (stored at save time) back to a concrete
 * CachedBookMeta entry in the picker's cache. Two-tier strategy:
 *   1. Exact bookId match (strongest signal — deterministic from filename+title).
 *   2. (filename + title) pair match via makeBookId — handles stale bookId after
 *      a filename rename or when L3 was written by older code that did not
 *      persist bookId.
 *
 * Title-only matching is deliberately NOT implemented. Duplicate titles would
 * otherwise silently resume the wrong book. See design §16 decision Q6.
 *
 * Returns the matched meta, or null if no match.
 */
export function resolveLastBook(
  cachedBookList: CachedBookMeta[],
  l3: { bookId?: string; title?: string; filename?: string },
): CachedBookMeta | null {
  if (cachedBookList.length === 0) return null;

  if (l3.bookId) {
    const byId = cachedBookList.find((b) => b.bookId === l3.bookId);
    if (byId) return byId;
  }

  if (l3.filename && l3.title) {
    const derivedId = makeBookId(l3.filename, l3.title);
    const byDerivedId = cachedBookList.find((b) => b.bookId === derivedId);
    if (byDerivedId) return byDerivedId;
  }

  return null;
}
