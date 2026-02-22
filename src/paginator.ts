import { config } from './constants';
import type Hypher from 'hypher';

let hyphenator: Hypher | null = null;

/** Set the hyphenator instance (called after language detection) */
export function setHyphenator(h: Hypher): void {
  hyphenator = h;
}

/**
 * Split chapter text into fixed-size pages.
 * Word-wraps at character count + end-of-line hyphenation.
 */
export function paginateText(
  text: string,
  maxChars = config.charsPerLine,
  maxLines = config.showStatusBar ? 9 : 10,
): string[] {
  if (!text || text.trim().length === 0) return ['(empty)'];

  const wrappedLines = wordWrap(text, maxChars);

  const pages: string[] = [];
  for (let i = 0; i < wrappedLines.length; i += maxLines) {
    const pageLines = wrappedLines.slice(i, i + maxLines);
    const page = pageLines.join('\n').trimEnd();
    if (page.length > 0) {
      pages.push(page);
    }
  }

  return pages.length > 0 ? pages : ['(empty)'];
}

function wordWrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split('\n');

  for (const para of paragraphs) {
    const trimmed = para.trimEnd();
    if (trimmed.length === 0) {
      lines.push('');
      continue;
    }
    wrapParagraph(trimmed, maxChars, lines);
  }

  return lines;
}

function wrapParagraph(text: string, maxChars: number, lines: string[]): void {
  const words = text.split(/( +)/);
  let currentLine = '';

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.length === 0) continue;

    if (/^ +$/.test(word)) {
      if (currentLine.length > 0) {
        currentLine += word;
      }
      continue;
    }

    const testLine = currentLine.length > 0 ? currentLine + word : word;

    if (testLine.length <= maxChars) {
      currentLine = testLine;
      continue;
    }

    // Word doesn't fit. Try hyphenation on current line.
    if (config.hyphenation && hyphenator && word.length >= 5) {
      const remaining = maxChars - currentLine.length;
      const hyphenated = tryHyphenate(word, remaining);
      if (hyphenated) {
        currentLine += hyphenated.head + '-';
        lines.push(currentLine);
        currentLine = hyphenated.tail;
        continue;
      }
    }

    // Push current line, move word to next line.
    if (currentLine.trimEnd().length > 0) {
      lines.push(currentLine.trimEnd());
    }

    // If word is longer than a full line, hyphenate across lines
    if (word.length > maxChars) {
      let rest = word;
      while (rest.length > maxChars) {
        if (config.hyphenation && hyphenator) {
          const hyp = tryHyphenate(rest, maxChars);
          if (hyp) {
            lines.push(hyp.head + '-');
            rest = hyp.tail;
            continue;
          }
        }
        lines.push(rest.slice(0, maxChars - 1) + '-');
        rest = rest.slice(maxChars - 1);
      }
      currentLine = rest;
    } else {
      currentLine = word;
    }
  }

  if (currentLine.trimEnd().length > 0) {
    lines.push(currentLine.trimEnd());
  }
}

/**
 * Try to hyphenate a word so the first part + '-' fits in `available` chars.
 */
function tryHyphenate(
  word: string,
  available: number,
): { head: string; tail: string } | null {
  if (!hyphenator || available < 3) return null;

  // Separate leading letters from trailing punctuation
  const match = word.match(/^([\p{L}\p{M}]+)(.*)/u);
  if (!match) return null;

  const [, core, suffix] = match;
  if (core.length < 4) return null;

  const syllables = hyphenator.hyphenate(core);
  if (syllables.length < 2) return null;

  // Find the longest prefix of syllables that fits (with '-')
  let head = '';
  let bestSplit = -1;

  for (let i = 0; i < syllables.length - 1; i++) {
    const candidate = head + syllables[i];
    if (candidate.length + 1 <= available) {
      head = candidate;
      bestSplit = i;
    } else {
      break;
    }
  }

  if (bestSplit < 0 || head.length < 2) return null;

  const tail = syllables.slice(bestSplit + 1).join('') + suffix;
  return { head, tail };
}
