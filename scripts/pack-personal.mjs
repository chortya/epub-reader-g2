#!/usr/bin/env node
// Personal build: the same app, with a network whitelist for servers only you
// use (e.g. your BookOrbit), for Even Hub Private/Beta testing on your account.
//
//   PERSONAL_ORIGINS=https://bookorbit.example.org npm run pack:personal
//
// Optional PROVISION_FROM=<BookOrbit's provisioned KOReader plugin zip, or
// its bookorbit_provision.lua>: the build then carries that login (server,
// username, MD5 key) and applies it once on first start - no typing on the
// phone. The key is passed to Vite through the environment only; it ends up
// in the private package, never in git. Its server is whitelisted too.
//
// Optional PERSONAL_VERSION=1.6.1: version of the personal package (Even Hub
// wants a higher version for each new upload of the same app).
//
// Writes build/app.personal.json (app.json + your origins) and packs
// epub-reader-personal.ehpk. The committed app.json is left untouched, and
// the public release check (npm run pack) does not apply. If VITE_RELAY_ORIGIN
// is set, the relay is whitelisted too (Gutenberg); otherwise Gutenberg uses
// the dev proxy, so add https://api.codetabs.com to PERSONAL_ORIGINS if you
// want it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';

const root = new URL('..', import.meta.url);
const app = JSON.parse(readFileSync(new URL('app.json', root), 'utf8'));
const sdk = JSON.parse(readFileSync(new URL('node_modules/@evenrealities/even_hub_sdk/package.json', root), 'utf8')).version;

const origins = (process.env.PERSONAL_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);

/** server_url/username/userkey/generated_at from a bookorbit_provision.lua. */
function parseProvisionLua(lua) {
  const field = (name) => new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(lua)?.[1];
  const serverUrl = field('server_url');
  const username = field('username');
  const userkey = field('userkey');
  if (!serverUrl || !username || !/^[a-f0-9]{32}$/.test(userkey ?? '')) {
    throw new Error('PROVISION_FROM has no usable server_url/username/userkey');
  }
  return { serverUrl: serverUrl.replace(/\/+$/, ''), username, userkey, id: field('generated_at') ?? serverUrl };
}

let provision = null;
if (process.env.PROVISION_FROM) {
  const path = process.env.PROVISION_FROM;
  let lua;
  if (/\.zip$/i.test(path)) {
    const zip = await JSZip.loadAsync(readFileSync(path));
    const entry = Object.values(zip.files).find((f) => !f.dir && f.name.endsWith('bookorbit_provision.lua'));
    if (!entry) throw new Error(`${path} has no bookorbit_provision.lua (download a provisioned plugin from BookOrbit)`);
    lua = await entry.async('string');
  } else {
    lua = readFileSync(path, 'utf8');
  }
  provision = parseProvisionLua(lua);
  origins.push(new URL(provision.serverUrl).origin);
  console.log(`Provisioning login "${provision.username}" for ${provision.serverUrl} (key not shown).`);
}
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
  const ok = url && url.origin === origin
    && (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost'));
  if (!ok) {
    console.error(`Not a bare https origin: ${origin}`);
    process.exit(1);
  }
}

const network = (app.permissions ?? []).find((p) => p.name === 'network');
network.whitelist = [...new Set(origins)];
// Even Hub limits the description to 300 characters.
const desc = 'Syncs reading progress and downloads books from your own servers: ' + network.whitelist.join(', ');
network.desc = desc.length <= 300 ? desc : 'Syncs reading progress and downloads books from your own servers (see the whitelist).';
const personalVersion = process.env.PERSONAL_VERSION?.trim();
if (personalVersion) {
  if (!/^\d+\.\d+\.\d+$/.test(personalVersion)) {
    console.error(`PERSONAL_VERSION must look like 1.6.1, got: ${personalVersion}`);
    process.exit(1);
  }
  app.version = personalVersion;
}

mkdirSync(new URL('build/', root), { recursive: true });
const manifest = new URL('build/app.personal.json', root);
writeFileSync(manifest, JSON.stringify({ ...app, entrypoint: app.entrypoint }, null, 2) + '\n');

const run = (cmd, args, env = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, env: { ...process.env, ...env } });
// Personal builds may reach the user's own servers directly (BookOrbit).
run('npm', ['run', 'build'], {
  VITE_PERSONAL_BUILD: '1',
  ...(provision ? { VITE_SYNC_PROVISION: JSON.stringify(provision) } : {}),
});
// evenhub resolves the entrypoint against the project folder, not the manifest's.
run('npx', ['evenhub', 'pack', 'build/app.personal.json', './dist', '--sdk-ver', sdk, '--output', 'epub-reader-personal.ehpk']);
console.log(`Personal build whitelists: ${network.whitelist.join(', ')}`);
