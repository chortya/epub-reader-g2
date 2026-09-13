
import {
  CreateStartUpPageContainer,
  DeviceConnectType,
  ImageContainerProperty,
  ImageRawDataUpdate,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import { mapGlassEvent } from 'even-toolkit/action-map';
import { notifyTextUpdate, resetGestureState } from 'even-toolkit/gestures';
import { createSplash } from 'even-toolkit/splash';
import { encodeTilesBatch } from 'even-toolkit/png-utils';
import { drawBookMark, GREY_BRIGHT, GREY_DIM, GREY_MID } from './brand';
import { version as APP_VERSION } from '../package.json';
import type { Book, ReadingPosition, ViewState, CachedBookMeta } from './types';
import type { LaunchIntent } from './launch';
import { pickInitialView } from './launch';
import { resolveLastBook } from './book-id';
import { formatBookPickerLabel } from './book-selection';
import { paginateText, paginateTextWithOffsets, pageForOffset, flowOffsetForWord, flowWordForOffset, PAGINATION_VERSION } from './paginator';
import {
  config,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  FLOW_MAX_WPM,
  FLOW_MIN_WPM,
  FLOW_SPEED_VALUES,
  STORAGE_KEY_BOOK_TITLE,
  STORAGE_KEY_LAST_BOOK_FILENAME,
  STORAGE_KEY_LAST_BOOK_ID,
  TEXT_HEIGHT_VALUES,
  TEXT_BRIGHTNESS_VALUES,
  applyEditorValue,
  formatSettingsRow,
  formatStatusLine,
  getTextLayout,
  saveSettings,
  saveSettingsToBridge,
  type SettingKey,
} from './constants';
import { clamp, setStatus, truncateForList, appendEventLog } from './utils';
import { createSerialExecutor, type SerialExecutor } from './operation-queue';
import {
  reduceLifecycle,
  PAGED_MENU_ITEMS,
  FLOW_MENU_ITEMS,
  MENU_CONTENTS,
  MENU_SWITCH_MODE,
  MENU_SET_BOOKMARK,
  MENU_GO_BOOKMARK,
  MENU_MAIN_MENU,
  MENU_FASTER,
  MENU_SLOWER,
  type LifecycleState,
} from './lifecycle';
import { sentenceStartBefore, nextSentenceStart } from './sentences';
import { measureWidth, FOOTER_INNER_WIDTH } from './text-metrics';
import { createSplashBridgeAdapter } from './splash-bridge';
import {
  ITEMS_PER_PAGE,
  ROW_HEIGHT,
  centerLabel,
  computeBoxWidthPx,
  computeRowOffsets,
  trimTrailingEmptySlots,
  CHAR_PITCH_PX,
} from './layout';
import {
  createPositionPersister,
  pagedPositionKeys,
  flowPositionKeys,
  readPositionFromKeys,
  writeLastBookKeys,
  type PositionBridge,
  type PositionPersister,
} from './position-store';
import {
  computePagedProgress,
  computeFlowProgress,
  routeGoBack,
  toggleStatusBarPosition,
} from './reading-progress';

type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>;

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
  'textBrightness',
];

// Value arrays for each key's editor. Enums/booleans are inlined; numeric
// ranges come from constants.ts. Order matches applyEditorValue's index map.
const EDITOR_VALUE_LABELS: Record<SettingKey, readonly string[]> = {
  hyphenation: ['ON', 'OFF'],
  statusBarPosition: ['Bottom', 'Hidden'],
  readingMode: ['Paged', 'Flow'],
  flowSpeedWpm: FLOW_SPEED_VALUES.map((v) => `${v} wpm`),
  textHeightPercent: TEXT_HEIGHT_VALUES.map((v) => `${v}%`),
  textBrightness: TEXT_BRIGHTNESS_VALUES.map((v) => `${v}/4`),
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
    case 'textBrightness': {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < TEXT_BRIGHTNESS_VALUES.length; i++) {
        const d = Math.abs(TEXT_BRIGHTNESS_VALUES[i] - config.textBrightness);
        if (d < bestDist) { best = i; bestDist = d; }
      }
      return best;
    }
  }
}

export class EvenEpubClient {
  private view: ViewState = 'welcome'; // Starts as welcome, transitions after init
  private book: Book | null = null;
  private chapterPages: string[][] = [];
  /** Parallel to chapterPages: source offset of each page's first char (position v2). */
  private chapterPageStarts: number[][] = [];
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

  // Debounced position persistence (Phase 1.4): page turns schedule, lifecycle
  // exits save immediately, flush() lands pending writes before a book switch.
  private persister: PositionPersister;
  // FIFO queue for gesture-driven SDK work (Phase 1.6): swipes never overlap.
  private serialGesture: SerialExecutor;
  // Foreground lifecycle (Phase 3): disambiguates menu ENTER/EXIT from real
  // background/foreground; holds a menu click until the overlay closes.
  private lifecycleState: LifecycleState = 'active';
  private pendingMenuAction: number | null = null;
  // Reading-view brightness (Phase 3): body text 1-4, secondary text 3.
  private static readonly FOOTER_TEXT_COLOR = 3;
  // Flow pace tracking (Phase 3.5): active-reading time + words, session-scoped.
  private flowPaceWords = 0;
  private flowPaceMs = 0;
  private flowPaceWindowStart = 0;

  // Settings-menu state (Stage 6). settingsListSelectedIndex indexes into
  // SETTINGS_MENU_KEYS; editingSettingKey is non-null while the editor view
  // is active; editorSelectedIndex indexes into the per-key value array.
  private settingsListSelectedIndex = 0;
  private editingSettingKey: SettingKey | null = null;
  private editorSelectedIndex = 0;
  /** Index of the currently-SAVED value — marked with `●` in the editor list. */
  private editorSavedIndex = 0;

  // Clock ticker state (Stage 4). Only runs while the view is reading/flowReading.
  // 10 s poll period with a string-compare gate — wakes up often enough to catch
  // the next minute boundary within 10 s without hammering textContainerUpgrade.
  private clockTickerId: number | null = null;
  private lastMinuteString: string | null = null;

  public onViewChanged?: () => void;
  public onPositionChanged?: (chapterIndex: number, pageIndex: number) => void;
  public onFlowStateChanged?: (isRunning: boolean) => void;

  constructor(private bridge: Bridge) {
    this.persister = createPositionPersister(this.bridge as unknown as PositionBridge, {
      // Page turns debounce; lifecycle exits save immediately via {immediate}.
      delayMs: 800,
      browserFallback: typeof window !== 'undefined' ? window.localStorage : undefined,
      onError: (error) => {
        console.warn('Position save failed:', error);
        setStatus('Position save failed');
      },
    });
    this.serialGesture = createSerialExecutor();
  }

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
    // Land any pending position under the OLD book's ref before switching.
    await this.persister.flush();
    this.stopFlow();
    this.book = book;
    this.currentBookId = bookId ?? null;
    this.currentBookFilename = filename ?? null;
    this.persister.setRef({
      title: book.title,
      bookId: this.currentBookId,
      filename: this.currentBookFilename,
    });
    this.chapterPages = [];
    this.chapterPageStarts = [];
    this.layoutCache.clear();
    this.repaginateForLayout();


    // L3 "last book" keys change only when the open book changes — write them
    // here, once per open, instead of on every page turn (invariant I1).
    try {
      await writeLastBookKeys(
        this.bridge as unknown as PositionBridge,
        { title: book.title, bookId: this.currentBookId, filename: this.currentBookFilename },
      );
    } catch (e) {
      console.warn('Failed to write last-book keys:', e);
    }

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
        filename: this.currentBookFilename ?? book.title + '.epub',
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
      await this.showChapterList(false);
    }
  }

  async applySettings(): Promise<void> {
    if (this.book && this.chapterPages.length > 0) {
      // Capture the current position as a source offset BEFORE repagination;
      // offset mapping is exact where the old page-count ratio was an estimate.
      const wasFlow = this.view === 'flowReading';
      const oldOffset = wasFlow
        ? (this.chapterPageStarts[this.chapterIndex]?.[this.pageIndex] ?? 0) +
          flowOffsetForWord(
            this.chapterPages[this.chapterIndex]?.[this.pageIndex] ?? '',
            this.flowWordIndex,
          )
        : (this.chapterPageStarts[this.chapterIndex]?.[this.pageIndex] ?? 0);

      this.activateLayout();

      const starts = this.chapterPageStarts[this.chapterIndex] ?? [0];
      this.pageIndex = pageForOffset(starts, oldOffset);
      if (wasFlow) {
        const pageText = this.chapterPages[this.chapterIndex]?.[this.pageIndex] ?? '';
        const pageWords = this.flowPageData[this.chapterIndex]?.[this.pageIndex]?.wordCount ?? 1;
        this.flowWordIndex = clamp(
          flowWordForOffset(pageText, Math.max(0, oldOffset - starts[this.pageIndex])),
          0,
          Math.max(0, pageWords - 1),
        );
      } else {
        const flowPage = this.flowPageData[this.chapterIndex]?.[this.pageIndex];
        const maxWordIndex = Math.max(0, (flowPage?.wordCount ?? 1) - 1);
        this.flowWordIndex = clamp(this.flowWordIndex, 0, maxWordIndex);
      }

      // Stage 6 guard: when the user edited a setting from the on-device
      // settings UI, we only repaginate — we do NOT auto-switch into the
      // reading view. commitEditor() will route the user back to the
      // settings list; the user chooses when to return to reading via
      // mainMenu -> Continue. Also invalidate the reading render signature so
      // the next re-entry into reading/flow does a full rebuild.
      if (this.view === 'settings' || this.view === 'settingEditor') {
        this.readingRenderSig = null;
      } else if (config.readingMode === 'flow' && this.view === 'reading') {
        this.flowWordIndex = 0;
        await this.showFlowReading(false);
      } else if (config.readingMode === 'paged' && this.view === 'flowReading') {
        this.stopFlow();
        await this.showPage();
      } else {
        this.readingRenderSig = null;
        await this.refreshCurrentView();
      }
      if (this.view === 'flowReading' && this.isFlowRunning) {
        this.scheduleFlowTick();
      }
    } else if (this.view === 'welcome') {
      await this.showWelcome();
    }
  }

  // --- UI Setup ---

  /**
   * Welcome-screen text containers. Hierarchy per the design guidelines:
   * title at full device brightness (textColor omitted = 4), instruction
   * dimmed to level 2 — the "dim secondary text" pattern. Used text-only in
   * the startup page (images are not supported there) and, with the brand
   * mark image, in the showWelcome() rebuild path.
   */
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
      textColor: 2,
    });

    return [titleContainer, instructionContainer];
  }

  /**
   * Full welcome page for the runtime rebuild path (showWelcome): the brand
   * mark as an image container plus the text hierarchy. Container budget:
   * 3 text + 1 image (limits: 8 text-like / 4 image). Exactly one
   * event-capture container — a full-screen invisible rect declared first,
   * same pattern as rebuildSlots. The caller must push the returned PNG
   * bytes with updateImageRawData after the rebuild (image containers start
   * empty by SDK design).
   */
  private getWelcomeRuntimePage(): {
    textObject: TextContainerProperty[];
    imageObject: ImageContainerProperty[];
    brandPngBytes: Uint8Array;
  } {
    const brandW = 120;
    const brandH = 72;

    const canvas = document.createElement('canvas');
    canvas.width = brandW;
    canvas.height = brandH;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, brandW, brandH);
    drawBookMark(ctx, { cx: brandW / 2, topY: 8, pageH: 46, halfW: 34 });
    const enc = encodeTilesBatch(
      canvas,
      [{ crop: { sx: 0, sy: 0, sw: brandW, sh: brandH }, name: 'brand-mark' }],
      brandW,
      brandH,
    )[0]!;

    const capture = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: DISPLAY_WIDTH,
      height: DISPLAY_HEIGHT,
      borderWidth: 0,
      borderColor: 0,
      paddingLength: 0,
      containerID: 1,
      containerName: 'swipe',
      content: '',
      isEventCapture: 1,
    });

    const title = 'G2 ePUB Reader';
    const titlePad = Math.floor((59 - title.length) / 2);
    const titleContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: 130,
      width: DISPLAY_WIDTH,
      height: 40,
      containerID: 2,
      containerName: 'title',
      content: ' '.repeat(Math.max(0, titlePad)) + title,
      isEventCapture: 0,
    });

    const instruction = 'Upload ePub file via WebUI to start reading';
    const instrPad = Math.floor((59 - instruction.length) / 2);
    const instructionContainer = new TextContainerProperty({
      xPosition: 0,
      yPosition: 195,
      width: DISPLAY_WIDTH,
      height: 40,
      containerID: 3,
      containerName: 'instruction',
      content: ' '.repeat(Math.max(0, instrPad)) + instruction,
      isEventCapture: 0,
      textColor: 2,
    });

    const brandImage = new ImageContainerProperty({
      xPosition: Math.floor((DISPLAY_WIDTH - brandW) / 2),
      yPosition: 40,
      width: brandW,
      height: brandH,
      containerID: 20,
      containerName: 'brand-mark',
    });

    return {
      textObject: [capture, titleContainer, instructionContainer],
      imageObject: [brandImage],
      brandPngBytes: enc.bytes,
    };
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
    // Splash design follows the official Even Realities design guidelines
    // (hub.evenrealities.com/docs/build/design-guidelines): flat FILLED shapes,
    // strokes >= 2px, silhouette-readable single subject, no hairline outlines;
    // 4-bit greyscale depth via distinct luminance tiers (the encoder quantizes
    // to 16 levels, ~17 per step). Canvas: 2 vertical tiles = 200x200, centered.
    // The mark itself lives in src/brand.ts (shared with the welcome screen).
    const cx = 100;                  // canvas center x

    const splash = createSplash({
      render: (ctx, w, h) => {
        // ── Open-book mark: solid filled pages (silhouette-first, no outlines)
        drawBookMark(ctx, { cx, topY: 40 });
        // ── Wordmark
        ctx.fillStyle = GREY_BRIGHT;
        ctx.font = 'bold 27px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('ePub Reader', cx, 150);
        // Thin rule between mark and version — 2px, mid grey
        ctx.fillStyle = GREY_MID;
        ctx.fillRect(cx - 24, 162, 48, 2);
        // Version — dim tier. APP_VERSION comes from package.json (JSON
        // import, resolveJsonModule) — single source of truth, never edit it here.
        ctx.fillStyle = GREY_DIM;
        ctx.font = '12px monospace';
        ctx.fillText(`v${APP_VERSION} · Even G2`, cx, 180);
      },
      tiles: 2,
      tileLayout: 'vertical',
      tilePositions: [
        { x: Math.floor((576 - 200) / 2), y: 44 },  // (188, 44) — vertically centered stack
        { x: Math.floor((576 - 200) / 2), y: 144 },
      ],
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

    // Three semantic choices: Continue, Library (N), Settings (per v1.4.0
    // decision Q3 — the three-option main menu is stable). Slot 0's label
    // reflects whether a last book is resolvable (bookId-first via
    // resolveLastBook). The trailing empty entry is dropped by
    // rebuildSlots' trimTrailingEmptySlots so the three rows render
    // vertically centered instead of padding a dead fourth row at the bottom.
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
    this.editorSavedIndex = this.editorSelectedIndex;

    const values = EDITOR_VALUE_LABELS[key];
    const total = values.length;
    const pageStart = Math.floor(this.editorSelectedIndex / ITEMS_PER_PAGE) * ITEMS_PER_PAGE;
    const selectedSlot = this.editorSelectedIndex - pageStart;

    const labels: string[] = [];
    for (let i = 0; i < ITEMS_PER_PAGE; i++) {
      const idx = pageStart + i;
      if (idx >= total) {
        labels.push('');
        continue;
      }
      // State glyphs (official glyph set: ●○) distinguish the SAVED value
      // from the row the highlight currently rests on — the border alone
      // cannot express "this is where you were" vs "this is where you are".
      const glyph = idx === this.editorSavedIndex ? '● ' : '○ ';
      labels.push(glyph + values[idx]);
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
        const label = formatBookPickerLabel(this.cachedBookList[idx], this.cachedBookList);
        labels.push(truncateForList(`${idx + 1}. ${label}`, 42));
      } else {
        labels.push('');
      }
    }

    await this.rebuildSlots(labels, selectedSlot);
    setStatus(`Library: ${this.bookPickerSelectedIndex + 1}/${total}. Swipe=browse, Tap=open, DblTap=back`);
    this.onViewChanged?.();
  }

  private async showWelcome(): Promise<void> {
    this.stopFlow();
    this.stopClockTicker();
    this.view = 'welcome';
    this.readingRenderSig = null; // welcome rebuilds the page — stale upgrades must not fire

    const page = this.getWelcomeRuntimePage();
    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: page.textObject.length + page.imageObject.length,
        textObject: page.textObject,
        imageObject: page.imageObject,
      }),
    );
    // Image containers start empty (SDK rule) — push the mark's pixels now.
    try {
      await this.bridge.updateImageRawData(
        new ImageRawDataUpdate({
          containerID: 20,
          containerName: 'brand-mark',
          imageData: page.brandPngBytes,
        }),
      );
    } catch (e) {
      console.warn('Welcome brand mark send failed:', e);
    }
    // Order matters: notifyTextUpdate arms the 80 ms phantom-suppression window
    // (the device fires a spurious SCROLL right after rebuildPageContainer);
    // resetGestureState then clears stale cross-view tap/scroll history without
    // touching that window or the bypass flag, so the phantom is dropped and
    // the user's first real swipe lands.
    notifyTextUpdate();
    resetGestureState();

    setStatus('Ready. Upload an EPUB or browse Gutenberg.');
    this.onViewChanged?.();
  }

  private async showChapterList(showPageCounts = true): Promise<void> {
    if (!this.book) return;
    this.stopFlow();
    this.stopClockTicker();
    this.view = 'chapterList';

    const total = this.book.chapters.length;
    const pageStart =
      Math.floor(this.librarySelectedIndex / ITEMS_PER_PAGE) * ITEMS_PER_PAGE;
    const selectedSlot = this.librarySelectedIndex - pageStart;

    const labels: string[] = [];
    for (let i = 0; i < ITEMS_PER_PAGE; i++) {
      const idx = pageStart + i;
      if (idx < total) {
        const ch = this.book.chapters[idx];
        if (showPageCounts) {
          const pgCount = this.chapterPages[idx]?.length ?? 0;
          labels.push(truncateForList(`${idx + 1}. ${ch.title} (${pgCount}pg)`, 42));
        } else {
          labels.push(truncateForList(`${idx + 1}. ${ch.title}`, 50));
        }
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

    const { infoText, progress } = computePagedProgress({
      chapterPages: this.chapterPages,
      chapterIndex: this.chapterIndex,
      pageIndex: this.pageIndex,
      totalChapters: this.book.chapters.length,
    });

    // Status-line content: "HH:MM  Ch C/T Pg P/N [━━━───]". Clock updates via
    // the periodic clockTicker (every 10 s with a string-compare gate); the
    // full label is also re-rendered on every page turn. See design §7.
    const hasBottomBar = config.statusBarPosition === 'bottom';
    const label = formatStatusLine({
      now: new Date(),
      infoText,
      maxChars: 59,
        maxPx: FOOTER_INNER_WIDTH,
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
      textColor: config.textBrightness,
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
        textColor: EvenEpubClient.FOOTER_TEXT_COLOR,
      });
      textObjects.push(footerContainer);
    }

    if (this.readingRenderSig === this.computeReadingRenderSig()) {
      // Same topology as the last render: flicker-free content swap. This is
      // the common page-turn path — no rebuild, no flicker, no phantom scroll.
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: 1,
          containerName: 'text',
          content: paddedPage,
          textColor: config.textBrightness,
        }),
      );
      if (hasBottomBar) {
        await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: 2,
            containerName: 'footer',
            content: label,
            textColor: EvenEpubClient.FOOTER_TEXT_COLOR,
          }),
        );
      }
    } else {
      await this.bridge.rebuildPageContainer(
        new RebuildPageContainer({
          containerTotalNum: textObjects.length,
          textObject: textObjects,
          menuObject: this.buildMenuObject(),
        }),
      );
      this.readingRenderSig = this.computeReadingRenderSig();
    }
    notifyTextUpdate();

    await this.savePagedPosition();
    this.startClockTicker();

    setStatus(
      `Ch ${this.chapterIndex + 1
      } / ${this.book.chapters.length}: ${chapter.title} | Page ${this.pageIndex + 1}/${totalPages}`,
    );
  }

  /**
   * Signature of the reading-view container topology (both paged and flow use
   * [text(capture), footer?]). When it matches the last render, page turns and
   * flow frames use flicker-free textContainerUpgrade instead of a rebuild;
   * any other view's rebuild invalidates it so a stale upgrade can never
   * target menu containers.
   */
  private readingRenderSig: string | null = null;

  private computeReadingRenderSig(): string {
    const layout = getTextLayout();
    return `${config.statusBarPosition}|${layout.maxLines}|${layout.topBlankLines}`;
  }

  private async showFlowReading(autoStart: boolean): Promise<void> {
    if (!this.book || this.flowPageData.length === 0) return;
    this.view = 'flowReading';
    this.readingRenderSig = null; // force full rebuild on entry
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

    const chapterTotalPages = this.chapterPages[this.chapterIndex]?.length ?? 1;
    const { infoText, progress } = computeFlowProgress({
      flowWordCounts: this.flowPageData.map((ch) => ch.map((pg) => pg.wordCount)),
      chapterIndex: this.chapterIndex,
      pageIndex: this.pageIndex,
      flowWordIndex: this.flowWordIndex,
      totalChapters: this.book.chapters.length,
      chapterTotalPages,
      flowSpeedWpm: config.flowSpeedWpm,
      isFlowRunning: this.isFlowRunning,
      paceWpm: this.getFlowPaceWpm(),
    });

    const hasBottomBar = config.statusBarPosition === 'bottom';
    const label = formatStatusLine({
      now: new Date(),
      infoText,
      maxChars: 59,
      maxPx: FOOTER_INNER_WIDTH,
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
      textColor: config.textBrightness,
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
          textColor: EvenEpubClient.FOOTER_TEXT_COLOR,
        }),
      );
    }

    if (this.readingRenderSig === this.computeReadingRenderSig()) {
      // Flicker-free in-place updates (per SDK docs)
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: 1,
          containerName: 'flow-text',
          content: paddedContent,
          textColor: config.textBrightness,
        }),
      );
      if (hasBottomBar) {
        await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: 2,
            containerName: 'flow-footer',
            content: label,
            textColor: EvenEpubClient.FOOTER_TEXT_COLOR,
          }),
        );
      }
    } else {
      // Full rebuild to establish container layout; carries the contextual
      // menu (a rebuild without menuObject clears it — plan §3.1).
      await this.bridge.rebuildPageContainer(
        new RebuildPageContainer({
          containerTotalNum: textObjects.length,
          textObject: textObjects,
          menuObject: this.buildMenuObject(),
        }),
      );
      this.readingRenderSig = this.computeReadingRenderSig();
    }
    notifyTextUpdate();

    // While flow is running, hit the bridge only on page boundaries — a save
    // is up to 5 sequential bridge round-trips, and doing that on every word
    // tick (10/s at 600 wpm) both floods the bridge and stretches the tick
    // past the requested WPM interval (flowTick awaits this render). Pauses,
    // chapter jumps, foreground-exit, and shutdown all still save in full.
    const persistToBridge = !this.isFlowRunning || this.flowWordIndex === 0;
    await this.saveFlowPosition(persistToBridge);
    this.startClockTicker();
    setStatus(
      `Flow ${this.isFlowRunning ? 'running' : 'paused'} | Ch ${this.chapterIndex + 1}/${this.book.chapters.length} | Pg ${this.pageIndex + 1}/${chapterTotalPages} | Word ${this.flowWordIndex + 1}/${totalPageWords} | ${config.flowSpeedWpm} WPM`,
    );
  }

  private async rebuildSlots(labels: string[], selectedSlot: number): Promise<void> {
    // Menu/list views replace the reading containers — invalidate the reading
    // render signature so returning to reading rebuilds instead of upgrading.
    this.readingRenderSig = null;
    // v1.4.3 layout: trim trailing empty slots so a partial page (3-item main
    // menu, 2-option binary editors, last page of a paginated settings list)
    // doesn't render dead rows; vertically center what remains; size every row
    // to the page's longest label so the highlight outlines a button-shaped
    // box rather than a full-width banner.
    const visibleLabels = trimTrailingEmptySlots(labels);
    const n = visibleLabels.length;
    const boxWidthPx = computeBoxWidthPx(visibleLabels, measureWidth);
    const boxChars = Math.floor(boxWidthPx / CHAR_PITCH_PX);
    const xPosition = Math.floor((DISPLAY_WIDTH - boxWidthPx) / 2);
    const yPositions = computeRowOffsets(n);
    const safeSelected = n > 0 ? clamp(selectedSlot, 0, n - 1) : -1;

    const containers: TextContainerProperty[] = [];

    // Container 1 must be declared FIRST so it sits beneath the option rows in
    // the SDK's paint/event order (matches even-toolkit/glasses/bridge.ts).
    // Empty content + zero border + zero padding renders nothing visible; the
    // full-screen rect catches every swipe regardless of slot geometry.
    containers.push(
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: DISPLAY_WIDTH,
        height: DISPLAY_HEIGHT,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 0,
        containerID: 1,
        containerName: 'swipe',
        content: '',
        isEventCapture: 1,
      }),
    );

    for (let i = 0; i < n; i++) {
      const isSelected = i === safeSelected;
      containers.push(
        new TextContainerProperty({
          xPosition,
          yPosition: yPositions[i],
          width: boxWidthPx,
          height: ROW_HEIGHT,
          borderWidth: isSelected ? 1 : 0,
          // 13 (bright) per design guidelines — the selection highlight is the
          // primary navigation feedback on the monochrome display; 5 (subtle
          // grey) was too dim to read at a glance.
          borderColor: 13,
          borderRadius: 8,
          paddingLength: 2,
          containerID: i + 2,
          containerName: `slot-${i}`,
          content: centerLabel(visibleLabels[i], boxChars),
          isEventCapture: 0,
        }),
      );
    }

    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: containers.length,
        textObject: containers,
      }),
    );
    // Order matters: notifyTextUpdate first arms the 40 ms window that swallows
    // the phantom SCROLL the device fires right after rebuildPageContainer
    // (the one that used to snap the highlight back to where it started). Then
    // resetGestureState clears stale cross-view tap/scroll history so the
    // user's first real swipe in the new menu lands without being held by the
    // 110 ms post-tap or 350 ms same-direction debounces from the previous view.
    notifyTextUpdate();
    resetGestureState();
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

  /**
   * Repaginate every chapter for the current config, keeping the parallel
   * pageStarts used by position format v2 (offset-accurate resume across
   * layout changes).
   */
  private repaginateForLayout(): void {
    if (!this.book) return;
    const paginated = this.book.chapters.map((ch) => paginateTextWithOffsets(ch.text));
    this.chapterPages = paginated.map((p) => p.pages);
    this.chapterPageStarts = paginated.map((p) => p.pageStarts);
    this.flowPageData = this.buildFlowPageData(this.chapterPages);
  }

  /**
   * Layout cache (Phase 2): pagination results per layout signature, so
   * toggling reading info (footer on/off) swaps page arrays instead of
   * repaginating the whole book. LRU-capped at 2 entries: the current layout
   * plus the one the user just left. Cache is cleared when a new book loads.
   */
  private layoutCache = new Map<string, {
    pages: string[][];
    starts: number[][];
    flow: FlowPageData[][];
  }>();

  private layoutCacheKey(): string {
    return `${config.hyphenation ? 'h' : 'n'}|${config.textHeightPercent}|${config.statusBarPosition}`;
  }

  private activateLayout(): void {
    if (!this.book) return;
    const key = this.layoutCacheKey();
    const cached = this.layoutCache.get(key);
    if (cached) {
      // Refresh LRU recency.
      this.layoutCache.delete(key);
      this.layoutCache.set(key, cached);
      this.chapterPages = cached.pages;
      this.chapterPageStarts = cached.starts;
      this.flowPageData = cached.flow;
      return;
    }
    this.repaginateForLayout();
    this.layoutCache.set(key, {
      pages: this.chapterPages,
      starts: this.chapterPageStarts,
      flow: this.flowPageData,
    });
    if (this.layoutCache.size > 2) {
      const oldest = this.layoutCache.keys().next().value;
      if (oldest !== undefined) this.layoutCache.delete(oldest);
    }
  }

  /** Source offset of the current position (paged: page start; flow: word). */
  private currentOffset(): number {
    const pageStart = this.chapterPageStarts[this.chapterIndex]?.[this.pageIndex] ?? 0;
    if (this.view === 'flowReading') {
      const pageText = this.chapterPages[this.chapterIndex]?.[this.pageIndex] ?? '';
      return pageStart + flowOffsetForWord(pageText, this.flowWordIndex);
    }
    return pageStart;
  }

  private buildFlowPageData(chapters: string[][]): FlowPageData[][] {    return chapters.map((pages) =>
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
    this.flowPaceWindowStart = Date.now();
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
    if (this.isFlowRunning && this.flowPaceWindowStart > 0) {
      this.flowPaceMs += Date.now() - this.flowPaceWindowStart;
      this.flowPaceWindowStart = 0;
    }
    const wasRunning = this.isFlowRunning;
    this.isFlowRunning = false;
    if (wasRunning) this.onFlowStateChanged?.(false);
  }

  /** Measured session pace (wpm); null until ≥60 s of active reading. */
  private getFlowPaceWpm(): number | null {
    const ms = this.flowPaceMs;
    if (ms < 60_000 || this.flowPaceWords < 50) return null;
    return this.flowPaceWords / (ms / 60_000);
  }

  private toggleFlow(): void {
    if (!this.book || this.view !== 'flowReading') return;
    if (this.isFlowRunning) {
      this.stopFlow();
      appendEventLog('Flow paused');
      this.showFlowFrame().catch((e) => console.warn('Failed to render flow frame:', e));
    } else {
      // Auto-rewind on resume (plan §3.4): an interrupted reader loses their
      // place mid-sentence — resume at the sentence start, or ~8 words back
      // (never before the sentence start) when the sentence start is farther.
      const offset = this.currentOffset();
      const text = this.book.chapters[this.chapterIndex]?.text ?? '';
      const sentenceStart = sentenceStartBefore(text, offset);
      const target = offset - sentenceStart <= 48
        ? sentenceStart
        : Math.max(sentenceStart, offset - 48);
      this.applyOffsetToFlowPosition(target);
      this.startFlow();
    }
  }

  /** Map an absolute chapter-text offset to page + flow word index. */
  private applyOffsetToFlowPosition(offset: number): void {
    const starts = this.chapterPageStarts[this.chapterIndex] ?? [0];
    this.pageIndex = pageForOffset(starts, offset);
    const pageText = this.chapterPages[this.chapterIndex]?.[this.pageIndex] ?? '';
    const pageWords = this.flowPageData[this.chapterIndex]?.[this.pageIndex]?.wordCount ?? 1;
    const rel = Math.max(0, offset - starts[this.pageIndex]);
    this.flowWordIndex = clamp(
      flowWordForOffset(pageText, rel),
      0,
      Math.max(0, pageWords - 1),
    );
  }

  /** Flow, running: rewind to the start of the current sentence ("I missed that"). */
  private async flowSentenceBack(): Promise<void> {
    if (!this.book) return;
    const text = this.book.chapters[this.chapterIndex]?.text ?? '';
    const offset = this.currentOffset();
    const target = sentenceStartBefore(text, Math.max(0, offset - 1));
    if (target >= offset) return; // already at the chapter's first sentence
    this.applyOffsetToFlowPosition(target);
    await this.showFlowFrame();
  }

  /** Flow, running: skip to the start of the next sentence. */
  private async flowSentenceForward(): Promise<void> {
    if (!this.book) return;
    const text = this.book.chapters[this.chapterIndex]?.text ?? '';
    const offset = this.currentOffset();
    const target = nextSentenceStart(text, offset);
    if (target >= text.length) {
      // Last sentence of the chapter — advance if another chapter follows.
      if (this.chapterIndex < this.book.chapters.length - 1) {
        this.chapterIndex++;
        this.pageIndex = 0;
        this.flowWordIndex = 0;
        await this.showFlowFrame();
      }
      return;
    }
    this.applyOffsetToFlowPosition(target);
    await this.showFlowFrame();
  }

  /** Flow, paused: page-level navigation (chapter jumps moved to the menu). */
  private async nextPageInFlow(): Promise<void> {
    if (!this.book) return;
    const totalPages = this.chapterPages[this.chapterIndex]?.length ?? 1;
    if (this.pageIndex >= totalPages - 1) {
      if (this.chapterIndex < this.book.chapters.length - 1) {
        this.chapterIndex++;
        this.pageIndex = 0;
        this.flowWordIndex = 0;
      } else {
        appendEventLog('Already at last page');
        return;
      }
    } else {
      this.pageIndex++;
      this.flowWordIndex = 0;
    }
    await this.showFlowFrame();
  }

  private async prevPageInFlow(): Promise<void> {
    if (!this.book) return;
    if (this.pageIndex <= 0) {
      if (this.chapterIndex > 0) {
        this.chapterIndex--;
        this.pageIndex = Math.max(0, (this.chapterPages[this.chapterIndex]?.length ?? 1) - 1);
        this.flowWordIndex = 0;
      } else {
        appendEventLog('Already at first page');
        return;
      }
    } else {
      this.pageIndex--;
      this.flowWordIndex = 0;
    }
    await this.showFlowFrame();
  }

  private scheduleFlowTick(): void {
    if (!this.isFlowRunning) return;
    if (this.flowTimerId !== null) {
      window.clearTimeout(this.flowTimerId);
      this.flowTimerId = null;
    }
    this.flowTimerId = window.setTimeout(() => {
      this.flowTick().catch((e) => console.warn('flow tick failed:', e));
    }, this.getFlowIntervalMs());
  }

  private async flowTick(): Promise<void> {
    if (!this.book || !this.isFlowRunning) return;
    this.flowPaceWords++;
    if (this.isFlowTickInFlight) {
      // Previous render still in flight (render time exceeded the WPM
      // interval — e.g. slow bridge at 600 WPM = 100 ms). Reschedule so
      // we don't stall; the next attempt gives the render time to finish.
      this.scheduleFlowTick();
      return;
    }
    this.isFlowTickInFlight = true;
    try {
      // Schedule the next tick BEFORE the render so the bridge I/O overlaps
      // with the wait. This keeps the effective word interval close to the
      // target WPM instead of accumulating render time on every tick
      // (the old "await tick then schedule" path added 10-50 ms per word).
      this.scheduleFlowTick();

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
    // showPage / showFlowFrame already called notifyTextUpdate() to arm the
    // phantom-suppression window. Clear the lingering tap/scroll history from
    // the chapter-list view so the user's first swipe in the new reading view
    // isn't held by the 110 ms post-tap gate or the previous view's debounce.
    resetGestureState();
  }

  private async refreshCurrentView(): Promise<void> {
    // Exhaustive per-view refresh. Returning from a menu/background visit must
    // land the user back on the SAME view — the old if/else chain had no
    // branches for mainMenu/settings/settingEditor, so those fell through to
    // chapterList (book open) or welcome (no book). A new ViewState member
    // that lacks a case here is a compile error (exhaustiveness guard).
    switch (this.view) {
      case 'reading':
        await this.showPage();
        return;
      case 'flowReading':
        await this.showFlowFrame();
        return;
      case 'bookPicker':
        await this.showBookPicker();
        return;
      case 'chapterList':
        await this.showChapterList();
        return;
      case 'mainMenu':
        await this.showMainMenu();
        return;
      case 'settings':
        await this.showSettingsMenu();
        return;
      case 'settingEditor':
        await this.showSettingEditor(this.editingSettingKey ?? SETTINGS_MENU_KEYS[0]);
        return;
      case 'welcome':
        await this.showWelcome();
        return;
      default: {
        const exhausted: never = this.view;
        throw new Error(`Unhandled view in refreshCurrentView: ${String(exhausted)}`);
      }
    }
  }

  // --- Event Handling ---

  private async onEvenHubEvent(event: EvenHubEvent): Promise<void> {
    const sysEvent = event?.sysEvent;
    // Lifecycle events bypass the gesture queue: exits must preempt in-flight
    // renders, and the enter-refresh is safe to overlap either way.
    if (sysEvent?.eventType === OsEventTypeList.SYSTEM_EXIT_EVENT) {
      const r = reduceLifecycle(this.lifecycleState, this.pendingMenuAction, { kind: 'systemExit' });
      this.lifecycleState = r.state;
      this.pendingMenuAction = r.pendingMenuAction;
      await this.handleShutdown();
      return;
    }

    // Native contextual menu clicks bypass gesture routing entirely (plan §3.1).
    // The click is registered; execution waits for the overlay's EXIT.
    if (event?.menuItemClickEvent && typeof event.menuItemClickEvent.itemID === 'number') {
      const r = reduceLifecycle(this.lifecycleState, this.pendingMenuAction, {
        kind: 'menuClick',
        itemID: event.menuItemClickEvent.itemID,
      });
      this.lifecycleState = r.state;
      this.pendingMenuAction = r.pendingMenuAction;
      return;
    }

    if (sysEvent?.eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      const r = reduceLifecycle(this.lifecycleState, this.pendingMenuAction, { kind: 'foregroundExit' });
      this.lifecycleState = r.state;
      const wasPending = this.pendingMenuAction;
      this.pendingMenuAction = r.pendingMenuAction;
      if (r.effects.pauseAndFlush) {
        if (this.isFlowRunning) this.stopFlow();
        this.stopClockTicker();
        if (this.view === 'flowReading') await this.saveFlowPosition(true, true);
        else await this.savePagedPosition(true);
      }
      if (r.effects.runPendingMenuAction && wasPending !== null) {
        await this.dispatchMenuAction(wasPending);
      }
      return;
    }
    if (sysEvent?.eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      const r = reduceLifecycle(this.lifecycleState, this.pendingMenuAction, { kind: 'foregroundEnter' });
      this.lifecycleState = r.state;
      if (r.effects.restoreView) {
        await this.refreshCurrentView();
        if (this.view === 'reading' || this.view === 'flowReading') {
          this.startClockTicker();
        }
      }
      return;
    }

    // Gestures serialize (FIFO): two rapid swipes must not interleave their
    // rebuild/upgrade SDK calls. One rejection cannot wedge the queue
    // (createSerialExecutor), and each caller still logs its own error.
    await this.serialGesture(() => this.dispatchGlassEvent(event));
  }

  /** Execute a native-menu selection (stale-guarded on the reading views). */
  private async dispatchMenuAction(itemID: number): Promise<void> {
    if (this.view !== 'reading' && this.view !== 'flowReading') {
      return; // stale click: the view changed while the overlay was open
    }
    switch (itemID) {
      case MENU_CONTENTS:
        if (this.isFlowRunning) this.stopFlow();
        this.librarySelectedIndex = this.chapterIndex;
        await this.showChapterList();
        break;
      case MENU_SWITCH_MODE:
        config.readingMode = this.view === 'flowReading' ? 'paged' : 'flow';
        saveSettings();
        await saveSettingsToBridge(this.bridge);
        await this.applySettings();
        break;
      case MENU_MAIN_MENU:
        this.stopFlow();
        await this.showMainMenu();
        break;
      case MENU_FASTER:
      case MENU_SLOWER: {
        if (this.view !== 'flowReading') return;
        const step = itemID === MENU_FASTER ? 30 : -30;
        config.flowSpeedWpm = clamp(config.flowSpeedWpm + step, FLOW_MIN_WPM, FLOW_MAX_WPM);
        saveSettings();
        await saveSettingsToBridge(this.bridge);
        await this.showFlowFrame();
        break;
      }
      case MENU_SET_BOOKMARK:
        await this.saveBookmark();
        break;
      case MENU_GO_BOOKMARK:
        await this.goToBookmark();
        break;
    }
  }

  /** Jump to the book's single quick bookmark, if one exists (plan §3.6). */
  private async goToBookmark(): Promise<void> {
    if (!this.book || !this.currentBookId) return;
    try {
      const raw = await (this.bridge as unknown as PositionBridge).getLocalStorage(
        `epub-bookmark-${this.currentBookId}`,
      );
      if (!raw) {
        setStatus('No bookmark set');
        return;
      }
      const pos = JSON.parse(raw) as ReadingPosition;
      if (pos.chapterIndex >= this.chapterPageStarts.length) {
        setStatus('Bookmark no longer valid');
        return;
      }
      const starts = this.chapterPageStarts[pos.chapterIndex] ?? [0];
      this.chapterIndex = pos.chapterIndex;
      this.pageIndex = pageForOffset(starts, typeof pos.offset === 'number' ? pos.offset : 0);
      if (this.view === 'flowReading') {
        const pageText = this.chapterPages[this.chapterIndex]?.[this.pageIndex] ?? '';
        const pageWords = this.flowPageData[this.chapterIndex]?.[this.pageIndex]?.wordCount ?? 1;
        this.flowWordIndex = clamp(
          flowWordForOffset(pageText, Math.max(0, (pos.offset ?? 0) - starts[this.pageIndex])),
          0,
          Math.max(0, pageWords - 1),
        );
        await this.showFlowFrame();
      } else {
        await this.showPage();
      }
    } catch (e) {
      console.warn('Bookmark jump failed:', e);
      setStatus('Bookmark jump failed');
    }
  }

  /** Single quick bookmark per book (plan §3.6), position format v2 shape. */
  private async saveBookmark(): Promise<void> {
    if (!this.book || !this.currentBookId) return;
    try {
      const pos: ReadingPosition = {
        chapterIndex: this.chapterIndex,
        pageIndex: this.pageIndex,
        wordIndex: this.view === 'flowReading' ? this.flowWordIndex : undefined,
        v: 2,
        offset: this.currentOffset(),
        paginationVersion: PAGINATION_VERSION,
      };
      await (this.bridge as unknown as PositionBridge).setLocalStorage(
        `epub-bookmark-${this.currentBookId}`,
        JSON.stringify(pos),
      );
      setStatus(`Bookmarked: Ch ${this.chapterIndex + 1}, Pg ${this.pageIndex + 1}`);
    } catch (e) {
      console.warn('Bookmark save failed:', e);
      setStatus('Bookmark failed');
    }
  }

  /** Build the contextual-menu payload for the current reading view. */
  private buildMenuObject(): MenuContainerProperty | undefined {
    if (this.view !== 'reading' && this.view !== 'flowReading') return undefined;
    const items = this.view === 'flowReading' ? FLOW_MENU_ITEMS : PAGED_MENU_ITEMS;
    return new MenuContainerProperty({
      menuItems: items.map((m) => new MenuItemProperty({ itemID: m.id, itemName: m.label })),
    });
  }

  /** Dispatch one mapped gesture. Runs serialized — see onEvenHubEvent. */
  private async dispatchGlassEvent(event: EvenHubEvent): Promise<void> {
    const action = mapGlassEvent(event);
    if (!action) return;

    switch (action.type) {
      case 'HIGHLIGHT_MOVE':
        if (action.direction === 'down') {
          if (this.view === 'reading') await this.nextPage();
          else if (this.view === 'flowReading') {
            // Plan §3.4: chapter jumps are OUT of swipe-while-running (temple
            // touches are the most common accidental input). Running → next
            // sentence; paused → next page. Chapters remain reachable via
            // Contents (double-tap or the native menu).
            if (this.isFlowRunning) await this.flowSentenceForward();
            else await this.nextPageInFlow();
          }
          else if (this.view === 'chapterList') await this.nextChapterInList();
          else if (this.view === 'bookPicker') await this.nextBookInPicker();
          else if (this.view === 'mainMenu') await this.nextMainMenuSlot();
          else if (this.view === 'settings') await this.nextSettingsListItem();
          else if (this.view === 'settingEditor') await this.nextEditorValue();
        } else {
          if (this.view === 'reading') await this.prevPage();
          else if (this.view === 'flowReading') {
            if (this.isFlowRunning) await this.flowSentenceBack();
            else await this.prevPageInFlow();
          }
          else if (this.view === 'chapterList') await this.prevChapterInList();
          else if (this.view === 'bookPicker') await this.prevBookInPicker();
          else if (this.view === 'mainMenu') await this.prevMainMenuSlot();
          else if (this.view === 'settings') await this.prevSettingsListItem();
          else if (this.view === 'settingEditor') await this.prevEditorValue();
        }
        break;

      case 'SELECT_HIGHLIGHTED':
        if (this.view === 'flowReading' && this.book) {
          this.toggleFlow();
        } else if (this.view === 'reading' && this.book) {
          await this.toggleReadingInfo();
        } else if (this.view === 'chapterList') {
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

      case 'GO_BACK': {
        const target = routeGoBack(this.view, this.isFlowRunning);
        if (target === 'chapterList') {
          // reading or paused flowReading → chapter list. Preserve the current
          // chapter so the list highlights where the reader left off.
          this.librarySelectedIndex = this.chapterIndex;
          await this.showChapterList();
        } else if (target === 'mainMenu') {
          // chapterList clears the open book; welcome/bookPicker/settings don't.
          if (this.view === 'chapterList') {
            this.book = null;
            this.stopFlow();
          }
          await this.showMainMenu();
        } else if (target === 'settings') {
          // Cancel in-flight editor pick.
          this.editingSettingKey = null;
          await this.showSettingsMenu();
        } else if (target === 'exit') {
          try { await this.bridge.shutDownPageContainer(1); } catch { /* */ }
        }
        // target === this.view (flowReading while running): no-op.
        break;
      }
    }
  }

  // Main-menu navigation (3 semantic options — see v1.4.0 design §3.2).
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

  /** Current book title, or null when no book is loaded. */
  public getBookTitle(): string | null {
    return this.book?.title ?? null;
  }

  /** Immutable identity of the open book, used to update the right library row. */
  public getBookId(): string | null {
    return this.currentBookId;
  }

  public isReadingInfoVisible(): boolean {
    return config.statusBarPosition === 'bottom';
  }

  /**
   * Toggle the 30 px footer. Hidden mode uses 10 text lines instead of 9.
   * Paged reading maps this to the otherwise-unused tap gesture.
   *
   * Phase 2: switches via the layout cache and an offset remap — no full-book
   * repagination on toggle (the page arrays are swapped; the first toggle to a
   * not-yet-cached geometry still computes once). The footer's
   * appearance/disappearance changes container topology, so the render
   * rebuilds (sig mismatch) — one flicker per toggle, none per page turn.
   */
  public async toggleReadingInfo(): Promise<void> {
    const wasFlow = this.view === 'flowReading';
    const oldOffset = this.currentOffset();

    config.statusBarPosition = toggleStatusBarPosition(config.statusBarPosition);
    saveSettings();
    this.activateLayout();

    // Offset-accurate remap into the new geometry.
    const starts = this.chapterPageStarts[this.chapterIndex] ?? [0];
    this.pageIndex = pageForOffset(starts, oldOffset);
    if (wasFlow) {
      const pageText = this.chapterPages[this.chapterIndex]?.[this.pageIndex] ?? '';
      const pageWords = this.flowPageData[this.chapterIndex]?.[this.pageIndex]?.wordCount ?? 1;
      this.flowWordIndex = clamp(
        flowWordForOffset(pageText, Math.max(0, oldOffset - starts[this.pageIndex])),
        0,
        Math.max(0, pageWords - 1),
      );
    }

    await (wasFlow ? this.showFlowFrame() : this.showPage());
    await saveSettingsToBridge(this.bridge);
    resetGestureState();
    const lines = getTextLayout().maxLines;
    setStatus(`Reading info ${this.isReadingInfoVisible() ? 'shown' : 'hidden'} · ${lines} text lines per page`);
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
    if (this.view === 'flowReading') await this.saveFlowPosition(true, true);
    else await this.savePagedPosition(true);
    try { await this.bridge.shutDownPageContainer(); } catch { /* */ }
  }

  // --- Clock ticker (Stage 4) ---

  private startClockTicker(): void {
    // Idempotent: showFlowFrame calls this on every word tick (up to 10/s at
    // 600 wpm) — keep the existing interval rather than tearing it down and
    // re-arming, which also kept resetting its 10 s phase. A single guarded
    // interval can never leak (§12.1 risk list, mitigation).
    if (this.clockTickerId !== null) return;
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
        new TextContainerUpgrade({
          containerID: 2,
          containerName: name,
          content: label,
          textColor: EvenEpubClient.FOOTER_TEXT_COLOR,
        }),
      );
    } catch (e) {
      console.warn('clock tick textContainerUpgrade failed:', e);
    }
  }

  private buildCurrentFooterLabel(): string | null {
    if (!this.book) return null;
    if (this.view === 'reading') {
      const { infoText, progress } = computePagedProgress({
        chapterPages: this.chapterPages,
        chapterIndex: this.chapterIndex,
        pageIndex: this.pageIndex,
        totalChapters: this.book.chapters.length,
      });
      return formatStatusLine({ now: new Date(), infoText, maxChars: 59, maxPx: FOOTER_INNER_WIDTH, progress });
    }
    // flowReading
    const pageData = this.flowPageData[this.chapterIndex]?.[this.pageIndex];
    if (!pageData) return null;
    const chapterTotalPages = this.chapterPages[this.chapterIndex]?.length ?? 1;
    const { infoText, progress } = computeFlowProgress({
      flowWordCounts: this.flowPageData.map((ch) => ch.map((pg) => pg.wordCount)),
      chapterIndex: this.chapterIndex,
      pageIndex: this.pageIndex,
      flowWordIndex: this.flowWordIndex,
      totalChapters: this.book.chapters.length,
      chapterTotalPages,
      flowSpeedWpm: config.flowSpeedWpm,
      isFlowRunning: this.isFlowRunning,
    });
    return formatStatusLine({ now: new Date(), infoText, maxChars: 59, maxPx: FOOTER_INNER_WIDTH, progress });
  }

  // --- Persistence ---

  private async savePagedPosition(immediate = false): Promise<void> {
    if (!this.book) return;
    const offset = this.chapterPageStarts[this.chapterIndex]?.[this.pageIndex];
    const pos: ReadingPosition = {
      chapterIndex: this.chapterIndex,
      pageIndex: this.pageIndex,
      // v2: offset survives repagination; hints keep 1.4.6 rollback working.
      v: 2,
      offset: typeof offset === 'number' ? offset : 0,
      paginationVersion: PAGINATION_VERSION,
    };
    this.persister.savePaged(pos, { immediate });
    this.onPositionChanged?.(this.chapterIndex, this.pageIndex);
  }

  public async getSavedPosition(bookTitle: string, bookId?: string): Promise<ReadingPosition | null> {
    return readPositionFromKeys(
      this.bridge as unknown as PositionBridge,
      pagedPositionKeys({ title: bookTitle, bookId }),
      localStorage,
    );
  }

  private async restorePagedPosition(bookTitle: string): Promise<ReadingPosition | null> {
    const pos = await readPositionFromKeys(
      this.bridge as unknown as PositionBridge,
      pagedPositionKeys({ title: bookTitle, bookId: this.currentBookId }),
      localStorage,
    );
    if (!pos) return null;
    if (pos.chapterIndex >= this.chapterPages.length) return null;

    // v2 path: offset-accurate resume when the pagination version matches.
    if (
      pos.v === 2 &&
      typeof pos.offset === 'number' &&
      pos.paginationVersion === PAGINATION_VERSION
    ) {
      const starts = this.chapterPageStarts[pos.chapterIndex];
      if (starts && starts.length > 0) {
        const page = pageForOffset(starts, pos.offset);
        return {
          chapterIndex: pos.chapterIndex,
          pageIndex: Math.min(page, Math.max(0, starts.length - 1)),
        };
      }
    }

    // Fallback: page-index hints (v1 positions or pagination version drift).
    pos.pageIndex = Math.min(
      pos.pageIndex,
      Math.max(0, (this.chapterPages[pos.chapterIndex]?.length ?? 1) - 1),
    );
    return pos;
  }

  private async saveFlowPosition(persistToBridge = true, immediate = false): Promise<void> {
    if (!this.book) return;
    const pageStart = this.chapterPageStarts[this.chapterIndex]?.[this.pageIndex] ?? 0;
    const pageText = this.chapterPages[this.chapterIndex]?.[this.pageIndex] ?? '';
    const pos: ReadingPosition = {
      chapterIndex: this.chapterIndex,
      pageIndex: this.pageIndex,
      wordIndex: this.flowWordIndex,
      v: 2,
      offset: pageStart + flowOffsetForWord(pageText, this.flowWordIndex),
      paginationVersion: PAGINATION_VERSION,
    };
    this.persister.saveFlow(pos, persistToBridge, { immediate });
    this.onPositionChanged?.(this.chapterIndex, this.pageIndex);
  }

  private async restoreFlowPosition(bookTitle: string): Promise<ReadingPosition | null> {
    const pos = await readPositionFromKeys(
      this.bridge as unknown as PositionBridge,
      flowPositionKeys({ title: bookTitle, bookId: this.currentBookId }),
      localStorage,
    );
    if (!pos) return null;
    if (pos.chapterIndex >= this.flowPageData.length) return null;

    const chapterPages = this.flowPageData[pos.chapterIndex];

    // v2 path: map the saved char offset to the containing page + word.
    if (
      pos.v === 2 &&
      typeof pos.offset === 'number' &&
      pos.paginationVersion === PAGINATION_VERSION
    ) {
      const starts = this.chapterPageStarts[pos.chapterIndex];
      if (starts && starts.length > 0) {
        const page = pageForOffset(starts, pos.offset);
        const pageText = this.chapterPages[pos.chapterIndex]?.[page] ?? '';
        const rel = Math.max(0, pos.offset - starts[page]);
        const pageWords = chapterPages?.[page]?.wordCount ?? 1;
        return {
          chapterIndex: pos.chapterIndex,
          pageIndex: page,
          wordIndex: Math.min(flowWordForOffset(pageText, rel), Math.max(0, pageWords - 1)),
        };
      }
    }

    // Fallback: hints.
    const pageIndex = Number.isInteger(pos.pageIndex) ? pos.pageIndex : 0;
    const wordIndex = Number.isInteger(pos.wordIndex) ? pos.wordIndex! : 0;
    if (pageIndex >= 0 && pageIndex < (chapterPages?.length ?? 0)) {
      return {
        chapterIndex: pos.chapterIndex,
        pageIndex,
        wordIndex: Math.min(wordIndex, Math.max(0, (chapterPages[pageIndex]?.wordCount ?? 1) - 1)),
      };
    }
    return null;
  }
}
