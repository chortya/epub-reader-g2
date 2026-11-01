/**
 * Origin of the developer-operated relay (relay/ in this repo), or null.
 *
 * Even Hub only lets the app reach origins whitelisted in app.json, and the
 * browser engine still enforces CORS. Project Gutenberg and stock KOReader
 * sync servers send no CORS headers, so packaged builds route those requests
 * through the relay. Set VITE_RELAY_ORIGIN at build time and add the same
 * origin to the app.json network whitelist.
 */
export const RELAY_ORIGIN: string | null = import.meta.env?.VITE_RELAY_ORIGIN?.replace(/\/+$/, '') || null;

/**
 * BookOrbit is reached directly (each user's own server), which only works
 * where that origin can be whitelisted: personal builds (pack:personal) and
 * dev builds without a relay. Public relay builds don't offer it.
 */
export const BOOKORBIT_AVAILABLE: boolean = !RELAY_ORIGIN || import.meta.env?.VITE_PERSONAL_BUILD === '1';
