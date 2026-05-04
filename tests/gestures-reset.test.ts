import test from 'node:test';
import assert from 'node:assert/strict';

import {
  notifyTextUpdate,
  resetGestureState,
  shouldIgnoreScroll,
  tryConsumeTap,
} from 'even-toolkit/gestures';

// Background: the toolkit's gesture pipeline keeps timestamp-based debounce
// state (220 ms tap cooldown, 110 ms scroll-suppress-after-tap, 350 ms
// same-direction scroll debounce, 40 ms post-text-update suppression). Before
// resetGestureState existed, every menu rebuild kept that state alive across
// the view boundary, so the user's first tap or first swipe in the new view
// could be silently dropped on device.
//
// The first v1.4.2 attempt also flipped on `bypassNextScrollChecks` and zeroed
// `textUpdateTime` — but on hardware the device fires a phantom SCROLL right
// after `rebuildPageContainer`, and that bypass let the phantom through.
// The phantom navigated in some direction and the user's real swipe (or its
// own follow-up phantom) then snapped the highlight back, so the menu visibly
// jumped and stayed in place. The current contract is narrower: clear stale
// tap/scroll history, but leave the post-rebuild textUpdate suppression
// window alone — that window is what swallows the phantom.

test('resetGestureState: tap immediately after a recent tap is honored', () => {
  resetGestureState();
  assert.equal(tryConsumeTap('tap'), true);
  // Without a reset, a second tap within the 220 ms cooldown would be dropped.
  resetGestureState();
  assert.equal(tryConsumeTap('tap'), true);
});

test('resetGestureState: preserves the post-rebuild textUpdate window', () => {
  // The window is what suppresses the phantom SCROLL the device fires after
  // rebuildPageContainer. resetGestureState must NOT clear it — otherwise the
  // phantom would land and snap the menu highlight back.
  resetGestureState();
  notifyTextUpdate();
  resetGestureState();
  assert.equal(
    shouldIgnoreScroll('next'),
    true,
    'phantom scroll within the 40 ms window must still be suppressed after reset',
  );
});

test('resetGestureState: user swipe lands once the textUpdate window expires', () => {
  // Real-world sequence after a menu rebuild: notifyTextUpdate arms the 40 ms
  // window, resetGestureState clears stale cross-view history, the device's
  // phantom SCROLL is suppressed inside the window, and the user's deliberate
  // swipe (which arrives later) is allowed.
  resetGestureState();
  notifyTextUpdate();
  resetGestureState();
  // Phantom inside the window is suppressed.
  assert.equal(shouldIgnoreScroll('next'), true);
  // Spin briefly past the 40 ms suppression window.
  const start = Date.now();
  while (Date.now() - start < 90) { /* wait out the window */ }
  // User's real swipe lands — no lingering tap/scroll debounce holds it back.
  assert.equal(shouldIgnoreScroll('next'), false);
});

test('resetGestureState: tap then post-window scroll both succeed', () => {
  // User taps a menu item; rebuildSlots fires notifyTextUpdate + reset; user
  // then swipes after the suppression window expires.
  resetGestureState();
  assert.equal(tryConsumeTap('tap'), true);
  notifyTextUpdate();
  resetGestureState();
  const start = Date.now();
  while (Date.now() - start < 90) { /* wait out the window */ }
  assert.equal(shouldIgnoreScroll('next'), false);
  assert.equal(tryConsumeTap('tap'), true);
});
