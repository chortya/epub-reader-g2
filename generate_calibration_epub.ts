
import JSZip from 'jszip';
import fs from 'fs';

async function createCalibrationEpub() {
    const zip = new JSZip();

    zip.file('mimetype', 'application/epub+zip');

    zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

    const chapters = [
        {
            id: 'width',
            title: 'Width Calibration',
            content: `
          <h1>Width Calibration</h1>
          <p>50 chars: 12345678901234567890123456789012345678901234567890</p>
          <p>55 chars: 1234567890123456789012345678901234567890123456789012345</p>
          <p>58 chars: 1234567890123456789012345678901234567890123456789012345678</p>
          <p>60 chars: 123456789012345678901234567890123456789012345678901234567890</p>
          <p>62 chars: 12345678901234567890123456789012345678901234567890123456789012</p>
          <p>65 chars: 12345678901234567890123456789012345678901234567890123456789012345</p>
          <p>70 chars: 1234567890123456789012345678901234567890123456789012345678901234567890</p>
          <p>Ruler (1-80):</p>
          <p>12345678901234567890123456789012345678901234567890123456789012345678901234567890</p>
        `
        },
        {
            id: 'height',
            title: 'Height Calibration',
            content: `
          <h1>Height Calibration</h1>
          <p>Line 1</p><p>Line 2</p><p>Line 3</p><p>Line 4</p><p>Line 5</p>
          <p>Line 6</p><p>Line 7</p><p>Line 8</p><p>Line 9</p><p>Line 10</p>
          <p>Line 11</p><p>Line 12</p><p>Line 13</p><p>Line 14</p><p>Line 15</p>
          <p>Line 16</p><p>Line 17</p><p>Line 18</p><p>Line 19</p><p>Line 20</p>
        `
        },
        {
            id: 'en',
            title: 'English Hyphenation',
            content: `
          <h1>English</h1>
          <p>The incomprehensibilities of the situation were overwhelming.</p>
          <p>Characterization is an essential part of storytelling.</p>
          <p>Antidisestablishmentarianism is a very long word.</p>
          <p>Usually, long words should be hyphenated automatically by the system to ensure they fit within the screen width without leaving large gaps.</p>
        `
        },
        {
            id: 'de',
            title: 'German Hyphenation',
            content: `
          <h1>German (Deutsch)</h1>
          <p>Donaudampfschifffahrtsgesellschaftskapitän.</p>
          <p>Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz.</p>
          <p>Rechtsschutzversicherungsgesellschaften sind oft kompliziert.</p>
          <p>Die Hyphenierung sollte auch bei sehr langen zusammengesetzten Wörtern funktionieren.</p>
        `
        },
        {
            id: 'ru',
            title: 'Russian Hyphenation',
            content: `
          <h1>Russian (Русский)</h1>
          <p>Превысоkomnogo rassmotrinstvo (fake long word for test).</p>
          <p>Сельскохозяйственная техника очень важна.</p>
          <p>Рентгеноэлектрокардиографический метод исследования.</p>
          <p>Частнопредпринимательская деятельность регулируется законом.</p>
        `
        },
        {
            id: 'uk',
            title: 'Ukrainian Hyphenation',
            content: `
          <h1>Ukrainian (Українська)</h1>
          <p>Ніколуніверсалізм (fake).</p>
          <p>Відеоспостереження за об'єктами.</p>
          <p>Електроенергетика України розвивається.</p>
          <p>Дніпропетровська область (historical name for test).</p>
        `
        }
    ];

    let manifestItems = '';
    let spineItems = '';
    let tocPoints = '';

    chapters.forEach((ch, i) => {
        const filename = `OEBPS/${ch.id}.html`;
        zip.file(filename, `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${ch.title}</title></head>
<body>${ch.content}</body>
</html>`);

        manifestItems += `<item id="${ch.id}" href="${ch.id}.html" media-type="application/xhtml+xml"/>\n`;
        spineItems += `<itemref idref="${ch.id}"/>\n`;
        tocPoints += `
    <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${ch.title}</text></navLabel>
      <content src="${ch.id}.html"/>
    </navPoint>`;
    });

    zip.file('OEBPS/content.opf', `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Calibration & Hyphenation Test</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    ${spineItems}
  </spine>
</package>`);

    zip.file('OEBPS/toc.ncx', `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:calib"/></head>
  <docTitle><text>Calibration Book</text></docTitle>
  <navMap>
    ${tocPoints}
  </navMap>
</ncx>`);

    const content = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync('calibration.epub', content);
    console.log('Created calibration.epub');
}

createCalibrationEpub();
