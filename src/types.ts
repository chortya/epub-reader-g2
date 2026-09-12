export type Chapter = {
  title: string;
  text: string;
};

export type Book = {
  title: string;
  chapters: Chapter[];
};

// `library` was previously overloaded to mean both the no-book welcome screen
// and the chapter list. That required every gesture branch to disambiguate
// with `this.view === 'library' && this.book` / `&& !this.book`, which was a
// footgun (a tap on the welcome screen was a silent no-op because the SELECT
// branch only handled the `&& this.book` case). Splitting into 'welcome' and
// 'chapterList' removes the ambiguity.
export type ViewState =
  | 'mainMenu'
  | 'bookPicker'
  | 'welcome'
  | 'chapterList'
  | 'reading'
  | 'flowReading'
  | 'settings'        // list of 5 editable settings
  | 'settingEditor';  // value-picker for the focused setting

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
