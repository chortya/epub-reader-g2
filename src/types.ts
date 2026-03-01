export type Chapter = {
  title: string;
  text: string;
};

export type Book = {
  title: string;
  chapters: Chapter[];
};

export type ViewState = 'library' | 'reading' | 'flowReading';

export type ReadingPosition = {
  chapterIndex: number;
  pageIndex: number;
  wordIndex?: number;
};
