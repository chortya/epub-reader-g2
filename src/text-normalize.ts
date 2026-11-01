// Text normalization shared by the EPUB extractor and the KOSync locator,
// which must reproduce the extractor's output to match paragraphs.

/**
 * Extended cleanForG2 that preserves Cyrillic characters (U+0400–U+04FF).
 * The upstream cleanForG2 only allows ASCII + Latin-1 Supplement, stripping Cyrillic.
 */
export function cleanForG2(text: string): string {
  // First let the toolkit strip emojis, then apply our own unsupported-char filter
  // that additionally allows Cyrillic
  const EMOJI_RE = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2614}-\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}-\u{26AB}\u{26BD}-\u{26BE}\u{26C4}-\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}-\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2934}-\u{2935}\u{2B05}-\u{2B07}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu;

  // Allowed ranges match the G2 firmware's actual glyph set (see Even Realities
  // Software Design Guidelines → Font and Unicode support). We explicitly EXCLUDE
  // known-missing code points from within otherwise-allowed ranges:
  //   - Latin-1: ¨(A8) ¯(AF) ´(B4) µ(B5) ¸(B8) are NOT in the G2 font.
  //   - Box drawing U+2500-U+257F: the font only covers solid lines (U+2500-U+2503)
  //     and ═ (U+2550). Dashed/dotted (U+2504-U+250B), dash variants (U+254C-U+254F),
  //     most double-line chars (U+2551-U+255D, U+255F-U+2560, U+2562-U+2569,
  //     U+256B-U+256C), and half-line segments (U+2574-U+257F) are NOT in the font.
  const MISSING_LATIN1 = /[\u00A8\u00AF\u00B4\u00B5\u00B8]/g;
  const MISSING_BOX_DRAWING = /[\u2504-\u250B\u254C-\u254F\u2551-\u255D\u255F-\u2560\u2562-\u2569\u256B-\u256C\u2574-\u257F]/g;

  const UNSUPPORTED_RE = /[^\x20-\x7E\u00A0-\u017F\u0400-\u04FF\u2010-\u2027\u2030-\u205E\u2190-\u21FF\u2500-\u257F]/g;
  return text
    .replace(EMOJI_RE, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, ' ')
    .replace(UNSUPPORTED_RE, '')
    .replace(MISSING_LATIN1, '')
    .replace(MISSING_BOX_DRAWING, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Typographic substitutions applied to extracted text before cleanForG2. */
export function normalizeExtractedText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...');
}
