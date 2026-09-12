import type { CachedBookMeta } from './types.ts';

function filenameStem(filename: string): string {
  const leaf = filename.split(/[\\/]/).pop() ?? filename;
  return leaf.replace(/\.epub$/i, '') || leaf;
}

export function formatBookPickerLabel(
  book: CachedBookMeta,
  allBooks: readonly CachedBookMeta[],
): string {
  const sameTitle = allBooks.filter(
    (candidate) => candidate.title.localeCompare(book.title, undefined, { sensitivity: 'base' }) === 0,
  );
  if (sameTitle.length <= 1) return book.title;

  const stem = filenameStem(book.filename);
  const sameFilename = sameTitle.filter(
    (candidate) => candidate.filename.localeCompare(book.filename, undefined, { sensitivity: 'base' }) === 0,
  );
  if (sameFilename.length <= 1) return `${stem} - ${book.title}`;

  return `${book.bookId.slice(-4).toUpperCase()} ${stem} - ${book.title}`;
}

export function matchesBookQuery(
  book: Pick<CachedBookMeta, 'title' | 'filename'>,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return `${book.title}\n${book.filename}`.toLocaleLowerCase().includes(needle);
}
