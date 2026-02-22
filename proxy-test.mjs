const urls = [
  'https://corsproxy.io/?' + encodeURIComponent('https://www.gutenberg.org/cache/epub/768/pg768-images.epub'),
  'https://api.allorigins.win/raw?url=' + encodeURIComponent('https://www.gutenberg.org/cache/epub/768/pg768-images.epub'),
];

async function testUrl(url) {
  try {
     console.log('Testing:', url.substring(0, 50));
     const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
     console.log('Status:', res.status);
     console.log('Content-Type:', res.headers.get('content-type'));
     if (res.ok) {
        console.log('Size:', (await res.arrayBuffer()).byteLength);
     } else {
        console.log('Body:', (await res.text()).substring(0, 100));
     }
  } catch (e) {
     console.error('Error:', e.message);
  }
}

for (const u of urls) await testUrl(u);
