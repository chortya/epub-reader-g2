/**
 * Foreground lifecycle reducer (Phase 3, plan §3.1).
 *
 * The native contextual menu makes the FOREGROUND_ENTER/EXIT pair ambiguous:
 * opening the menu fires ENTER, dismissing fires EXIT — the same events the
 * host uses for app background/foreground. The old handler treated every EXIT
 * as "app backgrounded" (pausing Flow, flushing) and every ENTER as "refresh
 * view" — wrong for the menu sequence ENTER → menuItemClickEvent → EXIT, and
 * unknown event orders had to be tolerated.
 *
 * States:
 *   active       — app in the foreground, no OS overlay open
 *   overlayOpen  — the native contextual menu is open (entered via ENTER or a
 *                  direct menu click); EXIT only closes the overlay
 *   backgrounded — app sent to background by the host
 *
 * A menu click while active (no ENTER observed first) still opens the overlay
 * state — event order between ENTER and the click is not guaranteed.
 */

export type LifecycleState = 'active' | 'overlayOpen' | 'backgrounded';

export type LifecycleEvent =
  | { kind: 'foregroundEnter' }
  | { kind: 'foregroundExit' }
  | { kind: 'menuClick' }
  | { kind: 'systemExit' };

export interface LifecycleEffects {
  /** Pause Flow + flush the position (real app-background, or overlay actions that require it). */
  pauseAndFlush: boolean;
  /** Restore the current view (re-entry to the foreground). */
  restoreView: boolean;
  /** A menu click is pending execution — run it after this transition settles. */
  runPendingMenuAction: boolean;
  /** SYSTEM_EXIT: tear down and stop. */
  shutdown: boolean;
}

export interface LifecycleResult {
  state: LifecycleState;
  /** Set while in overlayOpen: the itemID awaiting the overlay's EXIT. */
  pendingMenuAction: number | null;
  effects: LifecycleEffects;
}

const IDLE_EFFECTS: LifecycleEffects = {
  pauseAndFlush: false,
  restoreView: false,
  runPendingMenuAction: false,
  shutdown: false,
};

export function reduceLifecycle(
  state: LifecycleState,
  pendingMenuAction: number | null,
  event: LifecycleEvent,
): LifecycleResult {
  switch (event.kind) {
    case 'systemExit':
      return {
        state: 'active', // the app is going away; state value is irrelevant
        pendingMenuAction: null,
        effects: { ...IDLE_EFFECTS, shutdown: true },
      };

    case 'foregroundEnter': {
      if (state === 'backgrounded') {
        return { state: 'active', pendingMenuAction: null, effects: { ...IDLE_EFFECTS, restoreView: true } };
      }
      if (state === 'overlayOpen') {
        // Spurious duplicate ENTER while the menu is open — keep waiting for EXIT.
        return { state: 'overlayOpen', pendingMenuAction, effects: IDLE_EFFECTS };
      }
      // active + ENTER: host refresh nudge (pre-menu behavior) — restore view.
      return { state: 'active', pendingMenuAction: null, effects: { ...IDLE_EFFECTS, restoreView: true } };
    }

    case 'foregroundExit': {
      if (state === 'overlayOpen') {
        // Menu dismissed (possibly after a click). Deliver the pending action
        // now; do NOT pause/flush — the app never left the foreground.
        return {
          state: 'active',
          pendingMenuAction: null,
          effects: { ...IDLE_EFFECTS, runPendingMenuAction: pendingMenuAction !== null },
        };
      }
      // active|backgrounded + EXIT → real backgrounding.
      return { state: 'backgrounded', pendingMenuAction: null, effects: { ...IDLE_EFFECTS, pauseAndFlush: true } };
    }

    case 'menuClick': {
      // Register the click; it executes after the overlay's EXIT arrives.
      // (If one never arrives — firmware quirk — the next ENTER or a tap
      // dispatch drops the stale action via the view guard in the client.)
      return { state: 'overlayOpen', pendingMenuAction: event.itemID, effects: IDLE_EFFECTS };
    }
  }
}

// --- Native contextual menu payloads (plan §3.1) ---

export const MENU_CONTENTS = 1;
export const MENU_SWITCH_MODE = 2;
export const MENU_SET_BOOKMARK = 3;
export const MENU_GO_BOOKMARK = 4;
export const MENU_MAIN_MENU = 5;
export const MENU_FASTER = 6;
export const MENU_SLOWER = 7;

/** Static verb labels (≤32 UTF-8 bytes; labels never update without re-declare). */
export const PAGED_MENU_ITEMS: Array<{ id: number; label: string }> = [
  { id: MENU_CONTENTS, label: 'Contents' },
  { id: MENU_SWITCH_MODE, label: 'Switch to Flow' },
  { id: MENU_SET_BOOKMARK, label: 'Set bookmark' },
  { id: MENU_GO_BOOKMARK, label: 'Go to bookmark' },
  { id: MENU_MAIN_MENU, label: 'Main menu' },
];

export const FLOW_MENU_ITEMS: Array<{ id: number; label: string }> = [
  { id: MENU_FASTER, label: 'Faster' },
  { id: MENU_SLOWER, label: 'Slower' },
  { id: MENU_CONTENTS, label: 'Contents' },
  { id: MENU_SWITCH_MODE, label: 'Switch to Paged' },
  { id: MENU_SET_BOOKMARK, label: 'Set bookmark' },
  { id: MENU_GO_BOOKMARK, label: 'Go to bookmark' },
  { id: MENU_MAIN_MENU, label: 'Main menu' },
];
