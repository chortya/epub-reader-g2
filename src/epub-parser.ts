import JSZip from 'jszip';
import Hypher from 'hypher';
import enUs from 'hyphenation.en-us';
import de from 'hyphenation.de';
import ru from 'hyphenation.ru';
import uk from 'hyphenation.uk';
import type { Book, Chapter } from './types';
import { setHyphenator } from './paginator';

export async function parseEpub(data: ArrayBuffer): Promise<Book> {
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

    const text = stripHtmlToText(xhtml);
    if (text.trim().length < 10) continue;

    rawChapters.push({
      title: item.title || `Chapter ${rawChapters.length + 1}`,
      text: text.trim(),
    });
  }

  if (rawChapters.length === 0) {
    throw new Error('No readable chapters found in EPUB');
  }

  // Detect language and set up hyphenator
  const sampleText = rawChapters.slice(0, 3).map((c) => c.text).join(' ');
  const lang = detectLang(sampleText);
  const patterns: Record<string, typeof enUs> = { en: enUs, de, ru, uk };
  setHyphenator(new Hypher(patterns[lang]));

  // Apply paragraph formatting
  const chapters: Chapter[] = rawChapters.map((ch) => ({
    title: ch.title,
    text: formatText(ch.text),
  }));

  return { title: title || 'Untitled', chapters };
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

function stripHtmlToText(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove script and style elements
  doc.querySelectorAll('script, style').forEach((el) => el.remove());

  // Walk the DOM and extract text with proper paragraph breaks
  const parts: string[] = [];
  walkNode(doc.body, parts);

  let text = parts.join('');

  // Normalize whitespace
  text = text.replace(/[ \t]+/g, ' ');         // collapse horizontal whitespace
  text = text.replace(/ ?\n ?/g, '\n');         // trim spaces around newlines
  text = text.replace(/\n{2,}/g, '\n');         // single newline between paragraphs

  // Normalize Unicode quotes and dashes for consistent display
  text = text.replace(/[\u2018\u2019\u201A]/g, "'");  // smart single quotes
  text = text.replace(/[\u201C\u201D\u201E]/g, '"');   // smart double quotes
  text = text.replace(/[\u2013\u2014]/g, '-');         // en/em dash to compact hyphen
  text = text.replace(/\u2026/g, '...');               // ellipsis

  text = text.trim();

  return text;
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

      walkNode(el, parts);

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
  const sample = text.slice(0, 2000);

  // Cyrillic → Russian or Ukrainian
  const cyrillicCount = (sample.match(/[\u0400-\u04FF]/g) || []).length;
  if (cyrillicCount > sample.length * 0.2) {
    // Ukrainian-specific letters: Є, І, Ї, Ґ and lowercase
    const ukChars = (sample.match(/[\u0404\u0406\u0407\u0490\u0491\u0454\u0456\u0457]/g) || []).length;
    return ukChars > 3 ? 'uk' : 'ru';
  }

  // German-specific: ä, ö, ü, ß, Ä, Ö, Ü
  const deChars = (sample.match(/[\u00E4\u00F6\u00FC\u00DF\u00C4\u00D6\u00DC]/g) || []).length;
  if (deChars > 3) return 'de';

  return 'en';
}
