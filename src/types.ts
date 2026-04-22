export type Chapter = {
  title: string;
  text: string;
};

export type Book = {
  title: string;
  chapters: Chapter[];
};

export type ViewState = 'mainMenu' | 'bookPicker' | 'library' | 'reading' | 'flowReading';

export type ReadingPosition = {
  chapterIndex: number;
  pageIndex: number;
  wordIndex?: number;
};

export type CachedBookMeta = {
  bookId: string;
  title: string;
  filename: string;
  uploadedAt: number;
};
