import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { activateKeepAlive } from 'even-toolkit/keep-alive';
import { setStatus, withTimeout } from './utils';
import { parseEpub } from './epub-parser';
import { EvenEpubClient } from './even-client';
import { fetchTopGutenbergBooks, downloadGutenbergEpub } from './gutenberg';
import { getRecentBooksFromDB, saveEpubBufferToDB, deleteFromDB, type StoredBook } from './db';
import {
  config,
  FLOW_MAX_WPM,
  FLOW_MIN_WPM,
  loadSettingsFromBridge,
  saveSettings,
  saveSettingsToBridge,
  TEXT_HEIGHT_MAX_PERCENT,
  TEXT_HEIGHT_MIN_PERCENT,
  TEXT_HEIGHT_STEP_PERCENT,
} from './constants';
import type { CachedBookMeta } from './types';
import { matchesBookQuery } from './book-selection';
import {
  DEFAULT_KOSYNC_SERVER,
  KOSYNC_DEVICE_NAME,
  KosyncClient,
  KosyncError,
  bookOrbitAddress,
  bookOrbitKosyncBase,
  isKosyncLoggedIn,
  loadKosyncSettings,
  normalizeServerUrl,
  saveKosyncSettings,
  type KosyncSettings,
  type SyncProvider,
} from './kosync';
import { BookOrbitClient, BookOrbitTracker, type BookOrbitBook, type BookOrbitSort } from './bookorbit';
import {
  cacheStatus,
  loadCacheIndex,
  pruneCacheIndex,
  saveCacheIndex,
  upsertCacheEntry,
  type BookOrbitCacheEntry,
  type CacheStatus,
} from './bookorbit-cache';
import { KosyncSession } from './kosync-session';
import { md5Hex } from './md5';
import { RELAY_ORIGIN } from './relay';

import { MockBridge } from './mock-bridge';
import { version as APP_VERSION } from '../package.json';

function toCachedBookMeta(book: Pick<StoredBook, 'bookId' | 'filename' | 'title' | 'timestamp'>): CachedBookMeta {
  return {
    bookId: book.bookId,
    title: book.title,
    filename: book.filename,
    uploadedAt: book.timestamp,
  };
}

async function main() {
  // Web-UI badge from package.json (JSON import) — same source as the
  // glasses splash; no manual sync.
  const versionBadge = document.getElementById('app-version');
  if (versionBadge) versionBadge.textContent = `v${APP_VERSION}`;

  setStatus('Connecting...');

  const urlParams = new URLSearchParams(window.location.search);
  const forceSimulator = urlParams.get('simulator') === 'true';

  let bridge = null;
  if (!forceSimulator) {
    try {
      bridge = await withTimeout(waitForEvenAppBridge(), 2500, 'waitForEvenAppBridge');
    } catch (e) {
      console.warn('Bridge not available, switching to browser mode', e);
    }
  }

  if (!bridge || forceSimulator) {
    console.log('Using MockBridge');
    bridge = MockBridge.getInstance();
    setStatus('Simulator mode');
  }

  let client: EvenEpubClient | null = null;
  let kosyncSettings: KosyncSettings | null = null;

  if (bridge) {
    activateKeepAlive();

    // Hydrate settings from the bridge-backed store BEFORE creating the client,
    // so the first render (startup page + initial layout) reflects persisted
    // values rather than defaults/browser-localStorage fallback. On device the
    // WebView's browser localStorage is wiped across app restarts, so the
    // bridge store is the only source of truth for persisted settings.
    await loadSettingsFromBridge(bridge as any);

    client = new EvenEpubClient(bridge as any);

    // KOSync: settings load before any book opens so the first open can pull.
    kosyncSettings = await loadKosyncSettings(bridge as any, window.localStorage);
    client.createKosyncSession = (book, filename) => {
      const s = kosyncSettings;
      if (!isKosyncLoggedIn(s)) return null;
      return new KosyncSession({ book, filename, settings: s, client: makeKosyncClient(s) });
    };
    // BookOrbit only: reading time (page stats) and "finished" status.
    client.createReadingTracker = (book) => {
      const s = kosyncSettings;
      const bo = makeBookOrbitClient();
      if (!s || !bo || !book.partialMd5) return null;
      return new BookOrbitTracker({
        client: bo,
        hash: book.partialMd5,
        device: { deviceId: s.deviceId, deviceModel: KOSYNC_DEVICE_NAME, pluginVersion: `g2-reader-${APP_VERSION}`.slice(0, 20) },
        onError: (e) => console.warn('BookOrbit stats:', e),
      });
    };

    // Register onLaunchSource BEFORE client.init() so runStartup's pickInitialView
    // decision can consult the launch intent (per Codex #1 / design §3.1a).
    // The callback just stashes the source; runStartup reads it after splash.
    if ('onLaunchSource' in bridge) {
      (bridge as any).onLaunchSource((source: 'appMenu' | 'glassesMenu') => {
        client?.setLaunchIntent(source);
      });
    }

    // Wire up book selection from glasses-side picker
    client.onBookSelected = async (meta: CachedBookMeta) => {
      try {
        setStatus(`Loading: ${meta.title}...`);
        const recent = await getRecentBooksFromDB(bridge as any);
        // Immutable identity only. Falling back to filename/title can open the
        // wrong EPUB when two downloads share metadata.
        const cached = recent.find((book) => book.bookId === meta.bookId);
        if (!cached) {
          setStatus(`Book not available locally: ${meta.title}`);
          return;
        }
        const book = await parseEpub(cached.buffer, cached.filename);
        await client!.loadBook(book, true, cached.bookId, cached.filename);
        await renderLibrary(client!, bridge as any);
      } catch (e) {
        console.error('Failed to load book from picker:', e);
        setStatus('Failed to load book.');
      }
    };

    // Populate book cache BEFORE init so glasses-side can show book picker.
    try {
      const localBooks = await getRecentBooksFromDB(bridge as any);
      if (localBooks.length > 0) {
        await client.cacheBookList(localBooks.map(toCachedBookMeta));
      }
    } catch (e) {
      console.warn('Failed to preload local book list:', e);
    }

    await client.init();
    if (bridge instanceof MockBridge) {
      setStatus('Simulator ready');
    } else {
      setStatus('Connected');
    }

    // Load library
    await renderLibrary(client, bridge as any);
    client.onViewChanged = () => {
      renderLibrary(client as EvenEpubClient, bridge as any);
      renderReaderControls(client as EvenEpubClient);
    };

    // Update position display in library on every page turn
    client.onPositionChanged = (ch, pg) => {
      renderReaderControls(client as EvenEpubClient);
      const items = document.querySelectorAll('#library-container .lib-item');
      const bookId = client?.getBookId();
      if (!bookId) return;
      for (const item of items) {
        if ((item as HTMLElement).dataset.bookId === bookId) {
          const metaEl = item.querySelector('.meta');
          if (metaEl) {
            const parts = metaEl.textContent?.split('·').map((part) => part.trim()) || [];
            const suffix = parts.slice(1).join(' · ');
            metaEl.textContent = suffix
              ? `Ch ${ch + 1}, Pg ${pg + 1} · ${suffix}`
              : `Ch ${ch + 1}, Pg ${pg + 1}`;
          }
          break;
        }
      }
    };

    client.onFlowStateChanged = () => renderReaderControls(client as EvenEpubClient);

    // Dev-only (stripped from production builds): ?demo=<name> preloads
    // samples/<name>.epub, e.g. for simulator screenshot automation.
    const demo = urlParams.get('demo');
    if (import.meta.env.DEV && demo && /^[a-z0-9_-]+$/i.test(demo)) {
      try {
        const data = await (await fetch(`/samples/${demo}.epub`)).arrayBuffer();
        const book = await parseEpub(data, `${demo}.epub`);
        const stored = await saveEpubBufferToDB(data, `${demo}.epub`, book.title, bridge as any);
        await client.loadBook(book, true, stored.bookId, stored.filename);
        await renderLibrary(client, bridge as any);
      } catch (e) {
        console.warn('Demo book failed to load:', e);
      }
    }

    setupReaderControls(client);
    renderReaderControls(client);
  } else {
    setStatus('Error: Could not initialize bridge.');
  }

  // --- Settings UI ---
  const hyphenConfig = document.getElementById('setting-hyphenation') as HTMLInputElement | null;
  const statusBarConfig = document.getElementById('setting-statusbar') as HTMLSelectElement | null;
  const readingModeConfig = document.getElementById('setting-reading-mode') as HTMLSelectElement | null;
  const flowSpeedConfig = document.getElementById('setting-flow-speed') as HTMLInputElement | null;
  const textHeightConfig = document.getElementById('setting-text-height') as HTMLInputElement | null;
  const textHeightValueEl = document.getElementById('setting-text-height-value');
  const saveBtn = document.getElementById('save-settings-btn') as HTMLButtonElement | null;

  const hyphenToggle = document.getElementById('setting-hyphenation-toggle');
  if (hyphenToggle && hyphenConfig) {
    const syncToggle = () => {
      hyphenToggle.classList.toggle('on', hyphenConfig.checked);
    };
    hyphenConfig.checked = config.hyphenation;
    syncToggle();
    hyphenToggle.addEventListener('click', () => {
      hyphenConfig.checked = !hyphenConfig.checked;
      syncToggle();
    });
  }

  if (hyphenConfig && statusBarConfig && readingModeConfig && flowSpeedConfig && textHeightConfig && saveBtn) {
    statusBarConfig.value = config.statusBarPosition;
    readingModeConfig.value = config.readingMode;
    flowSpeedConfig.value = String(config.flowSpeedWpm);
    flowSpeedConfig.min = String(FLOW_MIN_WPM);
    flowSpeedConfig.max = String(FLOW_MAX_WPM);
    textHeightConfig.min = String(TEXT_HEIGHT_MIN_PERCENT);
    textHeightConfig.max = String(TEXT_HEIGHT_MAX_PERCENT);
    textHeightConfig.step = String(TEXT_HEIGHT_STEP_PERCENT);
    textHeightConfig.value = String(config.textHeightPercent);
    if (textHeightValueEl) textHeightValueEl.textContent = `${config.textHeightPercent}%`;
    textHeightConfig.addEventListener('input', () => {
      if (textHeightValueEl) textHeightValueEl.textContent = `${textHeightConfig.value}%`;
    });

    saveBtn.addEventListener('click', async () => {
      config.hyphenation = hyphenConfig.checked;
      config.statusBarPosition = statusBarConfig.value === 'none' ? 'none' : 'bottom';
      config.readingMode = readingModeConfig.value === 'flow' ? 'flow' : 'paged';
      const parsedSpeed = Number.parseInt(flowSpeedConfig.value, 10);
      config.flowSpeedWpm = Number.isFinite(parsedSpeed)
        ? Math.max(FLOW_MIN_WPM, Math.min(FLOW_MAX_WPM, parsedSpeed))
        : config.flowSpeedWpm;
      flowSpeedConfig.value = String(config.flowSpeedWpm);

      const parsedHeight = Number.parseInt(textHeightConfig.value, 10);
      config.textHeightPercent = Number.isFinite(parsedHeight)
        ? Math.max(TEXT_HEIGHT_MIN_PERCENT, Math.min(TEXT_HEIGHT_MAX_PERCENT, parsedHeight))
        : config.textHeightPercent;
      textHeightConfig.value = String(config.textHeightPercent);
      if (textHeightValueEl) textHeightValueEl.textContent = `${config.textHeightPercent}%`;

      saveSettings();
      // Also persist to bridge storage so settings survive an app restart on
      // the G2 device (browser localStorage is ephemeral inside the Even Hub
      // WebView). Fire in parallel with applySettings so the UI updates
      // immediately and isn't blocked by a slow bridge round-trip.
      const bridgeWrite = bridge
        ? saveSettingsToBridge(bridge as any)
        : Promise.resolve();
      if (client) {
        setStatus('Applying settings...');
        await client.applySettings();
        await bridgeWrite;
        setStatus('Settings applied.');
      } else {
        await bridgeWrite;
      }
    });
  }

  setupCollapsible('gut-toggle', 'gut-body');
  setupCollapsible('sync-toggle', 'sync-body');
  const bookOrbitUi = setupBookOrbitLibrary(bridge);
  setupKosyncUi(bridge);
  setupCollapsible('settings-toggle', 'settings-body');

  const toggleSettingsBtn = document.getElementById('toggle-settings');
  if (toggleSettingsBtn) {
    toggleSettingsBtn.addEventListener('click', () => {
      const header = document.getElementById('settings-toggle');
      if (header) header.click();
    });
  }

  // --- File upload ---
  const fileInput = document.getElementById('epub-file') as HTMLInputElement | null;
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;

      setStatus(`Loading: ${file.name}...`);
      try {
        const data = await file.arrayBuffer();
        const book = await parseEpub(data, file.name);
        const stored = await saveEpubBufferToDB(data, file.name, book.title, bridge as any);

        if (client) {
          await client.loadBook(book, false, stored.bookId, stored.filename);
          await renderLibrary(client, bridge as any);
        }
        setStatus(`Loaded: ${book.title}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(`Error: ${msg}`);
        console.error('EPUB parse error:', e);
      }

      fileInput.value = '';
    });
  }

  // --- Gutenberg ---
  const fetchGutBtn = document.getElementById('fetch-gutenberg-btn');
  const gutList = document.getElementById('gutenberg-list');

  if (fetchGutBtn && gutList) {
    fetchGutBtn.addEventListener('click', async () => {
      try {
        setStatus('Fetching Gutenberg catalog...');
        const books = await fetchTopGutenbergBooks();
        gutList.innerHTML = '';
        gutList.style.display = 'block';

        books.forEach((b) => {
          const div = document.createElement('div');
          div.className = 'gut-item';
          // textContent (not innerHTML) — titles are remote content.
          div.innerHTML = '<span></span> <button class="btn btn-ghost btn-sm">Read</button>';
          const titleSpan = div.querySelector('span');
          if (titleSpan) titleSpan.textContent = b.title;

          div.querySelector('button')?.addEventListener('click', async () => {
            try {
              setStatus(`Downloading: ${b.title}...`);
              const arrayBuffer = await downloadGutenbergEpub(b.id);
              setStatus(`Parsing: ${b.title}...`);
              const book = await parseEpub(arrayBuffer, b.title + '.epub');
              const stored = await saveEpubBufferToDB(
                arrayBuffer,
                b.title + '.epub',
                book.title,
                bridge as any,
              );

              if (client) {
                await client.loadBook(book, false, stored.bookId, stored.filename);
                await renderLibrary(client, bridge as any);
              }
              setStatus(`Loaded: ${book.title}`);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              setStatus(`Error: ${msg}`);
            }
          });

          gutList.appendChild(div);
        });
        setStatus(`Found ${books.length} books.`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(`Failed to fetch Gutenberg list: ${msg}`);
      }
    });
  }

  // --- Library rendering (local-only) ---
  async function renderLibrary(clientToUse: EvenEpubClient, bridgeRef?: any) {
    const container = document.getElementById('library-container');
    if (!container) return;

    try {
      const localBooks = await getRecentBooksFromDB(bridgeRef);
      const metas = localBooks.map(toCachedBookMeta);
      const localById = new Map(localBooks.map((book) => [book.bookId, book]));
      container.innerHTML = '';

      if (metas.length === 0) {
        container.innerHTML = '<div class="lib-empty">No books yet. Upload an EPUB or browse Gutenberg.</div>';
        const search = document.getElementById('library-search') as HTMLInputElement | null;
        if (search) search.hidden = true;
        const count = document.getElementById('library-count');
        if (count) count.textContent = '0';
        await clientToUse.cacheBookList([]);
        return;
      }

      const search = document.getElementById('library-search') as HTMLInputElement | null;
      if (search) search.hidden = false;

      await clientToUse.cacheBookList(metas);

      for (const meta of metas) {
        const local = localById.get(meta.bookId);
        if (!local) continue;
        const item = document.createElement('div');
        item.className = 'lib-item';
        item.dataset.bookId = meta.bookId;
        item.dataset.title = meta.title;
        item.dataset.filename = meta.filename;

        let posText = 'Not started';
        try {
          const savedPos = await clientToUse.getSavedPosition(meta.title, meta.bookId);
          if (savedPos) {
            posText = `Ch ${savedPos.chapterIndex + 1}, Pg ${savedPos.pageIndex + 1}`;
          }
        } catch { /* ignore */ }

        const date = new Date(meta.uploadedAt);
        const dateStr = date.toLocaleDateString('en', { month: 'short', day: 'numeric' });

        // Static skeleton via innerHTML; title/meta set with textContent so a
        // crafted EPUB title can't inject markup into the WebView.
        item.innerHTML = `
          <div class="info">
            <div class="title-row">
              <div class="title"></div>
            </div>
            <div class="filename"></div>
            <div class="meta"></div>
          </div>
          <button class="del" title="Delete">&times;</button>
        `;
        const titleEl = item.querySelector('.title');
        if (titleEl) titleEl.textContent = meta.title;
        const filenameEl = item.querySelector('.filename');
        if (filenameEl) filenameEl.textContent = meta.filename;
        const metaEl = item.querySelector('.meta');
        if (metaEl) metaEl.textContent = `${posText} · ${dateStr}`;

        item.querySelector('.info')?.addEventListener('click', async () => {
          try {
            setStatus(`Loading: ${meta.title}...`);
            const book = await parseEpub(local.buffer, meta.filename);
            await clientToUse.loadBook(book, true, meta.bookId, meta.filename);
            await renderLibrary(clientToUse, bridgeRef);
          } catch (e) {
            console.error(e);
            setStatus('Failed to load book.');
          }
        });

        item.querySelector('.del')?.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          if (!window.confirm(`Delete "${meta.title}"?\n\nThis removes the book from this device.`)) {
            return;
          }
          setStatus(`Deleting: ${meta.title}...`);
          try {
            await deleteFromDB(meta.bookId, bridgeRef);
            await renderLibrary(clientToUse, bridgeRef);
            await bookOrbitUi.localLibraryChanged();
            setStatus('Book deleted.');
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setStatus(`Delete failed: ${msg}`);
          }
        });

        container.appendChild(item);
      }
      applyLibraryFilter();
    } catch (e) {
      console.error('Error loading library:', e);
    }
  }

  function makeKosyncClient(s: KosyncSettings, username = s.username, userkey = s.userkey): KosyncClient {
    // BookOrbit is reached directly (its origin is whitelisted in personal
    // builds, CORS added by its reverse proxy); the relay only forwards plain
    // kosync calls.
    const relayOrigin = s.provider === 'bookorbit' ? null : RELAY_ORIGIN;
    return s.provider === 'bookorbit'
      ? new BookOrbitClient({ server: s.server, username, userkey, relayOrigin })
      : new KosyncClient({ server: s.server, username, userkey, relayOrigin });
  }

  function makeBookOrbitClient(): BookOrbitClient | null {
    const s = kosyncSettings;
    if (!isKosyncLoggedIn(s) || s.provider !== 'bookorbit') return null;
    return makeKosyncClient(s) as BookOrbitClient;
  }

  function setupKosyncUi(storageBridge: any) {
    const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
    const providerEl = el<HTMLSelectElement>('sync-provider');
    const noteEl = el<HTMLElement>('sync-note');
    const serverLabelEl = el<HTMLElement>('sync-server-label');
    const serverEl = el<HTMLInputElement>('sync-server');
    const userEl = el<HTMLInputElement>('sync-username');
    const passEl = el<HTMLInputElement>('sync-password');
    const checksumRow = el<HTMLElement>('sync-checksum-row');
    const checksumEl = el<HTMLSelectElement>('sync-checksum');
    const loginBtn = el<HTMLButtonElement>('sync-login-btn');
    const registerBtn = el<HTMLButtonElement>('sync-register-btn');
    const syncNowBtn = el<HTMLButtonElement>('sync-now-btn');
    const logoutBtn = el<HTMLButtonElement>('sync-logout-btn');
    const outActions = el<HTMLElement>('sync-actions-out');
    const inActions = el<HTMLElement>('sync-actions-in');
    const stateEl = el<HTMLElement>('sync-state');
    if (!providerEl || !noteEl || !serverLabelEl || !serverEl || !userEl || !passEl || !checksumRow || !checksumEl
      || !loginBtn || !registerBtn || !syncNowBtn || !logoutBtn || !outActions || !inActions || !stateEl) return;

    const NOTES: Record<SyncProvider, string> = {
      bookorbit: 'Sync your place, reading time and finished books with BookOrbit, and download books from your '
        + 'BookOrbit library. Use the KOReader login from BookOrbit (Settings > KOReader). Only its MD5 key is stored.',
      kosync: 'Keep your place in sync with KOReader and other apps that support its Progress sync server. '
        + 'Use the same server and account as in KOReader. Only the MD5 key of your password is stored.',
    };

    // The provider being edited (may differ from the saved one until login).
    // Not logged in yet: offer BookOrbit first (the setup this reader is built around).
    let editingProvider: SyncProvider = kosyncSettings && isKosyncLoggedIn(kosyncSettings)
      ? kosyncSettings.provider
      : 'bookorbit';

    const addressFor = (s: KosyncSettings) => (s.provider === 'bookorbit' ? bookOrbitAddress(s.server) : s.server);

    // fillFields: copy saved values into the form (first show, login/logout,
    // provider switch). Plain status updates must not wipe what the user typed.
    const render = (message?: string, fillFields = false) => {
      const s = kosyncSettings;
      if (!s) {
        stateEl.textContent = 'Not available in this mode.';
        return;
      }
      // Boolean(): a plain flag, so the type guard doesn't narrow `s` to never below.
      const loggedIn = Boolean(isKosyncLoggedIn(s));
      if (loggedIn) editingProvider = s.provider;
      const isBookOrbit = editingProvider === 'bookorbit';
      providerEl.value = editingProvider;
      providerEl.disabled = loggedIn;
      noteEl.textContent = NOTES[editingProvider];
      serverLabelEl.textContent = isBookOrbit ? 'BookOrbit address' : 'Server';
      serverEl.placeholder = isBookOrbit ? 'https://bookorbit.example.org' : DEFAULT_KOSYNC_SERVER;
      if (fillFields || loggedIn) {
        serverEl.value = s.provider === editingProvider ? addressFor(s) : '';
        userEl.value = s.username;
      }
      checksumEl.value = s.checksum;
      // BookOrbit matches books by file content; the file-name digest can't match its library.
      checksumRow.style.display = isBookOrbit ? 'none' : '';
      registerBtn.style.display = isBookOrbit ? 'none' : '';
      serverEl.disabled = loggedIn;
      userEl.disabled = loggedIn;
      const passRow = passEl.closest('.s-row') as HTMLElement | null;
      if (passRow) passRow.style.display = loggedIn ? 'none' : '';
      outActions.style.display = loggedIn ? 'none' : 'flex';
      inActions.style.display = loggedIn ? 'flex' : 'none';
      stateEl.textContent = message ?? (loggedIn
        ? `Logged in to ${isBookOrbit ? 'BookOrbit' : 'the sync server'} as ${s.username}. Syncs when a book opens, `
          + 'while reading, and via "Sync progress" in the glasses menu.'
        : 'Not logged in.');
      bookOrbitUi.refresh();
    };

    const persist = async (next: KosyncSettings, message?: string) => {
      await saveKosyncSettings(next, storageBridge, window.localStorage);
      kosyncSettings = next;
      client?.refreshKosyncSession();
      render(message, true);
    };

    const readForm = (): { server: string; username: string; password: string } | null => {
      const server = editingProvider === 'bookorbit'
        ? bookOrbitKosyncBase(serverEl.value)
        : normalizeServerUrl(serverEl.value);
      const username = userEl.value.trim();
      const password = passEl.value;
      if (!server) {
        render(editingProvider === 'bookorbit'
          ? 'Enter your BookOrbit address, e.g. https://bookorbit.example.org'
          : 'Enter the server address, e.g. https://sync.koreader.rocks');
        return null;
      }
      if (!username || !password) {
        render('Enter a username and password.');
        return null;
      }
      return { server, username, password };
    };

    const busy = async (button: HTMLButtonElement, work: () => Promise<void>) => {
      button.disabled = true;
      try {
        await work();
      } catch (e) {
        const msg = e instanceof KosyncError ? e.message : (e instanceof Error ? e.message : String(e));
        render(msg);
      } finally {
        button.disabled = false;
      }
    };

    providerEl.addEventListener('change', () => {
      editingProvider = providerEl.value === 'kosync' ? 'kosync' : 'bookorbit';
      render(undefined, true);
    });

    loginBtn.addEventListener('click', () => busy(loginBtn, async () => {
      const s = kosyncSettings;
      const form = readForm();
      if (!s || !form) return;
      const userkey = md5Hex(form.password);
      const candidate: KosyncSettings = {
        ...s,
        provider: editingProvider,
        server: form.server,
        // BookOrbit identifies books by file content only.
        checksum: editingProvider === 'bookorbit' ? 'binary' : s.checksum,
      };
      render('Logging in...');
      const ok = await makeKosyncClient(candidate, form.username, userkey).authorize();
      if (!ok) {
        render('Wrong username or password.');
        return;
      }
      passEl.value = '';
      await persist({ ...candidate, username: form.username, userkey });
    }));

    registerBtn.addEventListener('click', () => busy(registerBtn, async () => {
      const s = kosyncSettings;
      const form = readForm();
      if (!s || !form) return;
      render('Creating account...');
      const candidate: KosyncSettings = { ...s, provider: 'kosync', server: form.server };
      const created = await makeKosyncClient(candidate, '', '').register(form.username, form.password);
      if (!created) {
        render('That username is already taken on this server.');
        return;
      }
      passEl.value = '';
      await persist({ ...candidate, username: form.username, userkey: md5Hex(form.password) });
    }));

    logoutBtn.addEventListener('click', () => busy(logoutBtn, async () => {
      if (!kosyncSettings) return;
      await persist({ ...kosyncSettings, userkey: '' }, 'Logged out.');
    }));

    syncNowBtn.addEventListener('click', () => busy(syncNowBtn, async () => {
      if (!client?.hasKosyncSession()) {
        render('Open a book to sync its progress.');
        return;
      }
      render(await client.syncKosyncNow());
    }));

    checksumEl.addEventListener('change', () => {
      if (!kosyncSettings) return;
      const checksum = checksumEl.value === 'filename' ? 'filename' : 'binary';
      persist({ ...kosyncSettings, checksum }).catch((e) => render(String(e)));
    });

    render(undefined, true);
  }

  /**
   * "BookOrbit library": browse/search the catalog, download EPUBs into the
   * local library (offline reading), open local copies without the network,
   * and offer updates when a book changed in BookOrbit.
   */
  function setupBookOrbitLibrary(storageBridge: any) {
    const toggle = document.getElementById('bo-toggle');
    const body = document.getElementById('bo-body');
    const search = document.getElementById('bo-search') as HTMLInputElement | null;
    const sort = document.getElementById('bo-sort') as HTMLSelectElement | null;
    const list = document.getElementById('bo-list');
    const more = document.getElementById('bo-more') as HTMLButtonElement | null;
    const state = document.getElementById('bo-state');
    if (!toggle || !body || !search || !sort || !list || !more || !state) {
      return { refresh() {}, async localLibraryChanged() {} };
    }

    let page = 1;
    let loading = false;
    // Bumped by every new search/sort/refresh; responses for older ones are dropped.
    let generation = 0;
    let loadedOnce = false;
    let query = '';
    let searchTimer: number | null = null;
    const rows = new Map<number, { book: BookOrbitBook; render: () => void }>();
    const inFlight = new Map<number, Promise<StoredBook | null>>();

    // Local library ids + the BookOrbit download index, refreshed per list load.
    let localIds = new Set<string>();
    let index: BookOrbitCacheEntry[] = [];
    let listTotal = 0;
    const updateSummary = () => {
      const bo = makeBookOrbitClient();
      if (!bo || listTotal === 0) return;
      const onDevice = index.filter((e) => e.account === bo.accountKey && localIds.has(e.localBookId)).length;
      state.textContent = `${list.childElementCount} of ${listTotal} EPUBs · ${onDevice} on this device`;
    };
    const refreshLocalState = async () => {
      const local = await getRecentBooksFromDB(storageBridge).catch(() => [] as StoredBook[]);
      localIds = new Set(local.map((b) => b.bookId));
      const loaded = await loadCacheIndex(storageBridge, window.localStorage);
      index = pruneCacheIndex(loaded, localIds);
      if (index.length !== loaded.length) await saveCacheIndex(index, storageBridge, window.localStorage).catch(() => {});
    };

    const formatMeta = (b: BookOrbitBook, status: CacheStatus): string => {
      const parts: string[] = [];
      if (b.authors.length > 0) parts.push(b.authors.join(', '));
      if (b.readStatus === 'read') parts.push('Finished');
      else if (b.progressPercentage !== null && b.progressPercentage > 0) parts.push(`${Math.round(b.progressPercentage)}%`);
      if (status.kind === 'onDevice') parts.push('On device');
      if (status.kind === 'updateAvailable') parts.push('Update available');
      return parts.join(' · ');
    };

    /** Download (or re-download) a book into the local library. */
    const download = (b: BookOrbitBook, onProgress: (text: string) => void): Promise<StoredBook | null> => {
      const running = inFlight.get(b.id);
      if (running) return running;
      const job = (async () => {
        const bo = makeBookOrbitClient();
        if (!bo) return null;
        const file = await bo.epubFile(b.id);
        if (!file) throw new Error(`No EPUB file for "${b.title}" in BookOrbit`);
        const data = await bo.download(file.id, {
          expectedBytes: file.sizeBytes,
          onProgress: (received, total) => onProgress(total ? `${Math.floor((received / total) * 100)}%` : `${Math.round(received / 1024)} KB`),
        });
        onProgress('Saving...');
        const filename = `${b.title}.epub`;
        const parsed = await parseEpub(data, filename); // validate before storing
        const stored = await saveEpubBufferToDB(data, filename, parsed.title, storageBridge);
        index = upsertCacheEntry(index, {
          account: bo.accountKey,
          bookOrbitId: b.id,
          fileId: file.id,
          localBookId: stored.bookId,
          title: b.title,
          remoteUpdatedAt: b.updatedAt,
          sizeBytes: data.byteLength,
          downloadedAt: Date.now(),
        });
        localIds.add(stored.bookId);
        await saveCacheIndex(index, storageBridge, window.localStorage);
        updateSummary();
        if (client) await renderLibrary(client, storageBridge); // also refreshes the glasses' book list
        if (stored.durable === false) {
          setStatus(`"${b.title}" is saved for this session only: device storage is full. Delete some books to keep it offline.`);
        }
        return stored;
      })();
      inFlight.set(b.id, job);
      job.finally(() => inFlight.delete(b.id)).catch(() => {});
      return job;
    };

    /** Open the local copy (offline), downloading it first if needed. */
    const read = async (b: BookOrbitBook, onProgress: (text: string) => void) => {
      const bo = makeBookOrbitClient();
      if (!bo || !client) return;
      const status = cacheStatus(index, bo.accountKey, b, localIds);
      let stored: StoredBook | null = null;
      if (status.kind !== 'none') {
        const local = await getRecentBooksFromDB(storageBridge);
        stored = local.find((x) => x.bookId === status.entry.localBookId) ?? null;
      }
      if (!stored) {
        setStatus(`Downloading from BookOrbit: ${b.title}...`);
        stored = await download(b, onProgress);
      }
      if (!stored) return;
      const book = await parseEpub(stored.buffer, stored.filename);
      // resume=true: the sync pull places the reader at BookOrbit's position.
      await client.loadBook(book, true, stored.bookId, stored.filename);
      await renderLibrary(client, storageBridge);
      setStatus(`Loaded: ${book.title}`);
    };

    const addRow = (b: BookOrbitBook) => {
      const row = document.createElement('div');
      row.className = 'gut-item bo-item';
      // textContent only: titles are remote content.
      row.innerHTML = '<div><span class="bo-title"></span><div class="bo-meta"></div></div>'
        + '<div class="bo-actions"><button class="btn btn-ghost btn-sm bo-dl"></button>'
        + '<button class="btn btn-sm bo-read">Read</button></div>';
      (row.querySelector('.bo-title') as HTMLElement).textContent = b.title;
      const meta = row.querySelector('.bo-meta') as HTMLElement;
      const dl = row.querySelector('.bo-dl') as HTMLButtonElement;
      const readBtn = row.querySelector('.bo-read') as HTMLButtonElement;

      const render = () => {
        const bo = makeBookOrbitClient();
        const status = bo ? cacheStatus(index, bo.accountKey, b, localIds) : { kind: 'none' as const };
        meta.textContent = formatMeta(b, status);
        const busy = inFlight.has(b.id);
        dl.disabled = busy || status.kind === 'onDevice';
        if (!busy) dl.textContent = status.kind === 'onDevice' ? 'Downloaded' : status.kind === 'updateAvailable' ? 'Update' : 'Download';
        readBtn.disabled = busy;
      };
      const progress = (text: string) => { dl.textContent = text; };
      const run = async (work: () => Promise<unknown>) => {
        dl.disabled = true;
        readBtn.disabled = true;
        try {
          await work();
        } catch (e) {
          setStatus(`BookOrbit: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          render();
        }
      };
      dl.addEventListener('click', () => run(async () => {
        await download(b, progress);
        setStatus(`Downloaded for offline reading: ${b.title}`);
      }));
      readBtn.addEventListener('click', () => run(() => read(b, progress)));
      rows.set(b.id, { book: b, render });
      render();
      list.appendChild(row);
    };

    const load = async (reset: boolean) => {
      const bo = makeBookOrbitClient();
      if (!bo || (loading && !reset)) return; // "Load more" waits; a new search supersedes
      const mine = reset ? ++generation : generation;
      loading = true;
      if (reset) {
        page = 1;
        list.innerHTML = '';
        rows.clear();
        more.style.display = 'none';
      }
      state.textContent = 'Loading...';
      try {
        if (reset) await refreshLocalState();
        const result = await bo.listBooks({ q: query, page, size: 20, sort: sort.value as BookOrbitSort });
        if (mine !== generation) return; // a newer search started meanwhile
        for (const b of result.items) addRow(b);
        page = result.page + 1;
        more.style.display = result.hasNext ? '' : 'none';
        listTotal = result.total;
        if (result.total === 0) state.textContent = query ? 'No EPUBs match your search.' : 'No EPUBs in your BookOrbit library.';
        else updateSummary();
        loadedOnce = true;
      } catch (e) {
        if (mine === generation) {
          // Offline: say so, and point at the books that are already local.
          const onDevice = index.filter((x) => x.account === bo.accountKey && localIds.has(x.localBookId)).length;
          const offline = e instanceof KosyncError && e.status === null;
          state.textContent = (offline ? 'BookOrbit is not reachable (offline or away from home/Tailscale).' : String(e instanceof Error ? e.message : e))
            + (onDevice > 0
              ? ` ${onDevice === 1 ? 'Your downloaded book is' : `Your ${onDevice} downloaded books are`} in the Library above and read offline.`
              : '');
        }
      } finally {
        if (mine === generation) loading = false;
      }
    };

    toggle.addEventListener('click', () => {
      toggle.classList.toggle('open');
      body.classList.toggle('open');
      if (body.classList.contains('open') && !loadedOnce) void load(true);
    });
    search.addEventListener('input', () => {
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        query = search.value;
        void load(true);
      }, 350);
    });
    sort.addEventListener('change', () => { void load(true); });
    more.addEventListener('click', () => { void load(false); });

    return {
      /** Show the section only while logged in to BookOrbit. */
      refresh() {
        const visible = makeBookOrbitClient() !== null;
        toggle.style.display = visible ? '' : 'none';
        if (!visible) {
          generation++; // drop any response still in flight for the old login
          loading = false;
          body.classList.remove('open');
          toggle.classList.remove('open');
          list.innerHTML = '';
          rows.clear();
          loadedOnce = false;
        } else if (body.classList.contains('open')) {
          void load(true);
        }
      },
      /** The local library changed (e.g. a book was deleted): update badges. */
      async localLibraryChanged() {
        await refreshLocalState();
        for (const r of rows.values()) r.render();
        updateSummary();
      },
    };
  }

  function setupCollapsible(headerId: string, bodyId: string) {
    const header = document.getElementById(headerId);
    const body = document.getElementById(bodyId);
    if (!header || !body) return;
    header.addEventListener('click', () => {
      header.classList.toggle('open');
      body.classList.toggle('open');
    });
  }

  function setupReaderControls(c: EvenEpubClient) {
    const prevPageBtn = document.getElementById('rc-prev-page') as HTMLButtonElement | null;
    const nextPageBtn = document.getElementById('rc-next-page') as HTMLButtonElement | null;
    const toggleFlowBtn = document.getElementById('rc-toggle-flow') as HTMLButtonElement | null;
    const prevChapterBtn = document.getElementById('rc-prev-chapter') as HTMLButtonElement | null;
    const nextChapterBtn = document.getElementById('rc-next-chapter') as HTMLButtonElement | null;
    const toggleInfoBtn = document.getElementById('rc-toggle-info') as HTMLButtonElement | null;

    prevPageBtn?.addEventListener('click', () => { c.pagedPrev().catch((e) => console.warn(e)); });
    nextPageBtn?.addEventListener('click', () => { c.pagedNext().catch((e) => console.warn(e)); });
    toggleFlowBtn?.addEventListener('click', () => { c.toggleFlowPlayback(); });
    prevChapterBtn?.addEventListener('click', () => { c.flowPrevChapter().catch((e) => console.warn(e)); });
    nextChapterBtn?.addEventListener('click', () => { c.flowNextChapter().catch((e) => console.warn(e)); });
    toggleInfoBtn?.addEventListener('click', () => { c.toggleReadingInfo().catch((e) => console.warn(e)); });
  }

  function renderReaderControls(c: EvenEpubClient) {
    const card = document.getElementById('reader-controls');
    if (!card) return;
    const view = c.getView();
    const meta = document.getElementById('reader-meta');
    const toggleInfo = document.getElementById('rc-toggle-info');
    if (toggleInfo) {
      toggleInfo.textContent = c.isReadingInfoVisible()
        ? 'Hide reading info · gain 1 line'
        : 'Show reading info';
    }

    if (view === 'reading') {
      card.classList.add('open', 'paged');
      card.classList.remove('flow');
      const prev = document.getElementById('rc-prev-page') as HTMLButtonElement | null;
      const next = document.getElementById('rc-next-page') as HTMLButtonElement | null;
      if (prev) prev.disabled = !c.canPagedPrev();
      if (next) next.disabled = !c.canPagedNext();
      if (meta) meta.textContent = 'Paged mode';
    } else if (view === 'flowReading') {
      card.classList.add('open', 'flow');
      card.classList.remove('paged');
      const toggle = document.getElementById('rc-toggle-flow') as HTMLButtonElement | null;
      const prev = document.getElementById('rc-prev-chapter') as HTMLButtonElement | null;
      const next = document.getElementById('rc-next-chapter') as HTMLButtonElement | null;
      if (toggle) toggle.innerHTML = c.isFlowActive() ? '&#10074;&#10074; Pause' : '&#9654; Start';
      if (prev) prev.disabled = !c.canFlowPrevChapter();
      if (next) next.disabled = !c.canFlowNextChapter();
      if (meta) meta.textContent = c.isFlowActive() ? 'Flow running' : 'Flow paused';
    } else {
      card.classList.remove('open', 'paged', 'flow');
    }
  }

  function applyLibraryFilter() {
    const query = (document.getElementById('library-search') as HTMLInputElement | null)?.value ?? '';
    const items = Array.from(document.querySelectorAll<HTMLElement>('#library-container .lib-item'));
    let visible = 0;
    for (const item of items) {
      const matches = matchesBookQuery({
        title: item.dataset.title ?? '',
        filename: item.dataset.filename ?? '',
      }, query);
      item.hidden = !matches;
      if (matches) visible++;
    }
    const count = document.getElementById('library-count');
    if (count) count.textContent = query.trim() ? `${visible}/${items.length}` : String(items.length);
  }

  document.getElementById('library-search')?.addEventListener('input', applyLibraryFilter);
}

main().catch((e) => {
  setStatus(String(e));
  console.error(e);
});
