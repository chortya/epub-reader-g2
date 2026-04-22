import test from 'node:test';
import assert from 'node:assert/strict';

import { pickInitialView } from '../src/launch.ts';
import type { CachedBookMeta } from '../src/types.ts';

const lastBook: CachedBookMeta = {
  bookId: 'abc',
  title: 'A Book',
  filename: 'a-book.epub',
  uploadedAt: 100,
};

test("pickInitialView: glassesMenu + resolvable + paged → 'reading'", () => {
  assert.equal(pickInitialView('glassesMenu', lastBook, 'paged'), 'reading');
});

test("pickInitialView: glassesMenu + resolvable + flow → 'flowReading'", () => {
  assert.equal(pickInitialView('glassesMenu', lastBook, 'flow'), 'flowReading');
});

test("pickInitialView: glassesMenu + unresolvable → 'mainMenu'", () => {
  assert.equal(pickInitialView('glassesMenu', null, 'paged'), 'mainMenu');
  assert.equal(pickInitialView('glassesMenu', null, 'flow'), 'mainMenu');
});

test("pickInitialView: appMenu always → 'mainMenu' regardless of lastBook", () => {
  // Per design §3.1a decision Q7 → A: appMenu never bypasses mainMenu even
  // when a last book exists.
  assert.equal(pickInitialView('appMenu', lastBook, 'paged'), 'mainMenu');
  assert.equal(pickInitialView('appMenu', null, 'flow'), 'mainMenu');
});

test("pickInitialView: null intent (SDK callback not fired yet) → 'mainMenu' fallback", () => {
  // Safe default when launchSource hasn't resolved by splash-end. Prevents
  // race-then-overlay UX from v1.3.1.
  assert.equal(pickInitialView(null, lastBook, 'paged'), 'mainMenu');
  assert.equal(pickInitialView(null, null, 'paged'), 'mainMenu');
});
