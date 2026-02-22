export interface GutenbergBook {
    id: string;
    title: string;
}

export async function fetchTopGutenbergBooks(): Promise<GutenbergBook[]> {
    const url = 'https://api.allorigins.win/raw?url=' + encodeURIComponent('https://www.gutenberg.org/browse/scores/top');
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error('Failed to fetch from Project Gutenberg');
    }
    const text = await response.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/html');

    const headers = Array.from(doc.querySelectorAll('h2'));
    const targetHeader = headers.find(h => h.textContent && h.textContent.includes('Top 100 EBooks today'));

    if (!targetHeader) return [];

    const list = targetHeader.nextElementSibling;
    if (!list || list.tagName !== 'OL') return [];

    const items = Array.from(list.querySelectorAll('li a'));

    return items.map(a => {
        const href = a.getAttribute('href') || '';
        const match = href.match(/\/ebooks\/(\d+)/);
        // Remove the trailing "(download count)" like "(65460)"
        const titleRaw = a.textContent || '';
        const title = titleRaw.replace(/\(\d+\)$/, '').trim();

        return {
            id: match ? match[1] : '',
            title
        };
    }).filter(b => b.id !== '');
}

export async function downloadGutenbergEpub(id: string): Promise<ArrayBuffer> {
    const epubUrls = [
        `https://www.gutenberg.org/ebooks/${id}.epub.noimages`,
        `https://www.gutenberg.org/ebooks/${id}.epub.images`,
        `https://www.gutenberg.org/files/${id}/${id}-h.zip`, // fallback if they're weird
        `https://www.gutenberg.org/cache/epub/${id}/pg${id}-images.epub`,
        `https://www.gutenberg.org/cache/epub/${id}/pg${id}.epub`
    ];

    for (const directUrl of epubUrls) {
        const url = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(directUrl);
        const res = await fetch(url);
        if (res.ok) {
            return res.arrayBuffer();
        }
    }
    throw new Error('EPUB not found for this book');
}
