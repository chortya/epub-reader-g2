/**
 * Sentence-boundary helpers for Flow interruption recovery (plan §3.4).
 *
 * Operates on the chapter's cleaned plain text (the same text the paginator
 * consumes), so offsets match position format v2. Deliberately simple:
 * books are prose; boundary = [.!?…] (+ optional closing quotes/brackets)
 * followed by whitespace. A short abbreviation guard avoids splitting after
 * common honorifics and single initials.
 */

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'no', 'fig',
  'e.g', 'i.e', 'cf', 'al', 'inc', 'ltd', 'co', 'univ', 'assn', 'bro', 'col',
]);

/** Char offset of the start of the sentence containing or preceding `offset`. */
export function sentenceStartBefore(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let sentenceStart = 0;
  for (const b of sentenceBoundaries(text)) {
    if (b >= clamped) break;
    sentenceStart = skipWhitespace(text, b);
  }
  return Math.min(sentenceStart, clamped);
}

/** Char offset of the start of the next sentence strictly after `offset`. */
export function nextSentenceStart(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  for (const b of sentenceBoundaries(text)) {
    if (b > clamped) return Math.min(skipWhitespace(text, b), text.length);
  }
  return text.length; // no further sentence — caller clamps
}

/** Offsets just past each sentence terminator, in order. */
function* sentenceBoundaries(text: string): Generator<number> {
  const terminator = /[.!?…]/g;
  for (let m = terminator.exec(text); m !== null; m = terminator.exec(text)) {
    let end = m.index + 1;
    // Include trailing closing quotes/brackets/ellipsis runs.
    while (end < text.length && /["'”’»)\]]/.test(text[end]!)) end++;
    // Ellipsis runs (… or ...) count once at the run's end.
    if (text[m.index] === '.') {
      while (end < text.length && text[end] === '.') end++;
    }
    const prevWord = precedingWord(text, m.index);
    if (ABBREVIATIONS.has(prevWord.toLowerCase())) continue;
    if (prevWord.length === 1 && /\p{Lu}/u.test(prevWord)) continue; // initials
    yield end;
  }
}

function precedingWord(text: string, index: number): string {
  let i = index;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
  return text.slice(i, index);
}

function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}
