import fs from 'fs';

async function testGutenbergScraping() {
    const url = 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent('https://www.gutenberg.org/browse/scores/top');

    try {
        const response = await fetch(url);
        const text = await response.text();
        fs.writeFileSync('gutenberg.html', text);
        console.log("Wrote " + text.length + " bytes to gutenberg.html");
    } catch (e) {
        console.log('Error:', e);
    }
}
testGutenbergScraping();
