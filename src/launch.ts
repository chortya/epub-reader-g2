import type { CachedBookMeta } from './types.ts';
import type { AppConfig } from './constants.ts';

/**
 * Source of the app launch, as reported by the Even Hub host.
 * - 'appMenu': user opened the reader from the phone app list. Always shows mainMenu.
 * - 'glassesMenu': user opened it from the glasses-side quick-launch. Bypasses
 *    mainMenu and resumes the last book directly if resolvable.
 * - null: the SDK has not yet reported a launch source by the time the splash
 *    finishes. Safe default: show mainMenu.
 *
 * See design §3.1a and decision Q7 → A.
 */
export type LaunchIntent = 'appMenu' | 'glassesMenu' | null;

export type InitialView = 'mainMenu' | 'reading' | 'flowReading';

/**
 * Decide the first view to render after splash, given the launch intent and
 * whether a last-opened book is resumable.
 *
 * The function is deliberately pure (no bridge, no side effects) so it can be
 * unit-tested without a DOM or SDK stub. Callers are expected to have already
 * resolved `lastBook` via resolveLastBook() before calling.
 */
export function pickInitialView(
  intent: LaunchIntent,
  lastBook: CachedBookMeta | null,
  readingMode: AppConfig['readingMode'],
): InitialView {
  if (intent === 'glassesMenu' && lastBook !== null) {
    return readingMode === 'flow' ? 'flowReading' : 'reading';
  }
  return 'mainMenu';
}
