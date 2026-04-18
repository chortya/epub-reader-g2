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
  saveSettings,
  STORAGE_KEY_BOOK_TITLE,
  TEXT_HEIGHT_MAX_PERCENT,
  TEXT_HEIGHT_MIN_PERCENT,
  TEXT_HEIGHT_STEP_PERCENT,
} from './constants';
import type { CachedBookMeta } from './types';
import { makeBookId } from './book-id';

import { MockBridge } from './mock-bridge';

function toCachedBookMeta(book: Pick<StoredBook, 'filename' | 'title' | 'timestamp'>): CachedBookMeta {
  return {
    bookId: makeBookId(book.filename, book.title),
    title: book.title,
    filename: book.filename,
    uploadedAt: book.timestamp,
  };
}

async function main() {
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

  if (bridge) {
    activateKeepAlive();

    client = new EvenEpubClient(bridge as any);

    // Wire up book selection from glasses-side picker
    client.onBookSelected = async (meta: CachedBookMeta) => {
      try {
        setStatus(`Loading: ${meta.title}...`);
        const recent = await getRecentBooksFromDB(bridge as any);
        const cached = recent.find((r) =>
          r.title === meta.title ||
          r.filename === meta.filename ||
          makeBookId(r.filename, r.title) === meta.bookId,
        );
        if (!cached) {
          setStatus(`Book not available locally: ${meta.title}`);
          return;
        }
        const book = await parseEpub(cached.buffer, cached.filename);
        await client!.loadBook(book, true, makeBookId(cached.filename, cached.title));
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

    // Auto-resume last book when launched from glasses menu
    if ('onLaunchSource' in bridge) {
      (bridge as any).onLaunchSource(async (source: string) => {
        if (source === 'glassesMenu' && client) {
          try {
            const lastTitle = await (bridge as any).getLocalStorage(STORAGE_KEY_BOOK_TITLE);
            if (!lastTitle) return;
            const recent = await getRecentBooksFromDB(bridge as any);
            const match = recent.find((r) => r.title === lastTitle);
            if (match) {
              const book = await parseEpub(match.buffer, match.filename);
              await client.loadBook(book, true, makeBookId(match.filename, match.title));
            }
          } catch (e) {
            console.warn('Failed to auto-resume book:', e);
          }
        }
      });
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
      const bookTitle = client?.['book']?.title;
      if (!bookTitle) return;
      for (const item of items) {
        const titleEl = item.querySelector('.title');
        if (titleEl?.textContent === bookTitle) {
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
      config.statusBarPosition = statusBarConfig.value as 'none' | 'bottom' | 'right';
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
      if (client) {
        setStatus('Applying settings...');
        await client.applySettings();
        setStatus('Settings applied.');
      }
    });
  }

  setupCollapsible('gut-toggle', 'gut-body');
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
        await saveEpubBufferToDB(data, file.name, book.title, bridge as any);

        if (client) {
          const id = makeBookId(file.name, book.title);
          await client.loadBook(book, false, id);
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
          div.innerHTML = `<span>${b.title}</span> <button class="btn btn-ghost btn-sm">Read</button>`;

          div.querySelector('button')?.addEventListener('click', async () => {
            try {
              setStatus(`Downloading: ${b.title}...`);
              const arrayBuffer = await downloadGutenbergEpub(b.id);
              setStatus(`Parsing: ${b.title}...`);
              const book = await parseEpub(arrayBuffer, b.title + '.epub');
              await saveEpubBufferToDB(arrayBuffer, b.title + '.epub', book.title, bridge as any);

              if (client) {
                await client.loadBook(book, false, makeBookId(b.title + '.epub', book.title));
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
      const localById = new Map(localBooks.map((book) => [makeBookId(book.filename, book.title), book]));
      container.innerHTML = '';

      if (metas.length === 0) {
        container.innerHTML = '<div class="lib-empty">No books yet. Upload an EPUB or browse Gutenberg.</div>';
        await clientToUse.cacheBookList([]);
        return;
      }

      await clientToUse.cacheBookList(metas);

      for (const meta of metas) {
        const local = localById.get(meta.bookId);
        if (!local) continue;
        const item = document.createElement('div');
        item.className = 'lib-item';

        let posText = 'Not started';
        try {
          const savedPos = await clientToUse.getSavedPosition(meta.title, meta.bookId);
          if (savedPos) {
            posText = `Ch ${savedPos.chapterIndex + 1}, Pg ${savedPos.pageIndex + 1}`;
          }
        } catch { /* ignore */ }

        const date = new Date(meta.uploadedAt);
        const dateStr = date.toLocaleDateString('en', { month: 'short', day: 'numeric' });

        item.innerHTML = `
          <div class="info">
            <div class="title-row">
              <div class="title">${meta.title}</div>
            </div>
            <div class="meta">${posText} &middot; ${dateStr}</div>
          </div>
          <button class="del" title="Delete">&times;</button>
        `;

        item.querySelector('.info')?.addEventListener('click', async () => {
          try {
            setStatus(`Loading: ${meta.title}...`);
            const book = await parseEpub(local.buffer, meta.filename);
            await clientToUse.loadBook(book, true, meta.bookId);
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
            await deleteFromDB(meta.filename, bridgeRef);
            await renderLibrary(clientToUse, bridgeRef);
            setStatus('Book deleted.');
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setStatus(`Delete failed: ${msg}`);
          }
        });

        container.appendChild(item);
      }
    } catch (e) {
      console.error('Error loading library:', e);
    }
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

    prevPageBtn?.addEventListener('click', () => { c.pagedPrev().catch((e) => console.warn(e)); });
    nextPageBtn?.addEventListener('click', () => { c.pagedNext().catch((e) => console.warn(e)); });
    toggleFlowBtn?.addEventListener('click', () => { c.toggleFlowPlayback(); });
    prevChapterBtn?.addEventListener('click', () => { c.flowPrevChapter().catch((e) => console.warn(e)); });
    nextChapterBtn?.addEventListener('click', () => { c.flowNextChapter().catch((e) => console.warn(e)); });
  }

  function renderReaderControls(c: EvenEpubClient) {
    const card = document.getElementById('reader-controls');
    if (!card) return;
    const view = c.getView();
    const meta = document.getElementById('reader-meta');

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
}

main().catch((e) => {
  setStatus(String(e));
  console.error(e);
});
