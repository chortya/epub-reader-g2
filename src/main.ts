import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { setStatus, appendEventLog, withTimeout } from './utils';
import { parseEpub } from './epub-parser';
import { EvenEpubClient } from './even-client';
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
  } else {
    // Should not happen with MockBridge
    setStatus('Error: Could not initialize bridge.');
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

        appendEventLog(
          `Parsed: "${book.title}" with ${book.chapters.length} chapters`,
        );

        if (client) {
          await client.loadBook(book);
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
}

main().catch((e) => {
  setStatus(String(e));
  console.error(e);
});
