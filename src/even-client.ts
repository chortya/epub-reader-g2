
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
import type { Book, ReadingPosition, ViewState } from './types';
import { paginateText } from './paginator';
import {
  config,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  FLOW_MAX_WPM,
  FLOW_MIN_WPM,
  STORAGE_KEY_BOOK_TITLE,
  STORAGE_KEY_FLOW_POSITION,
  STORAGE_KEY_POSITION,
  SWIPE_COOLDOWN_MS,
} from './constants';
import { appendEventLog, clamp, setStatus, truncateForList } from './utils';

type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>;

const ITEMS_PER_PAGE = 4;
const ROW_HEIGHT = Math.floor(DISPLAY_HEIGHT / ITEMS_PER_PAGE); // 72px

const BAR_HEIGHT = 30;
const TEXT_HEIGHT = DISPLAY_HEIGHT - BAR_HEIGHT; // Fill the full display height

type FlowPageData = {
  tokens: string[];
  wordCount: number;
};

export class EvenEpubClient {
  private view: ViewState = 'library';
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
  private lastSwipeTime = 0;

  public onViewChanged?: () => void;

  constructor(private bridge: Bridge) { }

  async init(): Promise<void> {
    this.bridge.onDeviceStatusChanged(async (status) => {
      appendEventLog(`Device status: ${status.connectType} `);
      if (status.connectType === DeviceConnectType.Connected) {
        await this.ensureStartupUi();
        this.refreshCurrentView();
      }
    });

    this.bridge.onEvenHubEvent((event) => {
      this.onEvenHubEvent(event);
    });

    // Initial check: Only create UI if already connected
    const device = await this.bridge.getDeviceInfo();
    if (device?.status?.connectType === DeviceConnectType.Connected) {
      await this.ensureStartupUi();
      await this.showWelcome();
    } else {
      appendEventLog('Waiting for device connection to initialize UI...');
    }
  }

  async loadBook(book: Book, resume: boolean = false): Promise<void> {
    this.stopFlow();
    this.book = book;
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
    const maxChars = config.statusBarPosition === 'right' ? 58 : 59;
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

  private async showWelcome(): Promise<void> {
    this.stopFlow();
    this.view = 'library';

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: this.getWelcomeContainers(),
      }),
    );

    setStatus('Ready. Upload an EPUB file or download from Gutenberg.');
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
        labels.push(truncateForList(`${idx + 1}. ${ch.title} `, 42));
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
    // Unicode line-drawing characters (━) are significantly wider than standard text in this font (~1.6x).
    const maxChars = config.statusBarPosition === 'right' ? 58 : 59;
    const remainingStandardChars = maxChars - infoText.length;
    let targetBarLen = Math.floor(remainingStandardChars / 1.6) - 2;
    targetBarLen = Math.max(5, Math.min(20, targetBarLen)); // Cap it so it doesn't look ridiculous
    const filled = Math.round(targetBarLen * progress);
    const bar = '━'.repeat(filled) + '─'.repeat(targetBarLen - filled);
    const label = `${infoText}[${bar}]`;

    const hasBottomBar = config.statusBarPosition === 'bottom';
    const hasRightBar = config.statusBarPosition === 'right';

    const barHeight = hasBottomBar ? 30 : 0;
    const rightBarWidth = hasRightBar ? 26 : 0;
    const textHeight = DISPLAY_HEIGHT - barHeight;
    const textWidth = DISPLAY_WIDTH - rightBarWidth;

    // Text container: top area for page content
    const textContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: textWidth,
      height: textHeight,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 6,
      containerID: 1,
      containerName: 'text',
      content: page,
      isEventCapture: 1,
    });

    const textObjects = [textContainer];

    if (hasBottomBar) {
      // Footer container: thin bottom strip for progress
      const footerContainer = new TextContainerProperty({
        xPosition: 0,
        yPosition: textHeight,
        width: DISPLAY_WIDTH,
        height: barHeight,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 0,
        containerID: 2,
        containerName: 'footer',
        content: label,
        isEventCapture: 0,
      });
      textObjects.push(footerContainer);
    } else if (hasRightBar) {
      const verticalBarLines = 8;
      const verticalFilled = Math.round(verticalBarLines * progress);
      const verticalBar = '█'.repeat(verticalFilled) + '│'.repeat(verticalBarLines - verticalFilled);
      // Construct a vertical text by splitting characters with newlines
      const verticalContent = verticalBar.split('').join('\n');

      const sideContainer = new TextContainerProperty({
        xPosition: textWidth,
        yPosition: 0,
        width: rightBarWidth,
        height: DISPLAY_HEIGHT,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 0,
        containerID: 2,
        containerName: 'sidebar',
        content: verticalContent,
        isEventCapture: 0,
      });
      textObjects.push(sideContainer);
    }

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: textObjects.length,
        textObject: textObjects,
      }),
    );

    await this.savePagedPosition();

    setStatus(
      `Ch ${this.chapterIndex + 1
      } / ${this.book.chapters.length}: ${chapter.title} | Page ${this.pageIndex + 1}/${totalPages}`,
    );
  }

  private async showFlowReading(autoStart: boolean): Promise<void> {
    if (!this.book || this.flowPageData.length === 0) return;
    this.view = 'flowReading';
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

    const maxChars = config.statusBarPosition === 'right' ? 58 : 59;
    const remainingStandardChars = Math.max(0, maxChars - infoText.length);
    let targetBarLen = Math.floor(remainingStandardChars / 1.6) - 2;
    targetBarLen = Math.max(5, Math.min(20, targetBarLen));
    const filled = Math.round(targetBarLen * progress);
    const bar = '━'.repeat(filled) + '─'.repeat(targetBarLen - filled);
    const label = `${infoText}[${bar}]`;

    const hasBottomBar = config.statusBarPosition === 'bottom';
    const hasRightBar = config.statusBarPosition === 'right';
    const barHeight = hasBottomBar ? BAR_HEIGHT : 0;
    const rightBarWidth = hasRightBar ? 26 : 0;
    const textHeight = DISPLAY_HEIGHT - barHeight;
    const textWidth = DISPLAY_WIDTH - rightBarWidth;

    const textContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: textWidth,
      height: textHeight,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 6,
      containerID: 1,
      containerName: 'flow-text',
      content: content || '...',
      isEventCapture: 1,
    });

    const textObjects = [textContainer];
    if (hasBottomBar) {
      textObjects.push(
        new TextContainerProperty({
          xPosition: 0,
          yPosition: textHeight,
          width: DISPLAY_WIDTH,
          height: barHeight,
          borderWidth: 0,
          borderColor: 5,
          paddingLength: 0,
          containerID: 2,
          containerName: 'flow-footer',
          content: label,
          isEventCapture: 0,
        }),
      );
    } else if (hasRightBar) {
      const verticalBarLines = 8;
      const verticalFilled = Math.round(verticalBarLines * progress);
      const verticalBar = '█'.repeat(verticalFilled) + '│'.repeat(verticalBarLines - verticalFilled);
      const verticalContent = verticalBar.split('').join('\n');
      textObjects.push(
        new TextContainerProperty({
          xPosition: textWidth,
          yPosition: 0,
          width: rightBarWidth,
          height: DISPLAY_HEIGHT,
          borderWidth: 0,
          borderColor: 5,
          paddingLength: 0,
          containerID: 2,
          containerName: 'flow-side',
          content: verticalContent,
          isEventCapture: 0,
        }),
      );
    }

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: textObjects.length,
        textObject: textObjects,
      }),
    );

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
          borderRdaius: 8,
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
    this.scheduleFlowTick();
    this.showFlowFrame().catch((e) => console.warn('Failed to render flow frame:', e));
  }

  private stopFlow(): void {
    if (this.flowTimerId !== null) {
      window.clearTimeout(this.flowTimerId);
      this.flowTimerId = null;
    }
    this.isFlowRunning = false;
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
    } else if (this.book) {
      await this.showChapterList();
    } else {
      await this.showWelcome();
    }
  }

  // --- Event Handling ---

  private swipeThrottleOk(): boolean {
    const now = Date.now();
    if (now - this.lastSwipeTime < SWIPE_COOLDOWN_MS) return false;
    this.lastSwipeTime = now;
    return true;
  }

  private async onEvenHubEvent(event: EvenHubEvent): Promise<void> {
    appendEventLog(`Event: ${JSON.stringify(event)
      }`);

    const te = event?.textEvent ?? event?.sysEvent;
    if (!te) return;

    const eventType = te.eventType;

    if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      if (!this.swipeThrottleOk()) return;
      if (this.view === 'reading') {
        await this.nextPage();
      } else if (this.view === 'flowReading') {
        await this.nextChapterInFlow();
      } else if (this.view === 'library') {
        await this.nextChapterInList();
      }
      return;
    }

    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      if (!this.swipeThrottleOk()) return;
      if (this.view === 'reading') {
        await this.prevPage();
      } else if (this.view === 'flowReading') {
        await this.prevChapterInFlow();
      } else if (this.view === 'library') {
        await this.prevChapterInList();
      }
      return;
    }

    if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      if (this.view === 'reading' && this.book) {
        appendEventLog('Double tap -> chapter list');
        this.librarySelectedIndex = this.chapterIndex;
        await this.showChapterList();
      } else if (this.view === 'flowReading' && this.book) {
        if (this.isFlowRunning) {
          appendEventLog('Double tap ignored while flow is running');
        } else {
          appendEventLog('Double tap -> chapter list (flow paused)');
          this.librarySelectedIndex = this.chapterIndex;
          await this.showChapterList();
        }
      } else if (this.view === 'library' && this.book) {
        appendEventLog('Double tap -> exit book');
        this.book = null;
        this.stopFlow();
        await this.showWelcome();
      }
      return;
    }

    // CLICK_EVENT = 0, which fromJson may normalize to undefined
    if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
      if (this.view === 'flowReading' && this.book) {
        appendEventLog('Click -> flow start/pause');
        this.toggleFlow();
      } else if (this.view === 'library' && this.book) {
        appendEventLog(`Opening chapter ${this.librarySelectedIndex + 1} `);
        await this.selectCurrentChapter();
      }
      return;
    }
  }

  // --- Persistence ---

  private async savePagedPosition(): Promise<void> {
    if (!this.book) return;
    try {
      const pos: ReadingPosition = {
        chapterIndex: this.chapterIndex,
        pageIndex: this.pageIndex,
      };
      await this.bridge.setLocalStorage(`${STORAGE_KEY_POSITION}-${this.book.title}`, JSON.stringify(pos));
      await this.bridge.setLocalStorage(STORAGE_KEY_BOOK_TITLE, this.book.title);
    } catch (e) {
      console.warn('Failed to save position:', e);
      appendEventLog('Warning: Could not save reading position');
    }
  }

  public async getSavedPosition(bookTitle: string): Promise<ReadingPosition | null> {
    try {
      const raw = await this.bridge.getLocalStorage(`${STORAGE_KEY_POSITION}-${bookTitle}`);
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
      return null;
    } catch (e) {
      return null;
    }
  }

  private async restorePagedPosition(bookTitle: string): Promise<ReadingPosition | null> {
    try {
      const raw = await this.bridge.getLocalStorage(`${STORAGE_KEY_POSITION}-${bookTitle}`);
      if (!raw) return null;

      const pos: ReadingPosition = JSON.parse(raw);
      if (
        pos.chapterIndex >= 0 &&
        pos.chapterIndex < this.chapterPages.length &&
        pos.pageIndex >= 0 &&
        pos.pageIndex < this.chapterPages[pos.chapterIndex].length
      ) {
        appendEventLog(`Restored position: Ch ${pos.chapterIndex + 1}, Pg ${pos.pageIndex + 1} `);
        return pos;
      }
    } catch (e) {
      console.warn('Failed to restore position:', e);
      appendEventLog('Warning: Could not restore reading position');
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
      await this.bridge.setLocalStorage(`${STORAGE_KEY_FLOW_POSITION}-${this.book.title}`, JSON.stringify(pos));
      await this.bridge.setLocalStorage(STORAGE_KEY_BOOK_TITLE, this.book.title);
    } catch (e) {
      console.warn('Failed to save flow position:', e);
      appendEventLog('Warning: Could not save flow position');
    }
  }

  private async restoreFlowPosition(bookTitle: string): Promise<ReadingPosition | null> {
    try {
      const raw = await this.bridge.getLocalStorage(`${STORAGE_KEY_FLOW_POSITION}-${bookTitle}`);
      if (!raw) return null;

      const pos: ReadingPosition = JSON.parse(raw);
      const pageIndex = pos.pageIndex ?? 0;
      const wordIndex = pos.wordIndex ?? 0;
      const chapterPages = this.flowPageData[pos.chapterIndex];
      if (
        pos.chapterIndex >= 0 &&
        pos.chapterIndex < this.flowPageData.length &&
        pageIndex >= 0 &&
        pageIndex < (chapterPages?.length ?? 0) &&
        wordIndex >= 0 &&
        wordIndex < Math.max(1, chapterPages[pageIndex].wordCount)
      ) {
        appendEventLog(`Restored flow position: Ch ${pos.chapterIndex + 1}, Pg ${pageIndex + 1}, Word ${wordIndex + 1}`);
        return {
          chapterIndex: pos.chapterIndex,
          pageIndex,
          wordIndex,
        };
      }
    } catch (e) {
      console.warn('Failed to restore flow position:', e);
      appendEventLog('Warning: Could not restore flow position');
    }
    return null;
  }
}
