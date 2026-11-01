/**
 * Table-of-contents labels for chapter titles: EPUB3 <nav epub:type="toc">
 * and EPUB2 NCX navPoints. Each entry maps a content document (zip path,
 * fragment stripped) to its label; the first entry for a document wins.
 */

export type TocEntry = { href: string; label: string };

function collapse(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function localName(el: Element): string {
  return (el.localName || el.tagName || '').toLowerCase();
}

/** Elements named `name` (case-insensitive, any namespace) in document order. */
function descendants(root: Document | Element, name: string): Element[] {
  const out: Element[] = [];
  const walk = (el: Element): void => {
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (localName(c) === name) out.push(c);
      walk(c);
    }
  };
  const start = 'documentElement' in root ? root.documentElement : root;
  if (start) {
    if (localName(start) === name) out.push(start);
    walk(start);
  }
  return out;
}

/** EPUB2 NCX: navPoint > navLabel > text, navPoint > content@src, in document order. */
export function tocEntriesFromNcx(doc: Document): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const point of descendants(doc, 'navpoint')) {
    let label = '';
    let src = '';
    for (let n = point.firstElementChild; n; n = n.nextElementSibling) {
      const name = localName(n);
      if (name === 'navlabel' && !label) label = collapse(descendants(n, 'text')[0]?.textContent ?? n.textContent);
      if (name === 'content' && !src) src = n.getAttribute('src') ?? '';
    }
    if (label && src) entries.push({ href: src, label });
  }
  return entries;
}

/** EPUB3 nav document: the toc <nav> (or the first <nav>), anchors in order. */
export function tocEntriesFromNav(doc: Document): TocEntry[] {
  const navs = descendants(doc, 'nav');
  const toc = navs.find((nav) => {
    const type = nav.getAttribute('epub:type') ?? nav.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? '';
    return type.split(/\s+/).includes('toc');
  }) ?? navs[0];
  if (!toc) return [];
  return descendants(toc, 'a')
    .map((a) => ({ href: a.getAttribute('href') ?? '', label: collapse(a.textContent) }))
    .filter((e) => e.href && e.label);
}

/**
 * First label per content document, keyed by the resolved zip path.
 * `resolve(href)` turns a TOC href (relative to the TOC file) into a zip path.
 */
export function tocTitlesByPath(entries: TocEntry[], resolve: (href: string) => string | null): Map<string, string> {
  const titles = new Map<string, string>();
  for (const entry of entries) {
    const path = resolve(entry.href);
    if (path && !titles.has(path)) titles.set(path, entry.label);
  }
  return titles;
}
