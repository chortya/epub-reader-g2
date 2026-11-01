import { RELAY_ORIGIN } from './relay';

export interface GutenbergBook {
    id: string;
    title: string;
}

// Dev-only fallback when no relay is configured. Packaged builds must set
// VITE_RELAY_ORIGIN: public CORS proxies are unreliable and not traceable to
// the developer (Even Hub submission rules).
// Written against import.meta.env directly so Vite inlines the value and the
// bundler drops the proxy URL from relay builds.
const DEV_CORS_PROXY = import.meta.env.VITE_RELAY_ORIGIN ? '' : 'https://api.codetabs.com/v1/proxy?quest=';

function devProxied(url: string): string {
    return DEV_CORS_PROXY + encodeURIComponent(url);
}

export async function fetchTopGutenbergBooks(): Promise<GutenbergBook[]> {
    const url = RELAY_ORIGIN
        ? `${RELAY_ORIGIN}/gutenberg/top`
        : devProxied('https://www.gutenberg.org/browse/scores/top');
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error('Failed to fetch from Project Gutenberg');
    }
    const text = await response.text();
    return parseTopBooksHtml(text);
}

export function parseTopBooksHtml(html: string): GutenbergBook[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const headers = Array.from(doc.querySelectorAll('h2'));
    const targetHeader = headers.find(h => h.id === 'books-last1' || (h.textContent && h.textContent.includes('Top 100 EBooks yesterday')));

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
    if (!/^\d+$/.test(id)) throw new Error('Invalid Gutenberg book id');
    if (RELAY_ORIGIN) {
        const res = await fetch(`${RELAY_ORIGIN}/gutenberg/epub/${id}`);
        if (res.ok) return res.arrayBuffer();
        throw new Error(res.status === 404 ? 'EPUB not found for this book' : `Download failed (HTTP ${res.status})`);
    }

    const epubUrls = [
        `https://www.gutenberg.org/cache/epub/${id}/pg${id}.epub`,
        `https://www.gutenberg.org/cache/epub/${id}/pg${id}-images-3.epub`,
        `https://www.gutenberg.org/cache/epub/${id}/pg${id}-images.epub`,
    ];
    for (const directUrl of epubUrls) {
        const res = await fetch(devProxied(directUrl));
        if (res.ok) {
            return res.arrayBuffer();
        }
    }
    throw new Error('EPUB not found for this book');
}
