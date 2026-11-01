#!/usr/bin/env node
// Personal build: the same app, with a network whitelist for servers only you
// use (e.g. your BookOrbit), for Even Hub Private/Beta testing on your account.
//
//   PERSONAL_ORIGINS=https://bookorbit.example.org npm run pack:personal
//
// Writes build/app.personal.json (app.json + your origins) and packs
// epub-reader-personal.ehpk. The committed app.json is left untouched, and
// the public release check (npm run pack) does not apply. If VITE_RELAY_ORIGIN
// is set, the relay is whitelisted too (Gutenberg); otherwise Gutenberg uses
// the dev proxy, so add https://api.codetabs.com to PERSONAL_ORIGINS if you
// want it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const app = JSON.parse(readFileSync(new URL('app.json', root), 'utf8'));
const sdk = JSON.parse(readFileSync(new URL('node_modules/@evenrealities/even_hub_sdk/package.json', root), 'utf8')).version;

const origins = (process.env.PERSONAL_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
const relay = (process.env.VITE_RELAY_ORIGIN ?? '').replace(/\/+$/, '');
if (relay) origins.push(relay);
if (origins.length === 0) {
  console.error('Set PERSONAL_ORIGINS, e.g. PERSONAL_ORIGINS=https://bookorbit.example.org npm run pack:personal');
  process.exit(1);
}
for (const origin of origins) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    url = null;
  }
  if (!url || url.origin !== origin || (url.protocol !== 'https:' && url.hostname !== 'localhost')) {
    console.error(`Not a bare https origin: ${origin}`);
    process.exit(1);
  }
}

const network = (app.permissions ?? []).find((p) => p.name === 'network');
network.whitelist = [...new Set(origins)];
network.desc = 'Syncs reading progress and downloads books from your own servers: ' + network.whitelist.join(', ');
mkdirSync(new URL('build/', root), { recursive: true });
const manifest = new URL('build/app.personal.json', root);
writeFileSync(manifest, JSON.stringify({ ...app, entrypoint: app.entrypoint }, null, 2) + '\n');

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root });
run('npm', ['run', 'build']);
// evenhub resolves the entrypoint against the project folder, not the manifest's.
run('npx', ['evenhub', 'pack', 'build/app.personal.json', './dist', '--sdk-ver', sdk, '--output', 'epub-reader-personal.ehpk']);
console.log(`Personal build whitelists: ${network.whitelist.join(', ')}`);
