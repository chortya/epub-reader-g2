import JSZip from 'jszip';
import Hypher from 'hypher';
import { pickChapterTitle, normalizeChapterTitle } from './chapter-title';

/**
 * Extended cleanForG2 that preserves Cyrillic characters (U+0400–U+04FF).
 * The upstream cleanForG2 only allows ASCII + Latin-1 Supplement, stripping Cyrillic.
 */
function cleanForG2(text: string): string {
  // First let the toolkit strip emojis, then apply our own unsupported-char filter
  // that additionally allows Cyrillic
  const EMOJI_RE = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2614}-\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}-\u{26AB}\u{26BD}-\u{26BE}\u{26C4}-\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}-\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2934}-\u{2935}\u{2B05}-\u{2B07}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu;
  const UNSUPPORTED_RE = /[^\x20-\x7E\u00A0-\u017F\u0400-\u04FF\u2010-\u2027\u2030-\u205E\u2190-\u21FF\u2500-\u257F]/g;
  return text
    .replace(EMOJI_RE, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, ' ')
    .replace(UNSUPPORTED_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}
import type { Book, Chapter } from './types';
import { setHyphenator, setWideGlyphs } from './paginator';

export async function parseEpub(data: ArrayBuffer, filenameHint?: string): Promise<Book> {
  const zip = await JSZip.loadAsync(data);

  // 1. Find the OPF file path from META-INF/container.xml
  const containerXml = await readZipFile(zip, 'META-INF/container.xml');
  const opfPath = parseContainerXml(containerXml);

  // 2. Parse the OPF to get spine order and manifest
  const opfXml = await readZipFile(zip, opfPath);
  const opfDir = dirnameZipPath(opfPath);
  const { title, spineItems } = parseOpf(opfXml, opfDir);

  // 3. Extract text from each spine item
  const rawChapters: { title: string; text: string }[] = [];
  for (const item of spineItems) {
    const xhtml = await readZipFile(zip, item.href);
    if (!xhtml) continue;

    const chapterMeta = extractChapterMetadata(xhtml);
    const text = chapterMeta.text;
    if (text.trim().length < 10) continue;

    rawChapters.push({
      title: pickChapterTitle(item.title, chapterMeta.heading, chapterMeta.documentTitle, rawChapters.length + 1),
      text: text.trim(),
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
  }));

  // Use OPF title unless it looks like a placeholder (too short, numeric, or generic)
  let bookTitle = title;
  if (!bookTitle || bookTitle.length < 3 || /^\d+$/.test(bookTitle) || /^(untitled|unknown|chapter|section)/i.test(bookTitle)) {
    if (filenameHint) {
      bookTitle = filenameHint.replace(/\.epub$/i, '').replace(/[_]/g, ' ').trim();
    }
  }

  return { title: bookTitle || 'Untitled', chapters };
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
  return file.async('string');
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

type SpineItem = { href: string; title: string };

function parseOpf(xml: string, opfDir: string): { title: string; spineItems: SpineItem[] } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');

  const titleEl = doc.querySelector('metadata > *|title') ?? doc.querySelector('dc\\:title, title');
  const title = titleEl?.textContent?.trim() ?? '';

  const manifestMap = new Map<string, string>();
  const manifestItems = doc.querySelectorAll('manifest > item');
  manifestItems.forEach((item) => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const mediaType = item.getAttribute('media-type') ?? '';
    if (id && href && mediaType.includes('html')) {
      const resolvedHref = resolveZipPath(opfDir, href);
      if (resolvedHref) {
        manifestMap.set(id, resolvedHref);
      }
    }
  });

  const spineItems: SpineItem[] = [];
  const spineRefs = doc.querySelectorAll('spine > itemref');
  spineRefs.forEach((ref) => {
    const idref = ref.getAttribute('idref');
    if (idref && manifestMap.has(idref)) {
      spineItems.push({ href: manifestMap.get(idref)!, title: '' });
    }
  });

  tryExtractTitlesFromToc(doc, opfDir, manifestMap, spineItems);

  return { title, spineItems };
}

function tryExtractTitlesFromToc(
  _doc: Document,
  _opfDir: string,
  _manifestMap: Map<string, string>,
  _spineItems: SpineItem[],
): void {
  // Title extraction from NCX/nav is complex and often unreliable.
  // We fall back to "Chapter N" naming, which is set in parseEpub().
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
  text = text.replace(/[\u2018\u2019\u201A]/g, "'");
  text = text.replace(/[\u201C\u201D\u201E]/g, '"');
  text = text.replace(/[\u2013\u2014]/g, '-');
  text = text.replace(/\u2026/g, '...');
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
