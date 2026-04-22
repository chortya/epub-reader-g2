
import {
  CreateStartUpPageContainer,
  DeviceConnectType,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import { mapGlassEvent } from 'even-toolkit/action-map';
import { notifyTextUpdate, armImmediateScroll } from 'even-toolkit/gestures';
import { createSplash, TILE_PRESETS } from 'even-toolkit/splash';
import type { Book, ReadingPosition, ViewState, CachedBookMeta } from './types';
import { paginateText } from './paginator';
import {
  config,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  FLOW_MAX_WPM,
  FLOW_MIN_WPM,
  STORAGE_KEY_BOOK_TITLE,
  STORAGE_KEY_FLOW_POSITION,
  STORAGE_KEY_LAST_BOOK_FILENAME,
  STORAGE_KEY_LAST_BOOK_ID,
  STORAGE_KEY_POSITION,
  getTextLayout,
} from './constants';
import { clamp, setStatus, truncateForList, appendEventLog } from './utils';
import { createSplashBridgeAdapter } from './splash-bridge';

type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>;

const ITEMS_PER_PAGE = 4;
const ROW_HEIGHT = Math.floor(DISPLAY_HEIGHT / ITEMS_PER_PAGE); // 72px

type FlowPageData = {
  tokens: string[];
  wordCount: number;
};

const BOOK_LIST_KEY = 'epub-book-list';

export class EvenEpubClient {
  private view: ViewState = 'library'; // Starts as library (welcome), transitions after init
  private book: Book | null = null;
  private chapterPages: string[][] = [];
  private flowPageData: FlowPageData[][] = [];
  private chapterIndex = 0;
  private pageIndex = 0;
  private flowWordIndex = 0;
  private isFlowRunning = false;
  private flowTimerId: number | null = null;
  private isFlowTickInFlight = false;
  private librarySelectedIndex = 0;
  private isInitializedUi = false;
  private isStartupComplete = false;
  private isStartupRunning = false;
  private cachedBookList: CachedBookMeta[] = [];
  private bookPickerSelectedIndex = 0;
  private currentBookId: string | null = null;
  private currentBookFilename: string | null = null;

  public onViewChanged?: () => void;
  public onPositionChanged?: (chapterIndex: number, pageIndex: number) => void;
  public onFlowStateChanged?: (isRunning: boolean) => void;

  constructor(private bridge: Bridge) { }

  async init(): Promise<void> {
    this.bridge.onDeviceStatusChanged(async (status) => {
      if (status.connectType === DeviceConnectType.Connected) {
        await this.ensureStartupUi();
        if (!this.isStartupComplete && !this.isStartupRunning) {
          await this.runStartup();
        } else if (this.isStartupComplete) {
          await this.refreshCurrentView();
        }
      }
    });

    this.bridge.onEvenHubEvent((event) => {
      this.onEvenHubEvent(event).catch(e => console.warn('Event handler error:', e));
    });

    // Load cached book list from bridge storage
    try {
      const raw = await this.bridge.getLocalStorage(BOOK_LIST_KEY);
      if (raw) this.cachedBookList = JSON.parse(raw);
    } catch { /* empty */ }

    const device = await this.bridge.getDeviceInfo();
    if (device?.status?.connectType === DeviceConnectType.Connected) {
      await this.ensureStartupUi();
      await this.runStartup();
    }
  }

  async loadBook(
    book: Book,
    resume: boolean = false,
    bookId?: string,
    filename?: string,
  ): Promise<void> {
    this.stopFlow();
    this.book = book;
    this.currentBookId = bookId ?? null;
    this.currentBookFilename = filename ?? null;
    this.chapterPages = book.chapters.map((ch) => paginateText(ch.text));
    this.flowPageData = this.buildFlowPageData(this.chapterPages);

    const restoredPaged = await this.restorePagedPosition(book.title);
    const restoredFlow = await this.restoreFlowPosition(book.title);

    if (config.readingMode === 'flow' && restoredFlow) {
      this.chapterIndex = restoredFlow.chapterIndex;
      this.pageIndex = restoredFlow.pageIndex;
      this.flowWordIndex = restoredFlow.wordIndex ?? 0;
    } else if (restoredPaged) {
      this.chapterIndex = restoredPaged.chapterIndex;
      this.pageIndex = restoredPaged.pageIndex;
      this.flowWordIndex = 0;
    } else {
      this.chapterIndex = 0;
      this.pageIndex = 0;
      this.flowWordIndex = 0;
    }

    this.librarySelectedIndex = this.chapterIndex;

    // Ensure this book is in the glasses-side cache (main.ts refreshes the full list right after;
    // this is a fallback for when loadBook is invoked outside the library-refresh flow).
    if (this.currentBookId && !this.cachedBookList.some((b) => b.bookId === this.currentBookId)) {
      this.cachedBookList.push({
        bookId: this.currentBookId,
        title: book.title,
        filename: book.title + '.epub',
        uploadedAt: Date.now(),
      });
      this.bridge.setLocalStorage(BOOK_LIST_KEY, JSON.stringify(this.cachedBookList)).catch(() => {});
    }

    setStatus(`Loaded: ${book.title} (${book.chapters.length} chapters)`);

    if (resume && (restoredPaged || restoredFlow)) {
      if (config.readingMode === 'flow') {
        await this.showFlowReading(true);
      } else {
        await this.showPage();
      }
    } else {
      await this.showChapterList();
    }
  }

  async applySettings(): Promise<void> {
    if (this.book && this.chapterPages.length > 0) {
      const oldTotalPages = this.chapterPages[this.chapterIndex]?.length || 1;
      const progress = this.pageIndex / oldTotalPages;
      this.chapterPages = this.book.chapters.map((ch) => paginateText(ch.text));
      this.flowPageData = this.buildFlowPageData(this.chapterPages);
      const newTotalPages = this.chapterPages[this.chapterIndex]?.length || 1;
      this.pageIndex = Math.max(0, Math.min(Math.floor(progress * newTotalPages), newTotalPages - 1));

      const flowPage = this.flowPageData[this.chapterIndex]?.[this.pageIndex];
      const maxWordIndex = Math.max(0, (flowPage?.wordCount ?? 1) - 1);
      this.flowWordIndex = clamp(this.flowWordIndex, 0, maxWordIndex);

      if (config.readingMode === 'flow' && this.view === 'reading') {
        this.flowWordIndex = 0;
        await this.showFlowReading(false);
      } else if (config.readingMode === 'paged' && this.view === 'flowReading') {
        this.stopFlow();
        await this.showPage();
      } else {
        this.flowLayoutReady = false;
        await this.refreshCurrentView();
      }
      if (this.view === 'flowReading' && this.isFlowRunning) {
        this.scheduleFlowTick();
      }
    } else if (this.view === 'library' && !this.book) {
      await this.showWelcome();
    }
  }

  // --- UI Setup ---

  private getWelcomeContainers(): TextContainerProperty[] {
    const title = 'G2 ePUB Reader';
    const maxChars = 59;
    const titlePad = Math.floor((maxChars - title.length) / 2);
    const centeredTitle = ' '.repeat(Math.max(0, titlePad)) + title;

    const titleContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: 80,
      width: DISPLAY_WIDTH,
      height: 40,
      containerID: 1,
      containerName: 'title',
      content: centeredTitle,
      isEventCapture: 0,
    });

    const instruction = 'Upload ePub file via WebUI to start reading';
    const instrPad = Math.floor((maxChars - instruction.length) / 2);
    const centeredInstruction = ' '.repeat(Math.max(0, instrPad)) + instruction;

    const instructionContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: 170,
      width: DISPLAY_WIDTH,
      height: 40,
      containerID: 2,
      containerName: 'instruction',
      content: centeredInstruction,
      isEventCapture: 1,
    });

    return [titleContainer, instructionContainer];
  }

  private async ensureStartupUi(): Promise<void> {
    if (this.isInitializedUi) return;

    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 2,
        textObject: this.getWelcomeContainers(),
      }),
    );

    if (result === 0) {
      this.isInitializedUi = true;
    } else {
      console.error('Failed to create startup page:', result);
      appendEventLog(`Error: Failed to create startup page (${result})`);
    }
  }

  // --- Views ---

  private async runStartup(): Promise<void> {
    if (this.isStartupRunning || this.isStartupComplete) return;
    this.isStartupRunning = true;
    try {
      await this.showSplashThenHome();
    } finally {
      this.isStartupComplete = true;
      this.isStartupRunning = false;
    }
  }

  private async showSplashThenHome(): Promise<void> {
    const splash = createSplash({
      render: (ctx, w, h) => {
        ctx.fillStyle = '#d0d0d0';
        // Draw open book icon
        const cx = w / 2;
        const cy = h / 2 - 12;
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#d0d0d0';
        // Left page
        ctx.beginPath();
        ctx.moveTo(cx, cy - 15);
        ctx.lineTo(cx - 25, cy - 12);
        ctx.lineTo(cx - 25, cy + 15);
        ctx.lineTo(cx, cy + 18);
        ctx.closePath();
        ctx.stroke();
        // Right page
        ctx.beginPath();
        ctx.moveTo(cx, cy - 15);
        ctx.lineTo(cx + 25, cy - 12);
        ctx.lineTo(cx + 25, cy + 15);
        ctx.lineTo(cx, cy + 18);
        ctx.closePath();
        ctx.stroke();
        // Spine
        ctx.beginPath();
        ctx.moveTo(cx, cy - 15);
        ctx.lineTo(cx, cy + 18);
        ctx.stroke();
        // Text lines on pages
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#999';
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.moveTo(cx - 22, cy - 6 + i * 6);
          ctx.lineTo(cx - 5, cy - 6 + i * 6);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cx + 5, cy - 6 + i * 6);
          ctx.lineTo(cx + 22, cy - 6 + i * 6);
          ctx.stroke();
        }
        // Title
        ctx.fillStyle = '#e0e0e0';
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('ePub Reader', cx, h - 8);
      },
      tiles: 1,
      tilePositions: TILE_PRESETS.centered1,
      minTimeMs: 2000,
    });

    try {
      const splashBridge = createSplashBridgeAdapter(this.bridge as any);
      await splash.show(splashBridge);
      await Promise.race([
        splash.waitMinTime(),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
    } catch (e) {
      console.warn('Splash failed, continuing:', e);
    }

    // Show book picker or welcome
    if (this.cachedBookList.length > 0) {
      // Pre-select the last-read book if available
      try {
        const lastTitle = await this.bridge.getLocalStorage(STORAGE_KEY_BOOK_TITLE);
        if (lastTitle) {
          const idx = this.cachedBookList.findIndex(b => b.title === lastTitle);
          if (idx >= 0) this.bookPickerSelectedIndex = idx;
        }
      } catch { /* */ }
      await this.showBookPicker();
    } else {
      await this.showWelcome();
    }
  }

  private async showBookPicker(): Promise<void> {
    this.stopFlow();
    this.view = 'bookPicker';

    const total = this.cachedBookList.length;
    if (total === 0) {
      await this.showWelcome();
      return;
    }

    const pageStart =
      Math.floor(this.bookPickerSelectedIndex / ITEMS_PER_PAGE) * ITEMS_PER_PAGE;
    const selectedSlot = this.bookPickerSelectedIndex - pageStart;

    const labels: string[] = [];
    for (let i = 0; i < ITEMS_PER_PAGE; i++) {
      const idx = pageStart + i;
      if (idx < total) {
        labels.push(truncateForList(this.cachedBookList[idx].title, 42));
      } else {
        labels.push('');
      }
    }

    await this.rebuildSlots(labels, selectedSlot);
    setStatus(`Library: ${this.bookPickerSelectedIndex + 1}/${total}. Swipe=browse, Tap=open, DblTap=exit`);
    this.onViewChanged?.();
  }

  private async showWelcome(): Promise<void> {
    this.stopFlow();
    this.view = 'library';

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: this.getWelcomeContainers(),
      }),
    );
    notifyTextUpdate();

    setStatus('Ready. Upload an EPUB or browse Gutenberg.');
    this.onViewChanged?.();
  }

  private async showChapterList(): Promise<void> {
    if (!this.book) return;
    this.stopFlow();
    this.view = 'library';

    const total = this.book.chapters.length;
    const pageStart =
      Math.floor(this.librarySelectedIndex / ITEMS_PER_PAGE) * ITEMS_PER_PAGE;
    const selectedSlot = this.librarySelectedIndex - pageStart;

    const labels: string[] = [];
    for (let i = 0; i < ITEMS_PER_PAGE; i++) {
      const idx = pageStart + i;
      if (idx < total) {
        const ch = this.book.chapters[idx];
        const pgCount = this.chapterPages[idx]?.length ?? 0;
        labels.push(truncateForList(`${idx + 1}. ${ch.title} (${pgCount}pg)`, 42));
      } else {
        labels.push('');
      }
    }

    await this.rebuildSlots(labels, selectedSlot);

    setStatus(
      `Chapters: ${this.librarySelectedIndex + 1}/${total}. Swipe=browse, Tap=open, DblTap=exit`,
    );
    appendEventLog(`Chapter list page ${pageStart + 1}-${Math.min(pageStart + ITEMS_PER_PAGE, total)}`);
  }

  private async showPage(): Promise<void> {
    if (!this.book || this.chapterPages.length === 0) return;
    this.stopFlow();
    this.view = 'reading';

    const pages = this.chapterPages[this.chapterIndex];
    const page = pages[this.pageIndex];
    const chapter = this.book.chapters[this.chapterIndex];
    const totalPages = pages.length;

    let totalBookPages = 0;
    let currentAbsolutePage = 0;
    for (let i = 0; i < this.chapterPages.length; i++) {
      if (i < this.chapterIndex) {
        currentAbsolutePage += this.chapterPages[i].length;
      } else if (i === this.chapterIndex) {
        currentAbsolutePage += this.pageIndex + 1;
      }
      totalBookPages += this.chapterPages[i].length;
    }
    const progress = totalBookPages > 1 ? currentAbsolutePage / totalBookPages : 1;
    // Progress info text and bar
    const totalChapters = this.book.chapters.length;
    const infoText = `Ch ${this.chapterIndex + 1}/${totalChapters} Pg ${this.pageIndex + 1}/${totalPages} `;

    // Calculate the remaining space for the progress bar.
    const hasBottomBar = config.statusBarPosition === 'bottom';
    const maxChars = 59;
    // Reserve 2 chars for brackets, use remaining space for bar
    const targetBarLen = Math.max(5, Math.min(20, maxChars - infoText.length - 2));
    const filled = Math.round(targetBarLen * progress);
    const bar = '━'.repeat(filled) + '─'.repeat(targetBarLen - filled);
    const label = `${infoText}[${bar}]`;

    const layout = getTextLayout();
    // Pad the page with leading blank lines so content sits at the bottom of
    // the full-size container (no need to shrink the container and lose swipe
    // capture over the blank top half).
    const paddedPage = '\n'.repeat(layout.topBlankLines) + page;

    const textContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: layout.yPosition,
      width: DISPLAY_WIDTH,
      height: layout.usableHeight,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 6,
      containerID: 1,
      containerName: 'text',
      content: paddedPage,
      isEventCapture: 1,
    });

    const textObjects = [textContainer];

    if (hasBottomBar) {
      // Footer container: thin bottom strip for progress
      const footerContainer = new TextContainerProperty({
        xPosition: 0,
        yPosition: layout.availableHeight,
        width: DISPLAY_WIDTH,
        height: layout.barHeight,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 0,
        containerID: 2,
        containerName: 'footer',
        content: label,
        isEventCapture: 0,
      });
      textObjects.push(footerContainer);
    }

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: textObjects.length,
        textObject: textObjects,
      }),
    );
    notifyTextUpdate();

    await this.savePagedPosition();

    setStatus(
      `Ch ${this.chapterIndex + 1
      } / ${this.book.chapters.length}: ${chapter.title} | Page ${this.pageIndex + 1}/${totalPages}`,
    );
  }

  private flowLayoutReady = false;

  private async showFlowReading(autoStart: boolean): Promise<void> {
    if (!this.book || this.flowPageData.length === 0) return;
    this.view = 'flowReading';
    this.flowLayoutReady = false; // force full rebuild on entry
    const pageData = this.getCurrentFlowPageData();
    if (!pageData) return;
    this.flowWordIndex = clamp(this.flowWordIndex, 0, Math.max(0, pageData.wordCount - 1));
    await this.showFlowFrame();
    if (autoStart) {
      this.startFlow();
    } else {
      this.stopFlow();
    }
  }

  private async showFlowFrame(): Promise<void> {
    if (!this.book || this.flowPageData.length === 0) return;
    this.view = 'flowReading';

    const pageData = this.getCurrentFlowPageData();
    if (!pageData) return;
    const totalPageWords = Math.max(1, pageData.wordCount);
    this.flowWordIndex = clamp(this.flowWordIndex, 0, totalPageWords - 1);
    const content = this.buildFlowPageContent(pageData, this.flowWordIndex);

    let totalBookWords = 0;
    let currentAbsoluteWord = 0;
    for (let ch = 0; ch < this.flowPageData.length; ch++) {
      for (let pg = 0; pg < this.flowPageData[ch].length; pg++) {
        const pageWords = this.flowPageData[ch][pg].wordCount;
        totalBookWords += pageWords;
        if (ch < this.chapterIndex || (ch === this.chapterIndex && pg < this.pageIndex)) {
          currentAbsoluteWord += pageWords;
        } else if (ch === this.chapterIndex && pg === this.pageIndex) {
          currentAbsoluteWord += this.flowWordIndex + 1;
        }
      }
    }
    const progress = totalBookWords > 1 ? currentAbsoluteWord / totalBookWords : 1;
    const flowState = this.isFlowRunning ? 'RUN' : 'PAUSE';
    const chapterTotalPages = this.chapterPages[this.chapterIndex]?.length ?? 1;
    const infoText = `Flow ${flowState} ${config.flowSpeedWpm}wpm Ch ${this.chapterIndex + 1}/${this.book.chapters.length} Pg ${this.pageIndex + 1}/${chapterTotalPages} W ${this.flowWordIndex + 1}/${totalPageWords} `;

    const hasBottomBar = config.statusBarPosition === 'bottom';
    const maxChars = 59;
    const targetBarLen = Math.max(5, Math.min(20, maxChars - infoText.length - 2));
    const filled = Math.round(targetBarLen * progress);
    const bar = '━'.repeat(filled) + '─'.repeat(targetBarLen - filled);
    const label = `${infoText}[${bar}]`;

    const layout = getTextLayout();
    const paddedContent = '\n'.repeat(layout.topBlankLines) + (content || '...');

    const textContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: layout.yPosition,
      width: DISPLAY_WIDTH,
      height: layout.usableHeight,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 6,
      containerID: 1,
      containerName: 'flow-text',
      content: paddedContent,
      isEventCapture: 1,
    });

    const textObjects = [textContainer];
    if (hasBottomBar) {
      textObjects.push(
        new TextContainerProperty({
          xPosition: 0,
          yPosition: layout.availableHeight,
          width: DISPLAY_WIDTH,
          height: layout.barHeight,
          borderWidth: 0,
          borderColor: 5,
          paddingLength: 0,
          containerID: 2,
          containerName: 'flow-footer',
          content: label,
          isEventCapture: 0,
        }),
      );
    }

    if (this.flowLayoutReady) {
      // Use textContainerUpgrade for flicker-free in-place updates (per SDK docs)
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: 1,
          containerName: 'flow-text',
          content: paddedContent,
        }),
      );
      if (hasBottomBar) {
        await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: 2,
            containerName: 'flow-footer',
            content: label,
          }),
        );
      }
    } else {
      // Full rebuild to establish container layout
      await this.bridge.rebuildPageContainer(
        new RebuildPageContainer({
          containerTotalNum: textObjects.length,
          textObject: textObjects,
        }),
      );
      this.flowLayoutReady = true;
    }
    notifyTextUpdate();

    await this.saveFlowPosition();
    setStatus(
      `Flow ${this.isFlowRunning ? 'running' : 'paused'} | Ch ${this.chapterIndex + 1}/${this.book.chapters.length} | Pg ${this.pageIndex + 1}/${chapterTotalPages} | Word ${this.flowWordIndex + 1}/${totalPageWords} | ${config.flowSpeedWpm} WPM`,
    );
  }

  private async rebuildSlots(labels: string[], selectedSlot: number): Promise<void> {
    const textContainers: TextContainerProperty[] = [];

    for (let i = 0; i < ITEMS_PER_PAGE; i++) {
      const isSelected = i === selectedSlot;
      textContainers.push(
        new TextContainerProperty({
          xPosition: 0,
          yPosition: i * ROW_HEIGHT,
          width: DISPLAY_WIDTH,
          height: ROW_HEIGHT,
          borderWidth: isSelected ? 1 : 0,
          borderColor: 5,
          borderRadius: 8,
          paddingLength: 2,
          containerID: i + 1,
          containerName: `slot-${i}`,
          content: labels[i] ?? '',
          isEventCapture: isSelected ? 1 : (selectedSlot < 0 && i === 0 ? 1 : 0),
        }),
      );
    }

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: ITEMS_PER_PAGE,
        textObject: textContainers,
      }),
    );
    notifyTextUpdate();
  }

  // --- Navigation ---

  private async nextPage(): Promise<void> {
    if (!this.book) return;
    const pages = this.chapterPages[this.chapterIndex];

    if (this.pageIndex < pages.length - 1) {
      this.pageIndex++;
    } else if (this.chapterIndex < this.book.chapters.length - 1) {
      this.chapterIndex++;
      this.pageIndex = 0;
    } else {
      appendEventLog('End of book');
      return;
    }

    await this.showPage();
  }

  private async prevPage(): Promise<void> {
    if (!this.book) return;

    if (this.pageIndex > 0) {
      this.pageIndex--;
    } else if (this.chapterIndex > 0) {
      this.chapterIndex--;
      this.pageIndex = this.chapterPages[this.chapterIndex].length - 1;
    } else {
      appendEventLog('Beginning of book');
      return;
    }

    await this.showPage();
  }

  private buildFlowPageData(chapters: string[][]): FlowPageData[][] {
    return chapters.map((pages) =>
      pages.map((page) => {
        const tokens = this.tokenizeFlowPage(page);
        const wordCount = Math.max(1, tokens.filter((token) => /\S/.test(token)).length);
        return { tokens, wordCount };
      }),
    );
  }

  private tokenizeFlowPage(page: string): string[] {
    const tokens = page.match(/\S+|\s+/g);
    return tokens && tokens.length > 0 ? tokens : [''];
  }

  private getCurrentFlowPageData(): FlowPageData | null {
    const chapter = this.flowPageData[this.chapterIndex];
    if (!chapter || chapter.length === 0) return null;
    this.pageIndex = clamp(this.pageIndex, 0, chapter.length - 1);
    return chapter[this.pageIndex] ?? null;
  }

  private buildFlowPageContent(pageData: FlowPageData, visibleWordIndex: number): string {
    let seenWords = 0;
    let output = '';
    for (const token of pageData.tokens) {
      if (/\S/.test(token)) {
        if (seenWords <= visibleWordIndex) {
          output += token;
        }
        seenWords++;
      } else if (seenWords <= visibleWordIndex + 1) {
        output += token;
      }
    }
    return output.trim().length > 0 ? output : '...';
  }

  private getFlowIntervalMs(): number {
    const wpm = clamp(config.flowSpeedWpm, FLOW_MIN_WPM, FLOW_MAX_WPM);
    return Math.max(80, Math.floor(60000 / wpm));
  }

  private startFlow(): void {
    if (this.isFlowRunning) return;
    this.isFlowRunning = true;
    appendEventLog('Flow started');
    this.onFlowStateChanged?.(true);
    this.scheduleFlowTick();
    this.showFlowFrame().catch((e) => console.warn('Failed to render flow frame:', e));
  }

  private stopFlow(): void {
    if (this.flowTimerId !== null) {
      window.clearTimeout(this.flowTimerId);
      this.flowTimerId = null;
    }
    const wasRunning = this.isFlowRunning;
    this.isFlowRunning = false;
    if (wasRunning) this.onFlowStateChanged?.(false);
  }

  private toggleFlow(): void {
    if (!this.book || this.view !== 'flowReading') return;
    if (this.isFlowRunning) {
      this.stopFlow();
      appendEventLog('Flow paused');
      this.showFlowFrame().catch((e) => console.warn('Failed to render flow frame:', e));
    } else {
      this.startFlow();
    }
  }

  private scheduleFlowTick(): void {
    if (!this.isFlowRunning) return;
    if (this.flowTimerId !== null) {
      window.clearTimeout(this.flowTimerId);
      this.flowTimerId = null;
    }
    this.flowTimerId = window.setTimeout(async () => {
      await this.flowTick();
      this.scheduleFlowTick();
    }, this.getFlowIntervalMs());
  }

  private async flowTick(): Promise<void> {
    if (!this.book || !this.isFlowRunning || this.isFlowTickInFlight) return;
    this.isFlowTickInFlight = true;
    try {
      const pageData = this.getCurrentFlowPageData();
      if (!pageData) return;

      if (this.flowWordIndex < pageData.wordCount - 1) {
        this.flowWordIndex++;
      } else if (this.pageIndex < (this.chapterPages[this.chapterIndex]?.length ?? 1) - 1) {
        this.pageIndex++;
        this.flowWordIndex = 0;
      } else if (this.chapterIndex < this.book.chapters.length - 1) {
        this.chapterIndex++;
        this.pageIndex = 0;
        this.flowWordIndex = 0;
      } else {
        appendEventLog('End of book in flow mode');
        this.stopFlow();
      }

      await this.showFlowFrame();
    } finally {
      this.isFlowTickInFlight = false;
    }
  }

  private async nextChapterInFlow(): Promise<void> {
    if (!this.book) return;
    if (this.chapterIndex >= this.book.chapters.length - 1) {
      appendEventLog('Already at last chapter');
      return;
    }
    this.chapterIndex++;
    this.pageIndex = 0;
    this.flowWordIndex = 0;
    await this.showFlowFrame();
  }

  private async prevChapterInFlow(): Promise<void> {
    if (!this.book) return;
    if (this.chapterIndex <= 0) {
      appendEventLog('Already at first chapter');
      return;
    }
    this.chapterIndex--;
    this.pageIndex = 0;
    this.flowWordIndex = 0;
    await this.showFlowFrame();
  }

  private async nextChapterInList(): Promise<void> {
    if (!this.book) return;
    if (this.librarySelectedIndex < this.book.chapters.length - 1) {
      this.librarySelectedIndex++;
      await this.showChapterList();
    }
  }

  private async prevChapterInList(): Promise<void> {
    if (this.librarySelectedIndex > 0) {
      this.librarySelectedIndex--;
      await this.showChapterList();
    }
  }

  private async selectCurrentChapter(): Promise<void> {
    if (!this.book) return;
    armImmediateScroll();
    this.chapterIndex = this.librarySelectedIndex;
    this.pageIndex = 0;
    this.flowWordIndex = 0;
    if (config.readingMode === 'flow') {
      await this.showFlowReading(true);
    } else {
      await this.showPage();
    }
  }

  private async refreshCurrentView(): Promise<void> {
    if (this.view === 'reading') {
      await this.showPage();
    } else if (this.view === 'flowReading') {
      await this.showFlowFrame();
    } else if (this.view === 'bookPicker') {
      await this.showBookPicker();
    } else if (this.book) {
      await this.showChapterList();
    } else {
      await this.showWelcome();
    }
  }

  // --- Event Handling ---

  private async onEvenHubEvent(event: EvenHubEvent): Promise<void> {
    const sysEvent = event?.sysEvent;
    if (sysEvent?.eventType === OsEventTypeList.SYSTEM_EXIT_EVENT) {
      await this.handleShutdown();
      return;
    }
    if (sysEvent?.eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      if (this.isFlowRunning) this.stopFlow();
      if (this.view === 'flowReading') await this.saveFlowPosition();
      else await this.savePagedPosition();
      return;
    }
    if (sysEvent?.eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      await this.refreshCurrentView();
      return;
    }

    const action = mapGlassEvent(event);
    if (!action) return;

    switch (action.type) {
      case 'HIGHLIGHT_MOVE':
        if (action.direction === 'down') {
          if (this.view === 'reading') await this.nextPage();
          else if (this.view === 'flowReading') await this.nextChapterInFlow();
          else if (this.view === 'library') await this.nextChapterInList();
          else if (this.view === 'bookPicker') await this.nextBookInPicker();
        } else {
          if (this.view === 'reading') await this.prevPage();
          else if (this.view === 'flowReading') await this.prevChapterInFlow();
          else if (this.view === 'library') await this.prevChapterInList();
          else if (this.view === 'bookPicker') await this.prevBookInPicker();
        }
        break;

      case 'SELECT_HIGHLIGHTED':
        if (this.view === 'flowReading' && this.book) {
          this.toggleFlow();
        } else if (this.view === 'library' && this.book) {
          await this.selectCurrentChapter();
        } else if (this.view === 'bookPicker' && this.onBookSelected) {
          const selected = this.cachedBookList[this.bookPickerSelectedIndex];
          if (selected) {
            try {
              await this.onBookSelected(selected);
            } catch (e) {
              console.warn('Book selection failed:', e);
            }
          }
        }
        break;

      case 'GO_BACK':
        if (this.view === 'reading' && this.book) {
          this.librarySelectedIndex = this.chapterIndex;
          await this.showChapterList();
        } else if (this.view === 'flowReading' && this.book) {
          if (!this.isFlowRunning) {
            this.librarySelectedIndex = this.chapterIndex;
            await this.showChapterList();
          }
        } else if (this.view === 'library' && this.book) {
          this.book = null;
          this.stopFlow();
          if (this.cachedBookList.length > 0) {
            await this.showBookPicker();
          } else {
            await this.showWelcome();
          }
        } else if (this.view === 'bookPicker' || (this.view === 'library' && !this.book)) {
          try { await this.bridge.shutDownPageContainer(1); } catch { /* */ }
        }
        break;
    }
  }

  // Book picker navigation
  private async nextBookInPicker(): Promise<void> {
    if (this.bookPickerSelectedIndex < this.cachedBookList.length - 1) {
      this.bookPickerSelectedIndex++;
      await this.showBookPicker();
    }
  }

  private async prevBookInPicker(): Promise<void> {
    if (this.bookPickerSelectedIndex > 0) {
      this.bookPickerSelectedIndex--;
      await this.showBookPicker();
    }
  }

  /** Called by main.ts when a book is selected from the picker */
  public onBookSelected?: (book: CachedBookMeta) => void;

  /** Cache the book list for glasses-side access */
  public async cacheBookList(books: CachedBookMeta[]): Promise<void> {
    this.cachedBookList = books;
    try {
      await this.bridge.setLocalStorage(BOOK_LIST_KEY, JSON.stringify(books));
    } catch { /* */ }
  }

  /** Set the book ID for blob position sync */
  public setCurrentBookId(id: string): void {
    this.currentBookId = id;
  }

  // --- Public reader controls (used by web-UI buttons) ---

  public getView(): ViewState {
    return this.view;
  }

  public isFlowActive(): boolean {
    return this.isFlowRunning;
  }

  public canPagedPrev(): boolean {
    return !!this.book && (this.pageIndex > 0 || this.chapterIndex > 0);
  }

  public canPagedNext(): boolean {
    if (!this.book) return false;
    const pages = this.chapterPages[this.chapterIndex];
    if (!pages) return false;
    return this.pageIndex < pages.length - 1
      || this.chapterIndex < this.book.chapters.length - 1;
  }

  public canFlowPrevChapter(): boolean {
    return !!this.book && this.chapterIndex > 0;
  }

  public canFlowNextChapter(): boolean {
    return !!this.book && this.chapterIndex < this.book.chapters.length - 1;
  }

  public async pagedNext(): Promise<void> {
    if (this.view !== 'reading') return;
    await this.nextPage();
  }

  public async pagedPrev(): Promise<void> {
    if (this.view !== 'reading') return;
    await this.prevPage();
  }

  public toggleFlowPlayback(): void {
    if (this.view !== 'flowReading') return;
    this.toggleFlow();
  }

  public async flowNextChapter(): Promise<void> {
    if (this.view !== 'flowReading') return;
    await this.nextChapterInFlow();
  }

  public async flowPrevChapter(): Promise<void> {
    if (this.view !== 'flowReading') return;
    await this.prevChapterInFlow();
  }

  private async handleShutdown(): Promise<void> {
    this.stopFlow();
    if (this.view === 'flowReading') await this.saveFlowPosition();
    else await this.savePagedPosition();
    try { await this.bridge.shutDownPageContainer(); } catch { /* */ }
  }

  // --- Persistence ---

  private async savePagedPosition(): Promise<void> {
    if (!this.book) return;
    try {
      const pos: ReadingPosition = {
        chapterIndex: this.chapterIndex,
        pageIndex: this.pageIndex,
      };
      const json = JSON.stringify(pos);
      const titleKey = `${STORAGE_KEY_POSITION}-${this.book.title}`;
      if (this.currentBookId) {
        await this.bridge.setLocalStorage(`${STORAGE_KEY_POSITION}-${this.currentBookId}`, json);
      }
      await this.bridge.setLocalStorage(titleKey, json);
      await this.bridge.setLocalStorage(STORAGE_KEY_BOOK_TITLE, this.book.title);
      // L3 invariant I1 (design §8.5): title, bookId, filename written together.
      if (this.currentBookId) {
        await this.bridge.setLocalStorage(STORAGE_KEY_LAST_BOOK_ID, this.currentBookId);
      }
      if (this.currentBookFilename) {
        await this.bridge.setLocalStorage(STORAGE_KEY_LAST_BOOK_FILENAME, this.currentBookFilename);
      }

      // Also save to browser localStorage as fallback (bridge storage may not persist)
      try { localStorage.setItem(titleKey, json); } catch { /* */ }
      if (this.currentBookId) {
        try { localStorage.setItem(`${STORAGE_KEY_POSITION}-${this.currentBookId}`, json); } catch { /* */ }
      }

      this.onPositionChanged?.(this.chapterIndex, this.pageIndex);
    } catch (e) {
      console.warn('Failed to save position:', e);
    }
  }

  public async getSavedPosition(bookTitle: string, bookId?: string): Promise<ReadingPosition | null> {
    try {
      // Try bridge storage first, then browser localStorage fallback
      let raw = '';
      if (bookId) {
        raw = await this.bridge.getLocalStorage(`${STORAGE_KEY_POSITION}-${bookId}`);
        if (!raw) try { raw = localStorage.getItem(`${STORAGE_KEY_POSITION}-${bookId}`) || ''; } catch { /* */ }
      }
      if (!raw) {
        raw = await this.bridge.getLocalStorage(`${STORAGE_KEY_POSITION}-${bookTitle}`);
      }
      if (!raw) {
        try { raw = localStorage.getItem(`${STORAGE_KEY_POSITION}-${bookTitle}`) || ''; } catch { /* */ }
      }
      if (!raw) return null;

      const pos: ReadingPosition = JSON.parse(raw);
      if (
        Number.isInteger(pos.chapterIndex) &&
        Number.isInteger(pos.pageIndex) &&
        pos.chapterIndex >= 0 &&
        pos.pageIndex >= 0
      ) {
        return pos;
      }
    } catch { /* no saved position */ }

    return null;
  }

  private async restorePagedPosition(bookTitle: string): Promise<ReadingPosition | null> {
    const keys = [];
    if (this.currentBookId) keys.push(`${STORAGE_KEY_POSITION}-${this.currentBookId}`);
    keys.push(`${STORAGE_KEY_POSITION}-${bookTitle}`);

    for (const key of keys) {
      try {
        let raw = await this.bridge.getLocalStorage(key);
        if (!raw) try { raw = localStorage.getItem(key) || ''; } catch { /* */ }
        if (!raw) continue;

        const pos: ReadingPosition = JSON.parse(raw);
        if (pos.chapterIndex >= 0 && pos.chapterIndex < this.chapterPages.length && pos.pageIndex >= 0) {
          pos.pageIndex = Math.min(pos.pageIndex, Math.max(0, (this.chapterPages[pos.chapterIndex]?.length ?? 1) - 1));
          return pos;
        }
      } catch { /* try next key */ }
    }

    return null;
  }

  private async saveFlowPosition(): Promise<void> {
    if (!this.book) return;
    try {
      const pos: ReadingPosition = {
        chapterIndex: this.chapterIndex,
        pageIndex: this.pageIndex,
        wordIndex: this.flowWordIndex,
      };
      const json = JSON.stringify(pos);
      if (this.currentBookId) {
        await this.bridge.setLocalStorage(`${STORAGE_KEY_FLOW_POSITION}-${this.currentBookId}`, json);
      }
      await this.bridge.setLocalStorage(`${STORAGE_KEY_FLOW_POSITION}-${this.book.title}`, json);
      await this.bridge.setLocalStorage(STORAGE_KEY_BOOK_TITLE, this.book.title);
      // L3 invariant I1 (design §8.5): title, bookId, filename written together.
      if (this.currentBookId) {
        await this.bridge.setLocalStorage(STORAGE_KEY_LAST_BOOK_ID, this.currentBookId);
      }
      if (this.currentBookFilename) {
        await this.bridge.setLocalStorage(STORAGE_KEY_LAST_BOOK_FILENAME, this.currentBookFilename);
      }
      // Browser localStorage fallback
      try {
        localStorage.setItem(`${STORAGE_KEY_FLOW_POSITION}-${this.book.title}`, json);
        if (this.currentBookId) localStorage.setItem(`${STORAGE_KEY_FLOW_POSITION}-${this.currentBookId}`, json);
      } catch { /* */ }
      this.onPositionChanged?.(this.chapterIndex, this.pageIndex);
    } catch (e) {
      console.warn('Failed to save flow position:', e);
    }
  }

  private async restoreFlowPosition(bookTitle: string): Promise<ReadingPosition | null> {
    const keys = [];
    if (this.currentBookId) keys.push(`${STORAGE_KEY_FLOW_POSITION}-${this.currentBookId}`);
    keys.push(`${STORAGE_KEY_FLOW_POSITION}-${bookTitle}`);

    for (const key of keys) {
      try {
        let raw = await this.bridge.getLocalStorage(key);
        if (!raw) try { raw = localStorage.getItem(key) || ''; } catch { /* */ }
        if (!raw) continue;

        const pos: ReadingPosition = JSON.parse(raw);
        const pageIndex = pos.pageIndex ?? 0;
        const wordIndex = pos.wordIndex ?? 0;
        const chapterPages = this.flowPageData[pos.chapterIndex];
        if (
          pos.chapterIndex >= 0 &&
          pos.chapterIndex < this.flowPageData.length &&
          pageIndex >= 0 &&
          pageIndex < (chapterPages?.length ?? 0)
        ) {
          return {
            chapterIndex: pos.chapterIndex,
            pageIndex,
            wordIndex: Math.min(wordIndex, Math.max(0, (chapterPages[pageIndex]?.wordCount ?? 1) - 1)),
          };
        }
      } catch { /* try next key */ }
    }

    return null;
  }
}
