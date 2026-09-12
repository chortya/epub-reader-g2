# AGENTS.md

High-signal, repo-specific guidance for OpenCode sessions. Generic advice omitted.

## What this is
Even G2 ePub Reader — a TypeScript/Vite single-page app that renders EPUB books onto the Even Realities G2 smart-glasses display (576x288 px monochrome). Runs inside the Even Hub WebView; the same build also runs in a browser via a mocked bridge.

## Commands
```bash
npm install            # also runs patch-package (postinstall) — see Gotchas
npm run dev            # Vite on :5173 + prints QR for device loading (backgrounds the server)
npm run dev:serve      # Vite server only, no QR
npm run dev:sim        # Vite + opens evenhub-simulator
npm run dev:serve:sim  # Vite opened at /?simulator=true (browser simulator, no native sim binary)
npm run build          # production build to dist/ — also used as validation, must pass
npm run test           # Node native test runner (NOT Jest/Vitest)
npm run pack           # build + package to epub-reader.ehpk
npm run pack:check     # validate packaging config without writing output
npm run qr / qr:sim    # print QR for the device / simulator path
```

Run a single test file:
```bash
node --experimental-strip-types --test tests/app-json.test.ts
```

Verify any change with `npm run build` then `npm run test`. For integration areas you touched, also run the ad-hoc root scripts (`test-gutenberg.mjs`, `test-proxy.mjs`, `test-scraper.mjs`, `proxy-test.mjs`) via `node <script>.mjs`. UI/gesture changes need manual checks in both `npm run dev` (device) and `npm run dev:sim` (simulator).

## Testing quirks
- Node 22+ required (`--experimental-strip-types`).
- Tests import local `.ts` modules **with the `.ts` extension** (Bundler module resolution).
- `tests/app-json.test.ts` enforces both `app.json.version === package.json.version` AND that `app.json.min_sdk_version` matches the installed Even Hub SDK — bump either and the other must follow.
- Test files (11): `app-json`, `paginator`, `settings-persistence`, `settings-editor`, `continue-reading`, `l3-save-invariant`, `launch-intent`, `gestures-reset`, `layout`, `format-status-line`, `review-regressions`.

## Architecture
`ARCHITECTURE.md` holds the full module map and runtime stack — read it before non-trivial changes. Facts not obvious from filenames:

- **Two entry points** ship in the build: `index.html` (main reader) and `gutenberg.html` (standalone Project Gutenberg browser).
- **Bridge usage is split.** The app talks to the raw Even Hub SDK bridge directly (for custom container layouts: status bars, chapter grid) and does **not** use `EvenHubBridge` from even-toolkit. even-toolkit is used only for glasses-side modules — `action-map` (`mapGlassEvent`), `gestures` (`notifyTextUpdate`, `resetGestureState`), `splash`, `keep-alive`, `text-clean`. No React anywhere.
- **Text pipeline:** raw HTML -> plain-text extraction (epub-parser) -> `cleanForG2()` per line -> language detection -> word-wrap with hyphenation (hypher, 9 languages) -> page splitting (paginator) -> render.
- **Two reading modes:** Paged (swipe nav) and Flow (word-by-word, 120-600 WPM).
- **Glasses-side view flow:** splash -> `pickInitialView()` (launch.ts) -> mainMenu -> bookPicker/library -> reading/flowReading; `settings` + `settingEditor` are reachable from mainMenu.
- **Gutenberg fetch** routes through the `api.codetabs.com` CORS proxy (whitelisted in `app.json` `permissions` alongside `gutenberg.org` and `evenhub.evenrealities.com`).
- **`view='library'` is overloaded.** Both the welcome screen (`showWelcome()`) and the chapter list (`showChapterList()`) set `view='library'`; the distinction is `this.book` being null vs. set. Gesture routing checks `this.book` to disambiguate (even-client.ts:1276).

## G2 platform constraints
- 576x288 px monochrome; max 12 containers/page; max **1** `isEventCapture=1` container/page.
- That event-capture container must cover the full tap area or swipes are lost. This is why the text container always fills the full height even with the "Text height" crop — the crop is rendered by prepending blank leading lines (`getTextLayout()` in constants.ts), not by shrinking the container.
- Startup phase (`createStartUpPageContainer`) is text-only; images only work in `rebuildPageContainer`.
- `textContainerUpgrade` = flicker-free text content swap. `rebuildPageContainer` = layout changes, causes brief flicker. **Always call `notifyTextUpdate()` after `rebuildPageContainer()`**, and call it before arming gesture scroll — order matters (it arms the phantom-suppression window).
- Only **4** SDK gestures exist: `CLICK`, `DOUBLE_CLICK`, `SCROLL_TOP`, `SCROLL_BOTTOM`. No long-press, triple-tap, or temple-swipe. Double-tap = back one level (reading -> chapters -> mainMenu -> exit app).

## Storage & persistence
- IndexedDB keeps the full local library for fast browser/WebView reload. Books use a SHA-256 content identity, so same-named EPUBs cannot overwrite one another; the v3 schema migrates surviving filename-keyed rows.
- Bridge localStorage keeps a serialized base64 fallback of the library so books survive device app restarts. Mutations are serialized to prevent quick uploads from racing.
- Reading positions save on every page turn to bridge localStorage (per bookId AND per title) with browser localStorage as secondary fallback.
- Config (hyphenation, status bar, mode, flow speed, text height) writes to BOTH bridge localStorage (persists across device restarts) AND browser localStorage (warm-start).
- "Continue Reading" resolves by **bookId, never by title alone**. Every save writes three bridge keys together: `epub-book-title`, `epub-last-book-id`, `epub-last-book-filename`. No cloud storage — everything is local-first.

## Gotchas
- `postinstall` runs `patch-package`; `patches/even-toolkit+1.7.2.patch` is applied on install. Upgrading `even-toolkit` may require regenerating the patch.
- Vite is pinned to port 5173 (`strictPort: true`) with `base: './'`; the QR and pack flows assume 5173.
- `app.json` is the Even Hub packaging manifest — regenerate with `npm run init:evenhub` if its schema/permissions change, then re-sync version + `min_sdk_version`.
- `npm run dev`, `qr`, `qr:sim`, and `dev:sim` shell out to the `evenhub` / `evenhub-simulator` CLIs (`@evenrealities/evenhub-cli` / `@evenrealities/evenhub-simulator`). On a machine without Even Hub tooling, use `npm run dev:serve` (plain Vite, no external CLIs).

## Conventions
- TypeScript `strict`, ES2022, Bundler module resolution. 2-space indent, semicolons. No linter/formatter configured — match existing style, keep diffs clean.
- camelCase vars/functions, PascalCase types, kebab-case filenames. Shared constants in `constants.ts`, shared types in `types.ts`.
- Imperative commit messages (e.g. `Fix Gutenberg parser header matching`); conventional prefixes optional, used for releases/chore.
- Load the `/even-dev` skill (`.claude/skills/even-dev/SKILL.md`) for the full G2 SDK reference before touching device-interaction code. The skill now includes the official Even Realities Software Design Guidelines (icon design, font/Unicode support, container rules, UI patterns).

## References
- `ARCHITECTURE.md` — full module map, runtime stack, design decisions.
- `CLAUDE.md` — Claude Code guidance with a detailed architecture block.
- `CHANGELOG.md` — release history; check here for recent behavioral changes.
- `docs/` — design docs per release (e.g. `1.4.0-on-device-settings-and-menu.md`, `1.4.3-selection-box-layout.md`).
- `/even-dev` skill — Even Hub SDK, even-toolkit, G2 display/gesture constraints, packaging, **and official Software Design Guidelines** (icon design, font/Unicode glyph tables, container rules, UI patterns, stacking order).
- [Official Software Design Guidelines (Figma)](https://www.figma.com/design/X82y5uJvqMH95jgOfmV34j/Even-Realities---Software-Design-Guidelines--Public-) — canonical layout, components, interaction patterns, visual standards.
- [Design Guidelines (docs mirror)](https://hub.evenrealities.com/docs/build/design-guidelines) — text version of the Figma file.
- [Display & UI System docs](https://hub.evenrealities.com/docs/build/display) — canvas, containers, text/lists/images, font support.
