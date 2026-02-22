async function testFetch() {
  const id = '768';
  const url = `https://www.gutenberg.org/ebooks/${id}.epub.images`;
  try {
     const res = await fetch('https://corsproxy.io/?' + encodeURIComponent(url));
     console.log('Status:', res.status);
     console.log('Content-Type:', res.headers.get('content-type'));
     if (res.ok) {
        console.log('Size:', (await res.arrayBuffer()).byteLength);
     } else {
        console.log(await res.text())
     }
  } catch(e) {
     console.error(e);
  }
}
testFetch();
