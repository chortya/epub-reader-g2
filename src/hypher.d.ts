declare module 'hypher' {
  interface HyphenationPattern {
    id: string;
    leftmin: number;
    rightmin: number;
    patterns: Record<string, unknown>;
  }
  class Hypher {
    constructor(pattern: HyphenationPattern);
    hyphenate(word: string): string[];
    hyphenateText(text: string, minLength?: number): string;
  }
  export = Hypher;
}

declare module 'hyphenation.en-us' {
  const pattern: import('hypher').HyphenationPattern;
  export default pattern;
}

declare module 'hyphenation.de' {
  const pattern: import('hypher').HyphenationPattern;
  export default pattern;
}

declare module 'hyphenation.ru' {
  const pattern: import('hypher').HyphenationPattern;
  export default pattern;
}

declare module 'hyphenation.uk' {
  const pattern: import('hypher').HyphenationPattern;
  export default pattern;
}
