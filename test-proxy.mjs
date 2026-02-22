async function testCodetabsEpub() {
  const url = 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent('https://www.gutenberg.org/cache/epub/768/pg768-images.epub');
  try {
    const res = await fetch(url);
    console.log('Codetabs Status:', res.status);
    const buf = await res.arrayBuffer();
    console.log('Size:', buf.byteLength);
  } catch (e) {
    console.log('Error:', e);
  }
}

testCodetabsEpub();
