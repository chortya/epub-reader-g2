export function pickChapterTitle(
  spineTitle: string,
  headingTitle: string,
  documentTitle: string,
  chapterNumber: number,
): string {
  const candidates = [spineTitle, headingTitle, documentTitle].map(normalizeChapterTitle);
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
