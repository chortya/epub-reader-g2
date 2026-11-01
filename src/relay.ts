/**
 * Origin of the developer-operated relay (relay/ in this repo), or null.
 *
 * Even Hub only lets the app reach origins whitelisted in app.json, and the
 * browser engine still enforces CORS. Project Gutenberg and stock KOReader
 * sync servers send no CORS headers, so packaged builds route those requests
 * through the relay. Set VITE_RELAY_ORIGIN at build time and add the same
 * origin to the app.json network whitelist.
 */
export const RELAY_ORIGIN: string | null =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_RELAY_ORIGIN?.replace(/\/+$/, '') || null;
