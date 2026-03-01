# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the TypeScript application code:
  - `main.ts` bootstraps UI, bridge/simulator mode, uploads, and Gutenberg flows.
  - `even-client.ts` handles Even Hub device interaction.
  - `epub-parser.ts`, `paginator.ts`, and `gutenberg.ts` cover parsing/layout/content fetching.
  - `db.ts` stores recent books and reading state (IndexedDB).
- `public/` stores static assets served by Vite (sample EPUB/logo files).
- Root-level `test-*.mjs` and `proxy-test.mjs` are ad hoc integration/debug scripts.
- Build output goes to `dist/` and packaged artifact to `epub-reader.ehpk`.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: run Vite on `:5173` and print QR for device loading.
- `npm run dev:sim`: run local simulator workflow.
- `npm run build`: production build into `dist/`.
- `npm run preview`: preview built output locally.
- `npm run pack`: build and package with Even Hub (`epub-reader.ehpk`).
- `npm run pack:check`: validate packaging config without writing output.
- Example ad hoc checks: `node test-gutenberg.mjs`, `node test-proxy.mjs`.

## Coding Style & Naming Conventions
- Language: TypeScript (`strict` mode via `tsconfig.json`).
- Use 2-space indentation and semicolons, consistent with existing `src/*.ts`.
- Use `camelCase` for variables/functions, `PascalCase` for classes/types, kebab-case for filenames where already established (for example `even-client.ts`).
- Keep modules focused; place shared constants/types in `constants.ts` and `types.ts`.
- No dedicated formatter/linter is configured; match existing style and keep diffs clean.

## Testing Guidelines
- There is no formal test framework configured yet (no Jest/Vitest script).
- Validate changes with:
  - `npm run build` (must pass).
  - relevant node scripts (`test-*.mjs`) for integration areas you changed.
  - manual verification in device mode (`npm run dev`) and simulator mode (`npm run dev:sim`) for UI/gesture behavior.

## Commit & Pull Request Guidelines
- Prefer concise, imperative commit messages (for example `Fix Gutenberg parser header matching`).
- Conventional prefixes are optional but used for releases/chore work (for example `chore: release 0.8.0 ...`).
- PRs should include:
  - a short problem/solution summary,
  - linked issue (if any),
  - test/verification steps run,
  - screenshots or short recordings for UI changes.
