import JSZip from 'jszip';
import Hypher from 'hypher';
import { pickChapterTitle, normalizeChapterTitle } from './chapter-title';
import { cleanForG2, normalizeExtractedText } from './text-normalize';

import type { Book, Chapter } from './types';
import { setHyphenator, setWideGlyphs } from './paginator';
import { Md5 } from './md5';
import { koreaderPartialMd5Samples } from './kosync-locator';
import { tocEntriesFromNav, tocEntriesFromNcx, tocTitlesByPath } from './epub-toc';

export async function parseEpub(data: ArrayBuffer, filenameHint?: string): Promise<Book> {
  const zip = await JSZip.loadAsync(data);

  // 1. Find the OPF file path from META-INF/container.xml
  const containerXml = await readZipFile(zip, 'META-INF/container.xml');
  const opfPath = parseContainerXml(containerXml);

  // 2. Parse the OPF to get spine order and manifest
  const opfXml = await readZipFile(zip, opfPath);
  const opfDir = dirnameZipPath(opfPath);
  const { title, spineItems, toc } = parseOpf(opfXml, opfDir);
  await applyTocTitles(zip, toc, spineItems);

  // 3. Extract text from each spine item
  const rawChapters: { title: string; text: string; spineIndex: number; href: string }[] = [];
  for (const item of spineItems) {
    const xhtml = await readZipFile(zip, item.href);
    if (!xhtml) continue;

    const chapterMeta = extractChapterMetadata(xhtml);
    const text = chapterMeta.text;
    if (text.trim().length < 10) continue;

    rawChapters.push({
      title: pickChapterTitle(item.title, chapterMeta.heading, chapterMeta.documentTitle, rawChapters.length + 1, title),
      text: text.trim(),
      spineIndex: item.spineIndex,
      href: item.href,
    });
  }

  if (rawChapters.length === 0) {
    throw new Error('No readable chapters found in EPUB');
  }

  // Detect language and set up hyphenator
  const sampleText = rawChapters.slice(0, 3).map((c) => c.text).join(' ');
  const lang = detectLang(sampleText);
  setHyphenator(new Hypher(await loadHyphenationPatterns(lang)));
  setWideGlyphs(lang === 'ru' || lang === 'uk');

  // Apply paragraph formatting
  const chapters: Chapter[] = rawChapters.map((ch) => ({
    title: ch.title,
    text: formatText(ch.text),
    spineIndex: ch.spineIndex,
  }));

  // Use OPF title unless it looks like a placeholder (too short, numeric, or generic)
  let bookTitle = title;
  if (!bookTitle || bookTitle.length < 3 || /^\d+$/.test(bookTitle) || /^(untitled|unknown|chapter|section)/i.test(bookTitle)) {
    if (filenameHint) {
      bookTitle = filenameHint.replace(/\.epub$/i, '').replace(/[_]/g, ' ').trim();
    }
  }

  if (bookTitle.length > 300) bookTitle = `${bookTitle.slice(0, 299)}…`;

  const partialMd5 = new Md5();
  for (const sample of koreaderPartialMd5Samples(new Uint8Array(data))) partialMd5.update(sample);

  return {
    title: bookTitle || 'Untitled',
    chapters,
    partialMd5: partialMd5.digestHex(),
    // Lazy source access for the KOSync locator; keeps the zip, not the XHTML.
    loadChapterXhtml: (chapterIndex: number) => {
      const href = rawChapters[chapterIndex]?.href;
      return href ? readZipFile(zip, href) : Promise.reject(new Error('No such chapter'));
    },
  };
}

async function loadHyphenationPatterns(lang: string): Promise<ConstructorParameters<typeof Hypher>[0]> {
  switch (lang) {
    case 'de':
      return (await import('hyphenation.de')).default;
    case 'es':
      return (await import('hyphenation.es')).default;
    case 'fr':
      return (await import('hyphenation.fr')).default;
    case 'nl':
      return (await import('hyphenation.nl')).default;
    case 'pl':
      return (await import('hyphenation.pl')).default;
    case 'pt':
      return (await import('hyphenation.pt')).default;
    case 'ru':
      return (await import('hyphenation.ru')).default;
    case 'uk':
      return (await import('hyphenation.uk')).default;
    case 'en':
    default:
      return (await import('hyphenation.en-us')).default;
  }
}

/** Inflated-size limits: one XHTML/TOC/OPF entry, and everything read from one book. */
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_BOOK_TEXT_BYTES = 256 * 1024 * 1024;
const MAX_SPINE_ITEMS = 5000;
const inflatedBudget = new WeakMap<JSZip, { used: number }>();

/**
 * Inflate one entry as UTF-8 text, counting the bytes actually produced (the
 * size a zip declares can lie) and stopping at the per-entry and per-book
 * limits, so a small "zip bomb" EPUB can't exhaust the WebView's memory.
 */
function inflateLimited(zip: JSZip, file: JSZip.JSZipObject, path: string): Promise<string> {
  let budget = inflatedBudget.get(zip);
  if (!budget) {
    budget = { used: 0 };
    inflatedBudget.set(zip, budget);
  }
  const book = budget;
  return new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let failed = false;
    // internalStream is part of JSZip's API, missing from its typings.
    const helper = (file as unknown as { internalStream(type: 'uint8array'): any }).internalStream('uint8array');
    helper
      .on('data', (chunk: Uint8Array) => {
        if (failed) return;
        size += chunk.byteLength;
        book.used += chunk.byteLength;
        if (size > MAX_ENTRY_BYTES || book.used > MAX_BOOK_TEXT_BYTES) {
          failed = true;
          helper.pause();
          reject(new Error(`EPUB part too large to read: ${path}`));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (e: Error) => {
        if (!failed) reject(e);
      })
      .on('end', () => {
        if (failed) return;
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const c of chunks) {
          bytes.set(c, offset);
          offset += c.byteLength;
        }
        resolve(decodeXmlText(bytes));
      })
      .resume();
  });
}

/**
 * Decode an EPUB text part: UTF-8 (or a BOM-marked UTF-16) by default, or
 * the encoding an XML declaration names (older EPUBs use e.g. windows-1252).
 */
function decodeXmlText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const declared = /^\s*<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]{1,40})["']/.exec(head)?.[1];
  if (declared && !/^utf-?8$/i.test(declared)) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch { /* unknown label: fall back to UTF-8 */ }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

async function readZipFile(zip: JSZip, path: string): Promise<string> {
  const candidates = buildZipPathCandidates(path);
  let file = candidates.map((candidate) => zip.file(candidate)).find(Boolean) ?? null;
  if (!file) {
    const lowerCandidates = new Set(candidates.map((candidate) => candidate.toLowerCase()));
    zip.forEach((relativePath, entry) => {
      if (lowerCandidates.has(relativePath.toLowerCase()) && !file) {
        file = entry;
      }
    });
  }
  if (!file) {
    throw new Error(`File not found in EPUB: ${path}`);
  }
  return inflateLimited(zip, file, path);
}

function parseContainerXml(xml: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');
  const rootfile = doc.querySelector('rootfile');
  const fullPath = rootfile?.getAttribute('full-path');
  if (!fullPath) {
    throw new Error('Could not find OPF path in container.xml');
  }
  return normalizeZipPath(safeDecodeUriPath(fullPath));
}

/** spineIndex: position among ALL <spine> itemrefs (= KOReader DocFragment index - 1). */
type SpineItem = { href: string; title: string; spineIndex: number };

type TocSources = { navHref: string | null; ncxHref: string | null };

function parseOpf(xml: string, opfDir: string): { title: string; spineItems: SpineItem[]; toc: TocSources } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');

  const titleEl = doc.querySelector('metadata > *|title') ?? doc.querySelector('dc\\:title, title');
  const title = titleEl?.textContent?.trim() ?? '';

  const manifestMap = new Map<string, string>();
  const toc: TocSources = { navHref: null, ncxHref: null };
  const spineTocId = doc.querySelector('spine')?.getAttribute('toc') ?? null;
  const manifestItems = doc.querySelectorAll('manifest > item');
  manifestItems.forEach((item) => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const mediaType = item.getAttribute('media-type') ?? '';
    const properties = (item.getAttribute('properties') ?? '').split(/\s+/);
    if (href && properties.includes('nav')) toc.navHref = resolveZipPath(opfDir, href);
    if (href && (id === spineTocId || (mediaType === 'application/x-dtbncx+xml' && !toc.ncxHref))) {
      toc.ncxHref = resolveZipPath(opfDir, href);
    }
    if (id && href && mediaType.includes('html')) {
      const resolvedHref = resolveZipPath(opfDir, href);
      if (resolvedHref) {
        manifestMap.set(id, resolvedHref);
      }
    }
  });

  const spineItems: SpineItem[] = [];
  const spineRefs = doc.querySelectorAll('spine > itemref');
  Array.from(spineRefs).slice(0, MAX_SPINE_ITEMS).forEach((ref, spineIndex) => {
    const idref = ref.getAttribute('idref');
    if (idref && manifestMap.has(idref)) {
      spineItems.push({ href: manifestMap.get(idref)!, title: '', spineIndex });
    }
  });

  return { title, spineItems, toc };
}

/**
 * Fill spine-item titles from the EPUB3 nav document, else the EPUB2 NCX.
 * Best effort: a missing or malformed TOC leaves titles to the heading /
 * document-title fallbacks in pickChapterTitle.
 */
async function applyTocTitles(zip: JSZip, toc: TocSources, spineItems: SpineItem[]): Promise<void> {
  const sources = [
    toc.navHref ? { path: toc.navHref, kind: 'nav' as const } : null,
    toc.ncxHref ? { path: toc.ncxHref, kind: 'ncx' as const } : null,
  ].filter((s): s is { path: string; kind: 'nav' | 'ncx' } => s !== null);
  for (const source of sources) {
    try {
      const xml = await readZipFile(zip, source.path);
      const parser = new DOMParser();
      let doc = parser.parseFromString(xml, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length > 0) doc = parser.parseFromString(xml, 'text/html');
      const entries = source.kind === 'nav' ? tocEntriesFromNav(doc) : tocEntriesFromNcx(doc);
      const baseDir = dirnameZipPath(source.path);
      const titles = tocTitlesByPath(entries, (href) => resolveZipPath(baseDir, href));
      if (titles.size === 0) continue;
      for (const item of spineItems) {
        if (!item.title) item.title = titles.get(item.href) ?? '';
      }
      return;
    } catch (e) {
      console.warn(`TOC ${source.path} unreadable:`, e);
    }
  }
}

function dirnameZipPath(path: string): string {
  const normalized = normalizeZipPath(path);
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : '';
}

function resolveZipPath(baseDir: string, href: string): string | null {
  const decodedHref = safeDecodeUriPath(href);
  if (/^[a-z][a-z0-9+.-]*:/i.test(decodedHref)) {
    return null;
  }
  const joined = decodedHref.startsWith('/') ? decodedHref : `${baseDir}${decodedHref}`;
  return normalizeZipPath(joined);
}

function buildZipPathCandidates(path: string): string[] {
  const raw = path.trim();
  const decoded = safeDecodeUriPath(raw);
  const normalizedRaw = normalizeZipPath(raw);
  const normalizedDecoded = normalizeZipPath(decoded);
  const encodedDecoded = encodeURI(normalizedDecoded);

  return Array.from(
    new Set([raw, decoded, normalizedRaw, normalizedDecoded, encodedDecoded].filter(Boolean)),
  );
}

function safeDecodeUriPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function normalizeZipPath(path: string): string {
  const withoutFragment = path.replace(/\\/g, '/').split('#')[0].split('?')[0];
  const segments = withoutFragment.split('/');
  const normalized: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (normalized.length > 0) normalized.pop();
      continue;
    }
    normalized.push(segment);
  }

  return normalized.join('/');
}

/**
 * Add paragraph indentation: each line after a \n gets a small indent.
 * First line of the chapter has no indent.
 */
function formatText(text: string): string {
  const INDENT = '  '; // 2-space indent for paragraph starts
  const lines = text.split('\n');
  return lines
    .map((line, i) => (i > 0 && line.length > 0 ? INDENT + line : line))
    .join('\n');
}

/** Block-level elements that should produce line breaks */
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'ASIDE',
  'HEADER', 'FOOTER', 'FIGCAPTION', 'DT', 'DD',
  'TR', 'TH', 'TD',
]);

function extractChapterMetadata(html: string): {
  text: string;
  heading: string;
  documentTitle: string;
} {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const heading = normalizeChapterTitle(
    doc.querySelector('h1, h2, h3, h4, h5, h6')?.textContent ?? '',
  );
  const documentTitle = normalizeChapterTitle(doc.querySelector('title')?.textContent ?? '');

  doc.querySelectorAll('script, style').forEach((el) => el.remove());

  const parts: string[] = [];
  walkNode(doc.body, parts);

  let text = parts.join('');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/ ?\n ?/g, '\n');
  text = text.replace(/\n{2,}/g, '\n');
  text = normalizeExtractedText(text);
  text = text.split('\n').map(line => cleanForG2(line)).join('\n');
  text = text.trim();

  return { text, heading, documentTitle };
}

function walkNode(node: Node | null, parts: string[]): void {
  if (!node) return;

  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = child.textContent ?? '';
      // Replace all whitespace (newlines, tabs) with single spaces
      // This duplicates clear logic but ensures we don't pass source \n to output
      const normalized = t.replace(/\s+/g, ' ');
      if (normalized.length > 0) {
        parts.push(normalized);
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      const tag = el.tagName;

      if (tag === 'BR') {
        parts.push('\n');
        continue;
      }

      const isBlock = BLOCK_TAGS.has(tag);

      if (isBlock) {
        // Single newline before block elements
        if (parts.length > 0) {
          const last = parts[parts.length - 1];
          if (!last.endsWith('\n')) {
            parts.push('\n');
          }
        }
      }

      const beforeLen = parts.length;
      walkNode(el, parts);

      // Ensure inline elements don't fuse with surrounding text.
      // E.g. <em>word1</em><em>word2</em> must not become "word1word2".
      if (!isBlock && parts.length > beforeLen) {
        const first = parts[beforeLen];
        const prev = beforeLen > 0 ? parts[beforeLen - 1] : '';
        if (prev.length > 0 && !/\s$/.test(prev) && !/^\s/.test(first)) {
          parts.splice(beforeLen, 0, ' ');
        }
      }

      if (isBlock && parts.length > 0) {
        const last = parts[parts.length - 1];
        if (!last.endsWith('\n')) {
          parts.push('\n');
        }
      }
    }
  }
}

function detectLang(text: string): string {
  // Sample from middle of text to avoid Gutenberg/copyright boilerplate at start
  const mid = Math.max(0, Math.floor(text.length / 2) - 1000);
  const sample = text.slice(mid, mid + 2000);

  // Cyrillic → Russian or Ukrainian
  const cyrillicCount = (sample.match(/[\u0400-\u04FF]/g) || []).length;
  if (cyrillicCount > sample.length * 0.2) {
    const ukChars = (sample.match(/[\u0404\u0406\u0407\u0490\u0491\u0454\u0456\u0457]/g) || []).length;
    return ukChars > 3 ? 'uk' : 'ru';
  }

  // --- Unique character detection (most reliable, check first) ---

  // Polish: ą, ć, ę, ł, ń, ś, ź, ż (Latin Extended-A, unique to Polish)
  const plChars = (sample.match(/[\u0104\u0105\u0106\u0107\u0118\u0119\u0141\u0142\u0143\u0144\u015A\u015B\u0179\u017A\u017B\u017C]/g) || []).length;
  if (plChars > 2) return 'pl';

  // Portuguese: ã, õ (unique among Latin-script languages)
  const ptChars = (sample.match(/[\u00E3\u00F5\u00C3\u00D5]/g) || []).length;
  if (ptChars > 1) return 'pt';

  // Spanish: ñ, ¡, ¿ (unique to Spanish)
  const esChars = (sample.match(/[\u00F1\u00D1\u00A1\u00BF]/g) || []).length;
  if (esChars > 1) return 'es';

  // German: ü, ß are unique; ä, ö shared with Nordic languages
  const deUmlaut = (sample.match(/[\u00E4\u00F6\u00FC\u00DF\u00C4\u00D6\u00DC]/g) || []).length;
  const deUnique = (sample.match(/[\u00FC\u00DC\u00DF]/g) || []).length;
  if (deUnique > 1 || deUmlaut > 5) return 'de';

  // French: ç, œ, ù, û (not in Italian)
  const frUnique = (sample.match(/[\u00E7\u00C7\u0153\u0152\u00F9\u00D9\u00FB\u00DB]/g) || []).length;
  if (frUnique > 1) return 'fr';

  // --- Word-pattern detection (for languages without unique characters) ---

  // Dutch: Dutch-specific function words
  const nlWords = (sample.match(/\b(het|niet|zijn|wordt|deze|maar|ook|nog|wel|geen|naar|zeer)\b/gi) || []).length;
  if (nlWords > 8) return 'nl';

  // French fallback: high count of accented vowels (é, è, ê, à, â)
  const frAccents = (sample.match(/[\u00E9\u00E8\u00EA\u00EB\u00E0\u00E2]/g) || []).length;
  if (frAccents > 5) return 'fr';

  return 'en';
}
