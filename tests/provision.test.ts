import test from 'node:test';
import assert from 'node:assert/strict';

import { parseProvision, provisionedSettings } from '../src/provision.ts';
import { defaultKosyncSettings } from '../src/kosync.ts';

const RAW = JSON.stringify({ serverUrl: 'https://bookorbit.example.org', username: 'koreader', userkey: 'a'.repeat(32), id: 'gen-1' });

test('provisioning parses strictly', () => {
  assert.deepEqual(parseProvision(RAW), { serverUrl: 'https://bookorbit.example.org', username: 'koreader', userkey: 'a'.repeat(32), id: 'gen-1' });
  assert.equal(parseProvision(undefined), null);
  assert.equal(parseProvision('{"serverUrl":"http://evil.example","username":"u","userkey":"' + 'a'.repeat(32) + '"}'), null, 'https only');
  assert.equal(parseProvision('{"serverUrl":"https://x.org","username":"u","userkey":"not-md5"}'), null);
});

test('provisioning applies once, as BookOrbit, and never replaces a user login', () => {
  const p = parseProvision(RAW)!;
  const fresh = defaultKosyncSettings();
  const next = provisionedSettings(fresh, p, null)!;
  assert.equal(next.provider, 'bookorbit');
  assert.equal(next.server, 'https://bookorbit.example.org/api/v1/koreader');
  assert.equal(next.username, 'koreader');
  assert.equal(next.deviceId, fresh.deviceId);
  // Already applied (user may have logged out since): leave it alone.
  assert.equal(provisionedSettings(fresh, p, 'gen-1'), null);
  // A newer provisioning applies again - but not over an existing login.
  assert.ok(provisionedSettings(fresh, { ...p, id: 'gen-2' }, 'gen-1'));
  assert.equal(provisionedSettings({ ...fresh, username: 'me', userkey: 'b'.repeat(32) }, p, null), null);
});
