#!/usr/bin/env node
// Release guard for `npm run pack`: a packaged build must talk to the
// developer's relay (relay/), never to a public CORS proxy, and app.json must
// whitelist exactly the origins the build uses (Even Hub submission rules).
import { readFileSync } from 'node:fs';

const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
const relay = (process.env.VITE_RELAY_ORIGIN ?? '').replace(/\/+$/, '');
const problems = [];

if (!relay) {
  problems.push('VITE_RELAY_ORIGIN is not set (e.g. VITE_RELAY_ORIGIN=https://relay.example.com npm run pack).');
} else {
  try {
    const url = new URL(relay);
    if (url.protocol !== 'https:' || url.origin !== relay) problems.push(`VITE_RELAY_ORIGIN must be a bare https origin, got ${relay}`);
  } catch {
    problems.push(`VITE_RELAY_ORIGIN is not a URL: ${relay}`);
  }
}

const network = (app.permissions ?? []).find((p) => p.name === 'network');
const whitelist = network?.whitelist ?? [];
if (relay && (whitelist.length !== 1 || whitelist[0] !== relay)) {
  problems.push(`app.json network whitelist must be exactly ["${relay}"], got ${JSON.stringify(whitelist)}`);
}
const privacy = readFileSync(new URL('../PRIVACY.md', import.meta.url), 'utf8');
if (privacy.includes('RELAY_ORIGIN')) {
  problems.push('PRIVACY.md still contains the RELAY_ORIGIN placeholder.');
}
if (relay && !privacy.includes(relay)) {
  problems.push(`PRIVACY.md must name the relay origin ${relay}.`);
}
if (relay && /codetabs|corsproxy|allorigins/i.test(relay)) {
  problems.push(`VITE_RELAY_ORIGIN must be your own relay, not a public CORS proxy (${relay}).`);
}
if (app.min_app_version !== '2.2.10') {
  problems.push(`app.json min_app_version should be 2.2.10 (SDK floor), got ${app.min_app_version}`);
}

if (problems.length > 0) {
  console.error('Release check failed:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(`Release check OK (relay ${relay}).`);
