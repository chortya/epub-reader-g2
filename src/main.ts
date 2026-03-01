import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { setStatus, appendEventLog, withTimeout } from './utils';
import { parseEpub } from './epub-parser';
import { EvenEpubClient } from './even-client';
import { fetchTopGutenbergBooks, downloadGutenbergEpub } from './gutenberg';
import { getRecentBooksFromDB, saveEpubBufferToDB } from './db';
import { config, FLOW_MAX_WPM, FLOW_MIN_WPM, saveSettings } from './constants';
import { APP_LOGO } from './logo';

import { MockBridge } from './mock-bridge';

async function main() {
  setStatus(APP_LOGO + '\n\nWaiting for Even bridge\u2026');

  // Check for force simulator mode
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

  // Fallback to MockBridge if real bridge is missing or forced
  if (!bridge || forceSimulator) {
    console.log('Using MockBridge');
    bridge = MockBridge.getInstance();
    setStatus('Simulator Mode');
  }

  let client: EvenEpubClient | null = null;

  if (bridge) {
    // Force cast because MockBridge is compatible enough for our usage
    client = new EvenEpubClient(bridge as any);
    await client.init();
    if (bridge instanceof MockBridge) {
      setStatus(APP_LOGO + '\n\nSimulator Ready. Upload an EPUB file to test.');
      appendEventLog('MockBridge connected');
    } else {
      setStatus(APP_LOGO + '\n\nConnected. Upload an EPUB file to begin reading.');
      appendEventLog('Bridge connected');
    }

    // Load Bookmarks
    await renderBookmarks(client);
    client.onViewChanged = () => renderBookmarks(client as EvenEpubClient);
  } else {
    // Should not happen with MockBridge
    setStatus('Error: Could not initialize bridge.');
  }

  // Setup Settings UI
  const hyphenConfig = document.getElementById('setting-hyphenation') as HTMLInputElement | null;
  const statusBarConfig = document.getElementById('setting-statusbar') as HTMLSelectElement | null;
  const readingModeConfig = document.getElementById('setting-reading-mode') as HTMLSelectElement | null;
  const flowSpeedConfig = document.getElementById('setting-flow-speed') as HTMLInputElement | null;
  const saveBtn = document.getElementById('save-settings-btn') as HTMLButtonElement | null;

  if (hyphenConfig && statusBarConfig && readingModeConfig && flowSpeedConfig && saveBtn) {
    hyphenConfig.checked = config.hyphenation;
    statusBarConfig.value = config.statusBarPosition;
    readingModeConfig.value = config.readingMode;
    flowSpeedConfig.value = String(config.flowSpeedWpm);
    flowSpeedConfig.min = String(FLOW_MIN_WPM);
    flowSpeedConfig.max = String(FLOW_MAX_WPM);

    saveBtn.addEventListener('click', async () => {
      const hyph = hyphenConfig.checked;
      const showStatus = statusBarConfig.value as 'none' | 'bottom' | 'right';
      const readingMode = readingModeConfig.value === 'flow' ? 'flow' : 'paged';
      const parsedSpeed = Number.parseInt(flowSpeedConfig.value, 10);
      const flowSpeedWpm = Number.isFinite(parsedSpeed)
        ? Math.max(FLOW_MIN_WPM, Math.min(FLOW_MAX_WPM, parsedSpeed))
        : config.flowSpeedWpm;

      config.hyphenation = hyph;
      config.statusBarPosition = showStatus;
      config.readingMode = readingMode;
      config.flowSpeedWpm = flowSpeedWpm;
      flowSpeedConfig.value = String(flowSpeedWpm);

      saveSettings();
      appendEventLog(
        `Settings saved - hyphenation: ${config.hyphenation}, status bar: ${config.statusBarPosition}, mode: ${config.readingMode}, flowSpeedWpm: ${config.flowSpeedWpm}`,
      );

      if (client) {
        setStatus('Applying new settings...');
        await client.applySettings();
        if (client['book']) {
          setStatus(`Settings applied. Continuing reading ${client['book'].title}`);
        } else {
          setStatus('Settings applied. Ready. Upload an EPUB file.');
        }
      }
    });
  }

  // Wire up file upload
  const fileInput = document.getElementById('epub-file') as HTMLInputElement | null;
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;

      setStatus(`Loading: ${file.name}\u2026`);
      appendEventLog(`File selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

      try {
        const data = await file.arrayBuffer();
        const book = await parseEpub(data);
        await saveEpubBufferToDB(data, file.name, book.title);

        appendEventLog(
          `Parsed: "${book.title}" with ${book.chapters.length} chapters`,
        );

        if (client) {
          await client.loadBook(book);
          await renderBookmarks(client);
        } else {
          // Browser-only mode: just show parse results
          const summary = book.chapters
            .map(
              (ch, i) =>
                `${i + 1}. ${ch.title} (${ch.text.length} chars)`,
            )
            .join('\n');
          setStatus(`Parsed: ${book.title}\n\nChapters:\n${summary}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(`Error parsing EPUB: ${msg}`);
        appendEventLog(`Parse error: ${msg}`);
        console.error('EPUB parse error:', e);
      }

      // Reset input so re-uploading the same file triggers change
      fileInput.value = '';
    });
  }

  // Wire up Gutenberg
  const fetchGutBtn = document.getElementById('fetch-gutenberg-btn');
  const gutList = document.getElementById('gutenberg-list');

  if (fetchGutBtn && gutList) {
    fetchGutBtn.addEventListener('click', async () => {
      try {
        setStatus('Fetching Top 100 Project Gutenberg books...');
        const books = await fetchTopGutenbergBooks();
        gutList.innerHTML = '';
        gutList.style.display = 'block';

        books.forEach(b => {
          const div = document.createElement('div');
          div.className = 'gutenberg-item';
          div.innerHTML = `<span>${b.title}</span> <button class="action-btn" style="margin:0; padding:0.25rem 0.5rem">Read</button>`;

          div.querySelector('button')?.addEventListener('click', async () => {
            try {
              setStatus(`Downloading: ${b.title}...`);
              appendEventLog(`Downloading Gutenberg book: ${b.id}`);
              const arrayBuffer = await downloadGutenbergEpub(b.id);
              setStatus(`Parsing: ${b.title}...`);
              const book = await parseEpub(arrayBuffer);
              await saveEpubBufferToDB(arrayBuffer, b.title + '.epub', book.title);
              if (client) {
                await client.loadBook(book);
                await renderBookmarks(client);
              } else {
                setStatus(`Parsed: ${book.title}. (No glasses connected)`);
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              setStatus(`Error loading book: ${msg}`);
              appendEventLog(`Gutenberg error: ${msg}`);
            }
          });

          gutList.appendChild(div);
        });
        setStatus(`Found ${books.length} books. Select one to read.`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(`Failed to fetch Gutenberg list: ${msg}`);
      }
    });
  }
  // Helper to render bookmarks
  async function renderBookmarks(clientToUse: EvenEpubClient) {
    const container = document.getElementById('bookmarks-container');
    if (!container) return;

    try {
      const recent = await getRecentBooksFromDB();
      container.innerHTML = '';

      if (recent.length === 0) {
        container.innerHTML = '<span style="color: #666; font-size: 0.9em;">No saved books yet.</span>';
        return;
      }

      for (const item of recent) {
        const btn = document.createElement('button');
        btn.className = 'bookmark-btn';

        let posText = '';
        const savedPos = await clientToUse.getSavedPosition(item.title);
        if (savedPos) {
          posText = ` <span style="color:#888; font-size: 0.8em;">(Ch ${savedPos.chapterIndex + 1}, Pg ${savedPos.pageIndex + 1})</span>`;
        }

        btn.innerHTML = `${item.title}${posText}`;
        btn.onclick = async () => {
          try {
            setStatus(`Restoring: ${item.title}...`);
            const book = await parseEpub(item.buffer);
            await clientToUse.loadBook(book, true);
            await saveEpubBufferToDB(item.buffer, item.filename, book.title);
            await renderBookmarks(clientToUse);
          } catch (e) {
            console.error(e);
            setStatus('Failed to load bookmark.');
          }
        };
        container.appendChild(btn);
      }
    } catch (e) {
      console.error("Error loading bookmarks:", e);
    }
  }
}

main().catch((e) => {
  setStatus(String(e));
  console.error(e);
});
