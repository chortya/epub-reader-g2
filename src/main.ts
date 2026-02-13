import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { setStatus, appendEventLog, withTimeout } from './utils';
import { parseEpub } from './epub-parser';
import { EvenEpubClient } from './even-client';

async function main() {
  setStatus('Waiting for Even bridge\u2026');

  let bridge = null;
  try {
    bridge = await withTimeout(waitForEvenAppBridge(), 2500, 'waitForEvenAppBridge');
  } catch (e) {
    console.warn('Bridge not available, switching to browser mode', e);
  }

  let client: EvenEpubClient | null = null;

  if (bridge) {
    client = new EvenEpubClient(bridge);
    await client.init();
    setStatus('Connected. Upload an EPUB file to begin reading.');
    appendEventLog('Bridge connected');
  } else {
    setStatus('Bridge not available (browser mode). Upload an EPUB to test parsing.');
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
