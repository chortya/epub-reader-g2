/**
 * Build-time provisioning of the sync login (personal builds only), the way
 * BookOrbit's KOReader plugin ships a bookorbit_provision.lua: applied once on
 * first start, then never again - so logging out (or in elsewhere) sticks.
 *
 * scripts/pack-personal.mjs fills VITE_SYNC_PROVISION from PROVISION_FROM
 * (the provisioned plugin zip or its bookorbit_provision.lua). Public builds
 * never carry it.
 */

import {
  BOOKORBIT_KOSYNC_PATH,
  bookOrbitKosyncBase,
  type KosyncSettings,
} from './kosync.ts';

export const PROVISION_APPLIED_KEY = 'epub-sync-provisioned';

export type SyncProvision = {
  serverUrl: string;
  username: string;
  userkey: string;
  /** Identifies this provisioning (BookOrbit's generated_at). */
  id: string;
};

export function parseProvision(raw: string | undefined | null): SyncProvision | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v.serverUrl !== 'string' || typeof v.username !== 'string' || typeof v.userkey !== 'string') return null;
    if (!/^[a-f0-9]{32}$/.test(v.userkey) || !v.username || !bookOrbitKosyncBase(v.serverUrl)) return null;
    return { serverUrl: v.serverUrl, username: v.username, userkey: v.userkey, id: String(v.id ?? v.serverUrl) };
  } catch {
    return null;
  }
}

/**
 * Settings after provisioning, or null when nothing should change: no
 * provisioning, this one was applied before, or the user is already logged in.
 */
export function provisionedSettings(
  current: KosyncSettings,
  provision: SyncProvision | null,
  appliedId: string | null,
): KosyncSettings | null {
  if (!provision || appliedId === provision.id) return null;
  if (current.username && current.userkey) return null; // never replace a login the user made
  const server = bookOrbitKosyncBase(provision.serverUrl);
  if (!server || !server.endsWith(BOOKORBIT_KOSYNC_PATH)) return null;
  return {
    ...current,
    provider: 'bookorbit',
    server,
    username: provision.username,
    userkey: provision.userkey,
    checksum: 'binary',
  };
}
