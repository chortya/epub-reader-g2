#!/usr/bin/env node
import { networkInterfaces } from 'node:os';
import { spawnSync } from 'node:child_process';

function detectLanIp() {
  const nets = networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return 'localhost';
}

const ip = detectLanIp();
const path = process.argv[2] ?? '/';

spawnSync('evenhub', ['qr', '--clear'], { stdio: 'ignore' });
const result = spawnSync(
  'evenhub',
  ['qr', '--ip', ip, '--port', '5173', '--path', path, '-e'],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
