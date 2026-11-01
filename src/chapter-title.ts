export function pickChapterTitle(
  spineTitle: string,
  headingTitle: string,
  documentTitle: string,
  chapterNumber: number,
  bookTitle = '',
): string {
  // Many EPUBs (e.g. Gutenberg/calibre) give every file the book's title as
  // <title>; repeating it for each chapter is worse than "Chapter N".
  const book = normalizeChapterTitle(bookTitle).toLowerCase();
  const doc = normalizeChapterTitle(documentTitle);
  const docIsBookTitle = book.length >= 3 && doc.toLowerCase().includes(book);
  const candidates = [spineTitle, headingTitle, docIsBookTitle ? '' : doc].map(normalizeChapterTitle);
  const selected = candidates.find((title) => !isGenericChapterTitle(title));
  return selected || `Chapter ${chapterNumber}`;
}

export function normalizeChapterTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

export function isGenericChapterTitle(title: string): boolean {
  return (
    title.length < 2 ||
    /^(untitled|unknown|contents?|table of contents)$/i.test(title) ||
    /^(chapter|section|part)\s*\d*$/i.test(title)
  );
}
