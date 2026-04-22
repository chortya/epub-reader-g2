
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
import type { LaunchIntent } from './launch';
import { pickInitialView } from './launch';
import { resolveLastBook } from './book-id';
import { paginateText } from './paginator';
import {
  config,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  FLOW_MAX_WPM,
  FLOW_MIN_WPM,
  FLOW_SPEED_VALUES,
  STORAGE_KEY_BOOK_TITLE,
  STORAGE_KEY_FLOW_POSITION,
  STORAGE_KEY_LAST_BOOK_FILENAME,
  STORAGE_KEY_LAST_BOOK_ID,
  STORAGE_KEY_POSITION,
  TEXT_HEIGHT_VALUES,
  applyEditorValue,
  formatSettingsRow,
  formatStatusLine,
  getTextLayout,
  saveSettings,
  saveSettingsToBridge,
  type SettingKey,
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

// Order in which settings appear in the on-device menu. Kept here (not in
// constants.ts) because the rendering concern is per-view.
const SETTINGS_MENU_KEYS: readonly SettingKey[] = [
  'hyphenation',
  'statusBarPosition',
  'readingMode',
  'flowSpeedWpm',
  'textHeightPercent',
];

// Value arrays for each key's editor. Enums/booleans are inlined; numeric
// ranges come from constants.ts. Order matches applyEditorValue's index map.
const EDITOR_VALUE_LABELS: Record<SettingKey, readonly string[]> = {
  hyphenation: ['ON', 'OFF'],
  statusBarPosition: ['Bottom', 'Hidden'],
  readingMode: ['Paged', 'Flow'],
  flowSpeedWpm: FLOW_SPEED_VALUES.map((v) => `${v} wpm`),
  textHeightPercent: TEXT_HEIGHT_VALUES.map((v) => `${v}%`),
};

function currentEditorIndex(key: SettingKey): number {
  switch (key) {
    case 'hyphenation':
      return config.hyphenation ? 0 : 1;
    case 'statusBarPosition':
      return config.statusBarPosition === 'bottom' ? 0 : 1;
    case 'readingMode':
      return config.readingMode === 'paged' ? 0 : 1;
    case 'flowSpeedWpm': {
      // argmin |v − config.flowSpeedWpm|
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < FLOW_SPEED_VALUES.length; i++) {
        const d = Math.abs(FLOW_SPEED_VALUES[i] - config.flowSpeedWpm);
        if (d < bestDist) { best = i; bestDist = d; }
      }
      return best;
    }
    case 'textHeightPercent': {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < TEXT_HEIGHT_VALUES.length; i++) {
        const d = Math.abs(TEXT_HEIGHT_VALUES[i] - config.textHeightPercent);
        if (d < bestDist) { best = i; bestDist = d; }
      }
      return best;
    }
  }
}

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
  private mainMenuSelectedIndex = 0;
  private launchIntent: LaunchIntent = null;
  // Cached at showMainMenu time so the SELECT dispatch does not re-hit the bridge.
  private continueReadingResolved: CachedBookMeta | null = null;

  // Settings-menu state (Stage 6). settingsListSelectedIndex indexes into
  // SETTINGS_MENU_KEYS; editingSettingKey is non-null while the editor view
  // is active; editorSelectedIndex indexes into the per-key value array.
  private settingsListSelectedIndex = 0;
  private editingSettingKey: SettingKey | null = null;
  private editorSelectedIndex = 0;

  // Clock ticker state (Stage 4). Only runs while the view is reading/flowReading.
  // 10 s poll period with a string-compare gate — wakes up often enough to catch
  // the next minute boundary within 10 s without hammering textContainerUpgrade.
  private clockTickerId: number | null = null;
  private lastMinuteString: string | null = null;

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

      // Stage 6 guard: when the user edited a setting from the on-device
      // settings UI, we only repaginate — we do NOT auto-switch into the
      // reading view. commitEditor() will route the user back to the
      // settings list; the user chooses when to return to reading via
      // mainMenu -> Continue. Also invalidate flowLayoutReady so the next
      // re-entry into flow does a full rebuild.
      if (this.view === 'settings' || this.view === 'settingEditor') {
        this.flowLayoutReady = false;
      } else if (config.readingMode === 'flow' && this.view === 'reading') {
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

    // Post-splash: decide between mainMenu and direct resume per §3.1a.
    // Resolve the last book from L3 keys once, then let pickInitialView pick
    // the view based on launch intent. For glassesMenu + resolvable book we
    // bypass mainMenu and hand off to onBookSelected (same path as picker tap).
    const lastBook = await this.resolveLastBookFromBridge();
    const initial = pickInitialView(this.launchIntent, lastBook, config.readingMode);
    if (initial !== 'mainMenu' && lastBook && this.onBookSelected) {
      // Pre-select the book in the picker for correctness on back-out.
      const idx = this.cachedBookList.findIndex((b) => b.bookId === lastBook.bookId);
      if (idx >= 0) this.bookPickerSelectedIndex = idx;
      try {
        await this.onBookSelected(lastBook);
        return;
      } catch (e) {
        console.warn('glassesMenu auto-resume failed; falling back to mainMenu:', e);
      }
    }
    await this.showMainMenu();
  }

  /** Read L3 keys from the bridge and resolve them against the cached book list. */
  private async resolveLastBookFromBridge(): Promise<CachedBookMeta | null> {
    if (this.cachedBookList.length === 0) return null;
    try {
      const [bookId, title, filename] = await Promise.all([
        this.bridge.getLocalStorage(STORAGE_KEY_LAST_BOOK_ID),
        this.bridge.getLocalStorage(STORAGE_KEY_BOOK_TITLE),
        this.bridge.getLocalStorage(STORAGE_KEY_LAST_BOOK_FILENAME),
      ]);
      return resolveLastBook(this.cachedBookList, {
        bookId: bookId || undefined,
        title: title || undefined,
        filename: filename || undefined,
      });
    } catch {
      return null;
    }
  }

  /** Called by main.ts before init() so runStartup can consult the launch source. */
  public setLaunchIntent(intent: LaunchIntent): void {
    this.launchIntent = intent;
  }

  private async showMainMenu(): Promise<void> {
    this.stopFlow();
    this.stopClockTicker();
    this.view = 'mainMenu';

    // Three slots: Continue, Library (N), Settings. Slot 0 label reflects
    // whether a last book is resolvable (bookId-first via resolveLastBook).
    // Stable 3-slot layout — see decision Q3. Slot 3 is blank.
    const resolved = await this.resolveLastBookFromBridge();
    this.continueReadingResolved = resolved;
    const continueLabel = resolved ? 'Continue reading' : '(No recent book)';
    const libraryLabel = `Library (${this.cachedBookList.length})`;
    const labels = [continueLabel, libraryLabel, 'Settings', ''];
    const selectedSlot = Math.max(0, Math.min(2, this.mainMenuSelectedIndex));
    await this.rebuildSlots(labels, selectedSlot);
    setStatus(`Main menu: ${selectedSlot + 1}/3. Swipe=browse, Tap=open, DblTap=exit`);
    this.onViewChanged?.();
  }

  private async showSettingsMenu(): Promise<void> {
    this.stopFlow();
    this.stopClockTicker();
    this.view = 'settings';
    this.editingSettingKey = null;

    const total = SETTINGS_MENU_KEYS.length;
    const pageStart = Math.floor(this.settingsListSelectedIndex / ITEMS_PER_PAGE) * ITEMS_PER_PAGE;
    const selectedSlot = this.settingsListSelectedIndex - pageStart;

    const labels: string[] = [];
    for (let i = 0; i < ITEMS_PER_PAGE; i++) {
      const idx = pageStart + i;
      labels.push(idx < total ? formatSettingsRow(SETTINGS_MENU_KEYS[idx], config) : '');
    }

    await this.rebuildSlots(labels, selectedSlot);
    setStatus(`Settings: ${this.settingsListSelectedIndex + 1}/${total}. Swipe=browse, Tap=edit, DblTap=back`);
    this.onViewChanged?.();
  }

  private async showSettingEditor(key: SettingKey): Promise<void> {
    this.stopFlow();
    this.stopClockTicker();
    this.view = 'settingEditor';
    this.editingSettingKey = key;
    this.editorSelectedIndex = currentEditorIndex(key);

    const values = EDITOR_VALUE_LABELS[key];
    const total = values.length;
    const pageStart = Math.floor(this.editorSelectedIndex / ITEMS_PER_PAGE) * ITEMS_PER_PAGE;
    const selectedSlot = this.editorSelectedIndex - pageStart;

    const labels: string[] = [];
    for (let i = 0; i < ITEMS_PER_PAGE; i++) {
      const idx = pageStart + i;
      labels.push(idx < total ? values[idx] : '');
    }
    await this.rebuildSlots(labels, selectedSlot);
    setStatus(`Edit ${key}: ${this.editorSelectedIndex + 1}/${total}. Swipe=move, Tap=save, DblTap=cancel`);
  }

  /**
   * Commit the currently-highlighted editor value. Bridge write runs in
   * parallel with applySettings per Codex #3 / design §4.4 — the user sees
   * the updated UI immediately regardless of bridge latency.
   */
  private async commitEditor(): Promise<void> {
    const key = this.editingSettingKey;
    if (key === null) return;
    applyEditorValue(config, key, this.editorSelectedIndex);
    saveSettings();
    const bridgeWrite = saveSettingsToBridge(this.bridge as any)
      .catch((e) => console.warn('commitEditor: bridge write failed:', e));
    try {
      await this.applySettings();
    } catch (e) {
      console.warn('commitEditor: applySettings failed:', e);
    }
    await this.showSettingsMenu();
    await bridgeWrite;
  }

  private async nextSettingsListItem(): Promise<void> {
    if (this.settingsListSelectedIndex < SETTINGS_MENU_KEYS.length - 1) {
      this.settingsListSelectedIndex++;
      await this.showSettingsMenu();
    }
  }

  private async prevSettingsListItem(): Promise<void> {
    if (this.settingsListSelectedIndex > 0) {
      this.settingsListSelectedIndex--;
      await this.showSettingsMenu();
    }
  }

  private async nextEditorValue(): Promise<void> {
    const key = this.editingSettingKey;
    if (!key) return;
    const total = EDITOR_VALUE_LABELS[key].length;
    if (this.editorSelectedIndex < total - 1) {
      this.editorSelectedIndex++;
      // Rerender via the same path; avoid re-reading config because we want
      // the user's in-flight pick (not the committed value) reflected.
      await this.rerenderEditor();
    }
  }

  private async prevEditorValue(): Promise<void> {
    if (!this.editingSettingKey) return;
    if (this.editorSelectedIndex > 0) {
      this.editorSelectedIndex--;
      await this.rerenderEditor();
    }
  }

  private async rerenderEditor(): Promise<void> {
    const key = this.editingSettingKey;
    if (!key) return;
    const values = EDITOR_VALUE_LABELS[key];
    const total = values.length;
    const pageStart = Math.floor(this.editorSelectedIndex / ITEMS_PER_PAGE) * ITEMS_PER_PAGE;
    const selectedSlot = this.editorSelectedIndex - pageStart;

    const labels: string[] = [];
    for (let i = 0; i < ITEMS_PER_PAGE; i++) {
      const idx = pageStart + i;
      labels.push(idx < total ? values[idx] : '');
    }
    await this.rebuildSlots(labels, selectedSlot);
    setStatus(`Edit ${key}: ${this.editorSelectedIndex + 1}/${total}. Swipe=move, Tap=save, DblTap=cancel`);
  }

  private async showBookPicker(): Promise<void> {
    this.stopFlow();
    this.stopClockTicker();
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
    this.stopClockTicker();
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
    this.stopClockTicker();
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

    // Status-line content: "HH:MM  Ch C/T Pg P/N [━━━───]". Clock updates via
    // the periodic clockTicker (every 10 s with a string-compare gate); the
    // full label is also re-rendered on every page turn. See design §7.
    const hasBottomBar = config.statusBarPosition === 'bottom';
    const label = formatStatusLine({
      now: new Date(),
      infoText,
      maxChars: 59,
      progress,
    });

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
    this.startClockTicker();

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
    const label = formatStatusLine({
      now: new Date(),
      infoText,
      maxChars: 59,
      progress,
    });

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
    this.startClockTicker();
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
      this.stopClockTicker();
      if (this.view === 'flowReading') await this.saveFlowPosition();
      else await this.savePagedPosition();
      return;
    }
    if (sysEvent?.eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      await this.refreshCurrentView();
      if (this.view === 'reading' || this.view === 'flowReading') {
        this.startClockTicker();
      }
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
          else if (this.view === 'mainMenu') await this.nextMainMenuSlot();
          else if (this.view === 'settings') await this.nextSettingsListItem();
          else if (this.view === 'settingEditor') await this.nextEditorValue();
        } else {
          if (this.view === 'reading') await this.prevPage();
          else if (this.view === 'flowReading') await this.prevChapterInFlow();
          else if (this.view === 'library') await this.prevChapterInList();
          else if (this.view === 'bookPicker') await this.prevBookInPicker();
          else if (this.view === 'mainMenu') await this.prevMainMenuSlot();
          else if (this.view === 'settings') await this.prevSettingsListItem();
          else if (this.view === 'settingEditor') await this.prevEditorValue();
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
        } else if (this.view === 'mainMenu') {
          await this.onMainMenuSelect();
        } else if (this.view === 'settings') {
          const key = SETTINGS_MENU_KEYS[this.settingsListSelectedIndex];
          if (key) await this.showSettingEditor(key);
        } else if (this.view === 'settingEditor') {
          await this.commitEditor();
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
          // Back from chapter list now routes to mainMenu (was bookPicker/welcome).
          this.book = null;
          this.stopFlow();
          await this.showMainMenu();
        } else if (this.view === 'bookPicker' || (this.view === 'library' && !this.book)) {
          // Back from picker/welcome now routes to mainMenu (was exit-app).
          await this.showMainMenu();
        } else if (this.view === 'mainMenu') {
          // Exit-app lives on mainMenu dbltap now.
          try { await this.bridge.shutDownPageContainer(1); } catch { /* */ }
        } else if (this.view === 'settings') {
          await this.showMainMenu();
        } else if (this.view === 'settingEditor') {
          // Cancel: discard the highlighted value, return to settings list.
          this.editingSettingKey = null;
          await this.showSettingsMenu();
        }
        break;
    }
  }

  // Main-menu navigation (3 fixed slots — see design §3.2).
  private async nextMainMenuSlot(): Promise<void> {
    if (this.mainMenuSelectedIndex < 2) {
      this.mainMenuSelectedIndex++;
      await this.showMainMenu();
    }
  }

  private async prevMainMenuSlot(): Promise<void> {
    if (this.mainMenuSelectedIndex > 0) {
      this.mainMenuSelectedIndex--;
      await this.showMainMenu();
    }
  }

  /**
   * Dispatch a SELECT_HIGHLIGHTED event on the mainMenu. Slot 0 (Continue) is
   * a stub here — Stage 7 replaces it with resolveLastBook-driven hand-off.
   * Slot 2 (Settings) is a stub — Stage 6 replaces it with showSettingsMenu().
   */
  private async onMainMenuSelect(): Promise<void> {
    switch (this.mainMenuSelectedIndex) {
      case 0: {
        // Continue Reading: hand off to the same callback the bookPicker uses.
        // If nothing is resolvable, slot 0 shows "(No recent book)" and the
        // tap is a no-op (stable layout per Q3).
        const resolved = this.continueReadingResolved;
        if (!resolved || !this.onBookSelected) {
          appendEventLog('No recent book to continue');
          return;
        }
        try {
          await this.onBookSelected(resolved);
        } catch (e) {
          console.warn('Continue Reading failed:', e);
        }
        return;
      }
      case 1:
        if (this.cachedBookList.length > 0) await this.showBookPicker();
        else await this.showWelcome();
        return;
      case 2:
        this.settingsListSelectedIndex = 0;
        await this.showSettingsMenu();
        return;
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
    this.stopClockTicker();
    if (this.view === 'flowReading') await this.saveFlowPosition();
    else await this.savePagedPosition();
    try { await this.bridge.shutDownPageContainer(); } catch { /* */ }
  }

  // --- Clock ticker (Stage 4) ---

  private startClockTicker(): void {
    // Belt-and-suspenders: clear any existing timer so a double-call never
    // leaks an interval (§12.1 risk list, mitigation).
    if (this.clockTickerId !== null) {
      window.clearInterval(this.clockTickerId);
      this.clockTickerId = null;
    }
    this.lastMinuteString = this.formatHHMM(new Date());
    this.clockTickerId = window.setInterval(() => {
      this.tickClock().catch((e) => console.warn('clock tick failed:', e));
    }, 10_000);
  }

  private stopClockTicker(): void {
    if (this.clockTickerId !== null) {
      window.clearInterval(this.clockTickerId);
      this.clockTickerId = null;
    }
    this.lastMinuteString = null;
  }

  private formatHHMM(now: Date): string {
    const h = now.getHours();
    const m = now.getMinutes();
    return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`;
  }

  private async tickClock(): Promise<void> {
    // Only refresh the footer for the two views that actually render it.
    if (this.view !== 'reading' && this.view !== 'flowReading') return;
    if (config.statusBarPosition !== 'bottom') return;
    const current = this.formatHHMM(new Date());
    if (current === this.lastMinuteString) return;
    this.lastMinuteString = current;

    // §7.4 invariant: upgrade container 2 in place. Both showPage and
    // showFlowFrame render the footer as container ID 2 (names 'footer' and
    // 'flow-footer' respectively). textContainerUpgrade is flicker-free.
    const label = this.buildCurrentFooterLabel();
    if (label === null) return;
    const name = this.view === 'reading' ? 'footer' : 'flow-footer';
    try {
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: 2, containerName: name, content: label }),
      );
    } catch (e) {
      console.warn('clock tick textContainerUpgrade failed:', e);
    }
  }

  private buildCurrentFooterLabel(): string | null {
    if (!this.book) return null;
    if (this.view === 'reading') {
      const totalPages = this.chapterPages[this.chapterIndex]?.length ?? 1;
      const totalChapters = this.book.chapters.length;
      const infoText = `Ch ${this.chapterIndex + 1}/${totalChapters} Pg ${this.pageIndex + 1}/${totalPages} `;
      let totalBookPages = 0, currentAbsolutePage = 0;
      for (let i = 0; i < this.chapterPages.length; i++) {
        if (i < this.chapterIndex) currentAbsolutePage += this.chapterPages[i].length;
        else if (i === this.chapterIndex) currentAbsolutePage += this.pageIndex + 1;
        totalBookPages += this.chapterPages[i].length;
      }
      const progress = totalBookPages > 1 ? currentAbsolutePage / totalBookPages : 1;
      return formatStatusLine({ now: new Date(), infoText, maxChars: 59, progress });
    }
    // flowReading
    const pageData = this.flowPageData[this.chapterIndex]?.[this.pageIndex];
    if (!pageData) return null;
    const totalPageWords = Math.max(1, pageData.wordCount);
    const flowState = this.isFlowRunning ? 'RUN' : 'PAUSE';
    const chapterTotalPages = this.chapterPages[this.chapterIndex]?.length ?? 1;
    const infoText = `Flow ${flowState} ${config.flowSpeedWpm}wpm Ch ${this.chapterIndex + 1}/${this.book.chapters.length} Pg ${this.pageIndex + 1}/${chapterTotalPages} W ${this.flowWordIndex + 1}/${totalPageWords} `;
    let totalBookWords = 0, currentAbsoluteWord = 0;
    for (let ch = 0; ch < this.flowPageData.length; ch++) {
      for (let pg = 0; pg < this.flowPageData[ch].length; pg++) {
        const pw = this.flowPageData[ch][pg].wordCount;
        totalBookWords += pw;
        if (ch < this.chapterIndex || (ch === this.chapterIndex && pg < this.pageIndex)) {
          currentAbsoluteWord += pw;
        } else if (ch === this.chapterIndex && pg === this.pageIndex) {
          currentAbsoluteWord += this.flowWordIndex + 1;
        }
      }
    }
    const progress = totalBookWords > 1 ? currentAbsoluteWord / totalBookWords : 1;
    return formatStatusLine({ now: new Date(), infoText, maxChars: 59, progress });
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
