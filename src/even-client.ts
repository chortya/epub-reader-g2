
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
  STORAGE_KEY_BOOK_TITLE,
  STORAGE_KEY_POSITION,
  SWIPE_COOLDOWN_MS,
} from './constants';
import { appendEventLog, clamp, setStatus, truncateForList } from './utils';

type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>;

const ITEMS_PER_PAGE = 4;
const ROW_HEIGHT = Math.floor(DISPLAY_HEIGHT / ITEMS_PER_PAGE); // 72px

const BAR_HEIGHT = 30;
const TEXT_HEIGHT = DISPLAY_HEIGHT - BAR_HEIGHT; // Fill the full display height

export class EvenEpubClient {
  private view: ViewState = 'library';
  private book: Book | null = null;
  private chapterPages: string[][] = [];
  private chapterIndex = 0;
  private pageIndex = 0;
  private librarySelectedIndex = 0;
  private isInitializedUi = false;
  private lastSwipeTime = 0;

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

  async loadBook(book: Book): Promise<void> {
    this.book = book;
    this.chapterPages = book.chapters.map((ch) => paginateText(ch.text));

    const restored = await this.restorePosition(book.title);
    if (restored) {
      this.chapterIndex = restored.chapterIndex;
      this.pageIndex = restored.pageIndex;
    } else {
      this.chapterIndex = 0;
      this.pageIndex = 0;
    }

    this.librarySelectedIndex = 0;
    setStatus(`Loaded: ${book.title} (${book.chapters.length} chapters)`);
    await this.showChapterList();
  }

  async applySettings(): Promise<void> {
    if (this.book && this.chapterPages.length > 0) {
      const oldTotalPages = this.chapterPages[this.chapterIndex]?.length || 1;
      const progress = this.pageIndex / oldTotalPages;
      this.chapterPages = this.book.chapters.map((ch) => paginateText(ch.text));
      const newTotalPages = this.chapterPages[this.chapterIndex]?.length || 1;
      this.pageIndex = Math.max(0, Math.min(Math.floor(progress * newTotalPages), newTotalPages - 1));
      await this.savePosition();
      await this.refreshCurrentView();
    } else if (this.view === 'library' && !this.book) {
      await this.showWelcome();
    }
  }

  // --- UI Setup ---

  private getWelcomeContainers(): TextContainerProperty[] {
    const title = 'G2 ePUB Reader';
    const titlePad = Math.floor((config.charsPerLine - title.length) / 2);
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
    const instrPad = Math.floor((config.charsPerLine - instruction.length) / 2);
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
    this.view = 'library';

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: this.getWelcomeContainers(),
      }),
    );

    setStatus('Ready. Upload an EPUB file or download from Gutenberg.');
  }

  private async showChapterList(): Promise<void> {
    if (!this.book) return;
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
      `Chapters: ${this.librarySelectedIndex + 1}/${total}. Swipe=browse, Tap=read, DblTap=resume`,
    );
    appendEventLog(`Chapter list page ${pageStart + 1}-${Math.min(pageStart + ITEMS_PER_PAGE, total)}`);
  }

  private async showPage(): Promise<void> {
    if (!this.book || this.chapterPages.length === 0) return;
    this.view = 'reading';

    const pages = this.chapterPages[this.chapterIndex];
    const page = pages[this.pageIndex];
    const chapter = this.book.chapters[this.chapterIndex];
    const totalPages = pages.length;
    const progress = totalPages > 1 ? (this.pageIndex + 1) / totalPages : 1;

    // Unicode progress bar: ━ filled, ─ empty
    const barLen = 30;
    const filled = Math.round(barLen * progress);
    const label = '━'.repeat(filled) + '─'.repeat(barLen - filled);

    // Text container: top area for page content
    const textContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: DISPLAY_WIDTH,
      height: TEXT_HEIGHT,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 6,
      containerID: 1,
      containerName: 'text',
      content: page,
      isEventCapture: 1,
    });

    // Footer container: thin bottom strip for progress
    const footerContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: TEXT_HEIGHT,
      width: DISPLAY_WIDTH,
      height: BAR_HEIGHT,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 0,
      containerID: 2,
      containerName: 'footer',
      content: label,
      isEventCapture: 0,
    });

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: [textContainer, footerContainer],
      }),
    );

    await this.savePosition();

    setStatus(
      `Ch ${this.chapterIndex + 1
      } / ${this.book.chapters.length}: ${chapter.title} | Page ${this.pageIndex + 1}/${totalPages}`,
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
    await this.showPage();
  }

  private async refreshCurrentView(): Promise<void> {
    if (this.view === 'reading') {
      await this.showPage();
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
      } else if (this.view === 'library') {
        await this.nextChapterInList();
      }
      return;
    }

    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      if (!this.swipeThrottleOk()) return;
      if (this.view === 'reading') {
        await this.prevPage();
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
      } else if (this.view === 'library' && this.book) {
        appendEventLog('Double tap -> exit book');
        this.book = null;
        await this.showWelcome();
      }
      return;
    }

    // CLICK_EVENT = 0, which fromJson may normalize to undefined
    if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
      if (this.view === 'library' && this.book) {
        appendEventLog(`Opening chapter ${this.librarySelectedIndex + 1} `);
        await this.selectCurrentChapter();
      }
      return;
    }
  }

  // --- Persistence ---

  private async savePosition(): Promise<void> {
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

  private async restorePosition(bookTitle: string): Promise<ReadingPosition | null> {
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
}
