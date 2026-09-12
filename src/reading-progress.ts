/**
 * Pure helpers for the reading-view status bar. Previously the "total/progress
 * + infoText" math was duplicated across showPage, showFlowFrame, and the
 * clock-ticker's buildCurrentFooterLabel (even-client.ts). If one drifted, the
 * clock showed different progress than the freshly-rendered page. These
 * functions give a single source of truth for each mode.
 */
import type { ViewState } from './types.ts';
import type { AppConfig } from './constants.ts';

export function toggleStatusBarPosition(
  current: AppConfig['statusBarPosition'],
): AppConfig['statusBarPosition'] {
  return current === 'bottom' ? 'none' : 'bottom';
}

export interface PagedProgressInput {
  chapterPages: string[][];
  chapterIndex: number;
  pageIndex: number;
  totalChapters: number;
}

export interface FlowProgressInput {
  /** wordCount per page, per chapter — flowPageData[ch][pg].wordCount */
  flowWordCounts: number[][];
  chapterIndex: number;
  pageIndex: number;
  flowWordIndex: number;
  totalChapters: number;
  chapterTotalPages: number;
  flowSpeedWpm: number;
  isFlowRunning: boolean;
  /** Measured pace (wpm) from the active session; null = not enough data yet. */
  paceWpm?: number | null;
}

export interface ProgressResult {
  infoText: string;
  progress: number;
}

/** Absolute progress through the whole book for paged mode (0..1). */
export function computePagedProgress(input: PagedProgressInput): ProgressResult {
  const totalPages = input.chapterPages[input.chapterIndex]?.length ?? 1;
  let totalBookPages = 0;
  let currentAbsolutePage = 0;
  for (let i = 0; i < input.chapterPages.length; i++) {
    if (i < input.chapterIndex) {
      currentAbsolutePage += input.chapterPages[i].length;
    } else if (i === input.chapterIndex) {
      currentAbsolutePage += input.pageIndex + 1;
    }
    totalBookPages += input.chapterPages[i].length;
  }
  const progress = totalBookPages > 1 ? currentAbsolutePage / totalBookPages : 1;
  const infoText = `Ch ${input.chapterIndex + 1}/${input.totalChapters} Pg ${input.pageIndex + 1}/${totalPages} `;
  return { infoText, progress };
}

/** Absolute progress through the whole book for flow mode (0..1, word-granular). */
export function computeFlowProgress(input: FlowProgressInput): ProgressResult {
  let totalBookWords = 0;
  let currentAbsoluteWord = 0;
  for (let ch = 0; ch < input.flowWordCounts.length; ch++) {
    for (let pg = 0; pg < input.flowWordCounts[ch].length; pg++) {
      const pageWords = input.flowWordCounts[ch][pg];
      totalBookWords += pageWords;
      if (ch < input.chapterIndex || (ch === input.chapterIndex && pg < input.pageIndex)) {
        currentAbsoluteWord += pageWords;
      } else if (ch === input.chapterIndex && pg === input.pageIndex) {
        currentAbsoluteWord += input.flowWordIndex + 1;
      }
    }
  }
  const progress = totalBookWords > 1 ? currentAbsoluteWord / totalBookWords : 1;
  const flowState = input.isFlowRunning ? 'RUN' : 'PAUSE';

  // Time-to-finish for the current chapter (plan §3.5): real measured pace
  // only — no fabricated estimates. The label is pixel-fitted downstream, so
  // a tight fit just shortens the bar.
  let eta = '';
  if (input.paceWpm && input.paceWpm >= 100) {
    let chapterRemaining = 0;
    const counts = input.flowWordCounts[input.chapterIndex] ?? [];
    for (let pg = 0; pg < counts.length; pg++) {
      chapterRemaining += counts[pg]!;
    }
    for (let pg = 0; pg < input.pageIndex; pg++) chapterRemaining -= counts[pg] ?? 0;
    chapterRemaining -= input.flowWordIndex;
    if (chapterRemaining > 0) {
      eta = `~${Math.max(1, Math.round(chapterRemaining / input.paceWpm))}m `;
    }
  }

  const infoText =
    `${flowState} ${input.flowSpeedWpm}wpm Ch ${input.chapterIndex + 1}/${input.totalChapters} ` +
    `${eta}Pg ${input.pageIndex + 1}/${input.chapterTotalPages} `;
  return { infoText, progress };
}

/**
 * Rescale a page index after repagination by preserving the *fractional*
 * reading progress within the chapter. Used by applySettings when the page
 * count changes (text-height / hyphenation / mode toggles).
 *
 * Returns the new page index, clamped to [0, newTotalPages - 1].
 */
export function rescalePageIndex(
  oldPageIndex: number,
  oldTotalPages: number,
  newTotalPages: number,
): number {
  const safeOld = Math.max(1, oldTotalPages);
  const safeNew = Math.max(1, newTotalPages);
  const progress = oldPageIndex / safeOld;
  return Math.max(0, Math.min(Math.floor(progress * safeNew), safeNew - 1));
}

/**
 * Decide the next view when the user triggers GO_BACK. Replaces the tangle of
 * `view === 'library' && this.book` / `&& !this.book` branches in the gesture
 * switch. Pure so it can be unit-tested.
 *
 * - reading / flowReading → chapter list (clears nothing; the book stays open)
 * - chapterList → mainMenu (the caller clears the book as a side effect)
 * - welcome / bookPicker → mainMenu
 * - settings → mainMenu
 * - settingEditor → settings (cancel in-flight pick)
 * - mainMenu → exit (handled by the caller via the bridge; signaled as 'exit')
 */
export type BackTarget = ViewState | 'exit';

export function routeGoBack(view: ViewState, flowRunning: boolean): BackTarget {
  switch (view) {
    case 'reading':
      return 'chapterList';
    case 'flowReading':
      // Back is gated on a paused flow (unchanged from v1.3.x).
      return flowRunning ? view : 'chapterList';
    case 'chapterList':
      return 'mainMenu';
    case 'welcome':
      return 'mainMenu';
    case 'bookPicker':
      return 'mainMenu';
    case 'settings':
      return 'mainMenu';
    case 'settingEditor':
      return 'settings';
    case 'mainMenu':
      return 'exit';
    default:
      return view;
  }
}
