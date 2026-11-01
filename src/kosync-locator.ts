/**
 * KOReader position mapping for KOSync (issue #1).
 *
 * KOReader (crengine) identifies a reflowable position with an XPointer such
 * as `/body/DocFragment[12]/body/div/p[3]/text().42`: DocFragment[N] is the
 * N-th item of the OPF <spine> (1-based, every item, since crengine DOM
 * version 20240114), and the rest is an element path inside that item's
 * <body> with 1-based same-name sibling indices.
 *
 * The reader works with character offsets into the cleaned chapter text, so
 * this module anchors every text-bearing block element of a chapter's XHTML
 * to an offset in that text (matched on non-whitespace characters, which
 * makes it insensitive to the extractor's line-break/indent handling) and
 * converts in both directions at paragraph precision.
 */

import { cleanForG2, normalizeExtractedText } from './text-normalize.ts';

const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'blockquote', 'section', 'article', 'aside',
  'header', 'footer', 'figcaption', 'dt', 'dd',
  'tr', 'th', 'td', 'pre', 'table', 'ul', 'ol', 'dl', 'figure',
  'nav', 'main', 'hr', 'br',
]);

/** Non-whitespace chars used to locate a block's leading text in the chapter. */
const SNIPPET_CHARS = 24;

export type XPointerStep = { kind: 'element'; name: string; index: number } | { kind: 'text'; index: number };

export type ParsedXPointer = {
  /** 1-based DocFragment index (= spine index + 1). */
  fragment: number;
  /** Steps below the fragment's <body>. */
  steps: XPointerStep[];
  /** Trailing `.N` point, if any. */
  point: number | null;
};

const XP_PREFIX_RE = /^\/body\/DocFragment\[(\d+)\](?:\/body(?=\/|\.|$))?/;
const XP_STEP_RE = /^\/(?:(text\(\))|([A-Za-z_][\w.-]*))(?:\[(\d+)\])?/;

export function parseXPointer(xpointer: string): ParsedXPointer | null {
  if (typeof xpointer !== 'string' || xpointer.length > 2048) return null;
  const head = XP_PREFIX_RE.exec(xpointer);
  if (!head) return null;
  const fragment = Number(head[1]);
  if (!Number.isInteger(fragment) || fragment < 1) return null;
  let rest = xpointer.slice(head[0].length);
  const steps: XPointerStep[] = [];
  let point: number | null = null;
  while (rest.length > 0) {
    if (rest.startsWith('.')) {
      const m = /^\.(\d+)$/.exec(rest);
      if (!m) return null;
      point = Number(m[1]);
      break;
    }
    const m = XP_STEP_RE.exec(rest);
    if (!m) return null;
    const index = m[3] ? Number(m[3]) : 1;
    if (index < 1) return null;
    steps.push(m[1] ? { kind: 'text', index } : { kind: 'element', name: m[2].toLowerCase(), index });
    if (steps.length > 256) return null;
    rest = rest.slice(m[0].length);
  }
  return { fragment, steps, point };
}

export function fragmentPrefix(spineIndex: number): string {
  return `/body/DocFragment[${spineIndex + 1}]/body`;
}

/** Normalize text exactly like the extractor, then drop all whitespace. */
function compact(text: string): string {
  return cleanForG2(normalizeExtractedText(text)).replace(/\s+/g, '');
}

type Anchor = {
  element: Element;
  /** Element path below <body>, e.g. `/div[1]/p[3]`. */
  path: string;
  /** Character offset of the block's first non-whitespace char in the chapter text. */
  offset: number;
  /** Same position in the whitespace-free chapter string. */
  compactIndex: number;
};

function localName(el: Element): string {
  return (el.localName || el.tagName || '').toLowerCase();
}

function isBlock(el: Element): boolean {
  return BLOCK_TAGS.has(localName(el));
}

function elementChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out.push(n as Element);
  }
  return out;
}

/**
 * The text a block shows before its first nested block (or <br>), i.e. the
 * start of the line the extractor emits for it. Empty for pure containers.
 */
function leadingText(el: Element): string {
  let out = '';
  let stop = false;
  const walk = (node: Node): void => {
    for (let n = node.firstChild; n && !stop; n = n.nextSibling) {
      if (n.nodeType === 3) {
        out += n.textContent ?? '';
      } else if (n.nodeType === 1) {
        const child = n as Element;
        const name = localName(child);
        if (name === 'script' || name === 'style') continue;
        // A <br> breaks the line but not the block: keep going, so a block
        // split by line breaks is matched (and consumed) as one text.
        if (isBlock(child) && name !== 'br') {
          stop = true;
          return;
        }
        walk(child);
      }
    }
  };
  walk(el);
  return out;
}

/** Non-whitespace characters of `el`'s text that precede `target` (a descendant). */
function compactLengthBefore(el: Element, target: Node): number {
  let count = 0;
  let found = false;
  const walk = (node: Node): void => {
    for (let n = node.firstChild; n && !found; n = n.nextSibling) {
      if (n === target) {
        found = true;
        return;
      }
      if (n.nodeType === 3) {
        count += compact(n.textContent ?? '').length;
      } else if (n.nodeType === 1) {
        const name = localName(n as Element);
        if (name === 'script' || name === 'style') continue;
        walk(n);
      }
    }
  };
  walk(el);
  return count;
}

export class ChapterLocator {
  private anchors: Anchor[] = [];
  private byElement = new Map<Element, Anchor>();
  /** compactToOffset[i] = offset in the chapter text of the i-th non-whitespace char. */
  private compactToOffset: number[] = [];
  private compactText = '';
  private body: Element;
  private chapterText: string;

  constructor(body: Element, chapterText: string) {
    this.body = body;
    this.chapterText = chapterText;
    this.buildCompactText();
    this.buildAnchors();
  }

  get anchorCount(): number {
    return this.anchors.length;
  }

  private buildCompactText(): void {
    const chars: string[] = [];
    const text = this.chapterText;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (!/\s/.test(ch)) {
        chars.push(ch);
        this.compactToOffset.push(i);
      }
    }
    this.compactText = chars.join('');
  }

  private buildAnchors(): void {
    let cursor = 0;
    const visit = (el: Element, path: string): void => {
      const counts = new Map<string, number>();
      for (const child of elementChildren(el)) {
        const name = localName(child);
        const index = (counts.get(name) ?? 0) + 1;
        counts.set(name, index);
        if (name === 'script' || name === 'style') continue;
        const childPath = `${path}/${name}[${index}]`;
        if (isBlock(child)) {
          const lead = compact(leadingText(child));
          const snippet = lead.slice(0, SNIPPET_CHARS);
          if (snippet.length > 0) {
            const at = this.compactText.indexOf(snippet, cursor);
            if (at >= 0) {
              const anchor: Anchor = {
                element: child,
                path: childPath,
                offset: this.compactToOffset[at],
                compactIndex: at,
              };
              this.anchors.push(anchor);
              this.byElement.set(child, anchor);
              // Consume the block's leading text: nested blocks and later
              // siblings start after it (leadingText stops at the first nested
              // block), and paragraphs that open with the same words must not
              // match the same occurrence.
              cursor = at + lead.length;
            }
          }
        }
        visit(child, childPath);
      }
    };
    visit(this.body, '');
  }

  /** Element path (below <body>) of the block containing `offset`, or null. */
  pathForOffset(offset: number): string | null {
    let best: Anchor | null = null;
    for (const anchor of this.anchors) {
      if (anchor.offset <= offset) best = anchor;
      else break;
    }
    return (best ?? this.anchors[0])?.path ?? null;
  }

  /**
   * Chapter-text offset for an XPointer's steps (below <body>). Resolves as
   * deep as the path exists; a text step + point refines within the block.
   * Returns null when nothing in the path can be anchored.
   */
  offsetForSteps(steps: XPointerStep[], point: number | null): number | null {
    let node: Node = this.body;
    let resolvedAll = true;
    for (const step of steps) {
      let next: Node | null = null;
      let count = 0;
      for (let n = node.firstChild; n; n = n.nextSibling) {
        const match = step.kind === 'text'
          ? n.nodeType === 3
          : n.nodeType === 1 && localName(n as Element) === step.name;
        if (match && ++count === step.index) {
          next = n;
          break;
        }
      }
      if (!next) {
        resolvedAll = false;
        break;
      }
      node = next;
    }

    // Nearest anchored ancestor-or-self.
    let anchor: Anchor | undefined;
    for (let n: Node | null = node; n && n !== this.body; n = n.parentNode) {
      if (n.nodeType === 1) {
        anchor = this.byElement.get(n as Element);
        if (anchor) break;
      }
    }
    if (!anchor) {
      // A pure container (or <body> itself): its first anchored descendant;
      // an inline node outside any block: the last block before it.
      const container = node.nodeType === 1 ? (node as Element) : node.parentElement;
      anchor = this.anchors.find((a) => container && (container === this.body || container.contains(a.element)));
      if (!anchor) {
        const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
        for (const a of this.anchors) {
          if (a.element.compareDocumentPosition(node) & FOLLOWING) anchor = a;
          else break;
        }
      }
      return anchor ? anchor.offset : null;
    }

    let compactIndex = anchor.compactIndex;
    if (node !== anchor.element) {
      compactIndex += compactLengthBefore(anchor.element, node);
      if (resolvedAll && node.nodeType === 3 && point !== null) {
        compactIndex += compact((node.textContent ?? '').slice(0, point)).length;
      }
    }
    compactIndex = Math.min(compactIndex, this.compactToOffset.length - 1);
    return compactIndex >= 0 ? this.compactToOffset[compactIndex] : anchor.offset;
  }
}

/** Whole-book progress fraction (KOReader `percentage`), from character counts. */
export function bookPercentage(chapterLengths: number[], chapterIndex: number, offset: number): number {
  const total = chapterLengths.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return 0;
  let before = 0;
  for (let i = 0; i < chapterIndex && i < chapterLengths.length; i++) before += chapterLengths[i];
  const within = Math.min(Math.max(0, offset), chapterLengths[chapterIndex] ?? 0);
  return Math.min(1, Math.max(0, (before + within) / total));
}

/** Inverse of bookPercentage: the chapter and offset at a progress fraction. */
export function positionForPercentage(
  chapterLengths: number[],
  percentage: number,
): { chapterIndex: number; offset: number } {
  const total = chapterLengths.reduce((sum, n) => sum + n, 0);
  if (total <= 0 || chapterLengths.length === 0) return { chapterIndex: 0, offset: 0 };
  let target = Math.min(1, Math.max(0, percentage)) * total;
  for (let i = 0; i < chapterLengths.length; i++) {
    if (target < chapterLengths[i] || i === chapterLengths.length - 1) {
      return { chapterIndex: i, offset: Math.min(Math.floor(target), Math.max(0, chapterLengths[i] - 1)) };
    }
    target -= chapterLengths[i];
  }
  return { chapterIndex: 0, offset: 0 };
}

/**
 * KOReader's default document digest ("binary" checksum): MD5 over 1 KiB
 * samples at offsets 1024 << 2i for i = -1..10. For i = -1 the 32-bit shift
 * wraps to 0 in LuaJIT and in JS alike, so the first sample is the file start.
 * Sampling stops at the first offset past the end (Lua's read returns nil).
 */
export function koreaderPartialMd5Samples(bytes: Uint8Array): Uint8Array[] {
  const samples: Uint8Array[] = [];
  for (let i = -1; i <= 10; i++) {
    const offset = (1024 << (2 * i)) >>> 0;
    if (offset >= bytes.length) break;
    samples.push(bytes.subarray(offset, Math.min(offset + 1024, bytes.length)));
  }
  return samples;
}
