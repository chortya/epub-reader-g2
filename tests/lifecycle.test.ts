import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reduceLifecycle,
  PAGED_MENU_ITEMS,
  FLOW_MENU_ITEMS,
} from '../src/lifecycle.ts';

test('active + EXIT backgrounds (pause+flush); re-ENTER restores view', () => {
  let r = reduceLifecycle('active', null, { kind: 'foregroundExit' });
  assert.equal(r.state, 'backgrounded');
  assert.equal(r.effects.pauseAndFlush, true);

  r = reduceLifecycle(r.state, r.pendingMenuAction, { kind: 'foregroundEnter' });
  assert.equal(r.state, 'active');
  assert.equal(r.effects.restoreView, true);
  assert.equal(r.effects.pauseAndFlush, false);
});

test('menu sequence: ENTER (or direct click) → click → EXIT runs the action without pausing', () => {
  // Order A: ENTER first, then click, then EXIT.
  let r = reduceLifecycle('active', null, { kind: 'foregroundEnter' });
  assert.equal(r.state, 'active');
  r = reduceLifecycle(r.state, r.pendingMenuAction, { kind: 'menuClick', itemID: 3 } as never);
  assert.equal(r.state, 'overlayOpen');
  assert.equal(r.pendingMenuAction, 3);
  r = reduceLifecycle(r.state, r.pendingMenuAction, { kind: 'foregroundExit' });
  assert.equal(r.state, 'active');
  assert.equal(r.effects.runPendingMenuAction, true);
  assert.equal(r.effects.pauseAndFlush, false, 'menu dismissal is not a backgrounding');

  // Order B: click arrives before any ENTER (unknown firmware order).
  r = reduceLifecycle('active', null, { kind: 'menuClick', itemID: 1 } as never);
  assert.equal(r.state, 'overlayOpen');
  r = reduceLifecycle(r.state, r.pendingMenuAction, { kind: 'foregroundExit' });
  assert.equal(r.effects.runPendingMenuAction, true);
});

test('menu dismissal without a click delivers nothing', () => {
  const r = reduceLifecycle('overlayOpen', null, { kind: 'foregroundExit' });
  assert.equal(r.state, 'active');
  assert.equal(r.effects.runPendingMenuAction, false);
  assert.equal(r.effects.pauseAndFlush, false);
});

test('duplicate ENTER while overlay open keeps waiting for EXIT', () => {
  let r = reduceLifecycle('active', null, { kind: 'menuClick', itemID: 2 } as never);
  r = reduceLifecycle(r.state, r.pendingMenuAction, { kind: 'foregroundEnter' });
  assert.equal(r.state, 'overlayOpen');
  assert.equal(r.pendingMenuAction, 2);
  const done = reduceLifecycle(r.state, r.pendingMenuAction, { kind: 'foregroundExit' });
  assert.equal(done.effects.runPendingMenuAction, true);
});

test('SYSTEM_EXIT shuts down from any state', () => {
  for (const state of ['active', 'overlayOpen', 'backgrounded'] as const) {
    const r = reduceLifecycle(state, null, { kind: 'systemExit' });
    assert.equal(r.effects.shutdown, true);
  }
});

test('menu payloads: unique non-zero ids, verb labels within 32 UTF-8 bytes', () => {
  const utf8 = (s: string) => new TextEncoder().encode(s).length;
  for (const menu of [PAGED_MENU_ITEMS, FLOW_MENU_ITEMS]) {
    const ids = menu.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'ids unique');
    for (const id of ids) assert.ok(id > 0, 'ids non-zero (protobuf uint32, 0 reserved)');
    for (const item of menu) assert.ok(utf8(item.label) <= 32, `${item.label} exceeds 32 bytes`);
  }
});
