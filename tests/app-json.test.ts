import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath: string): any {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8'));
}

test('app.json version matches package.json version', () => {
  const app = readJson('app.json');
  const pkg = readJson('package.json');
  assert.equal(
    app.version,
    pkg.version,
    `app.json version (${app.version}) must match package.json version (${pkg.version}) — bump both together when releasing.`,
  );
});

test('app.json entrypoint file exists', () => {
  const app = readJson('app.json');
  assert.ok(app.entrypoint, 'app.json must declare an entrypoint');
  assert.ok(
    existsSync(join(repoRoot, app.entrypoint)),
    `app.json entrypoint "${app.entrypoint}" must exist on disk`,
  );
});

test('app.json supported_languages matches hyphenation imports in epub-parser', () => {
  const app = readJson('app.json');
  const supported: string[] = app.supported_languages ?? [];
  const parserSrc = readFileSync(join(repoRoot, 'src/epub-parser.ts'), 'utf8');

  // Extract every "case 'xx':" from loadHyphenationPatterns, plus the 'en' default.
  const langs = new Set<string>(['en']);
  const caseRe = /case\s+'([a-z]{2})'/g;
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(parserSrc)) !== null) {
    langs.add(m[1]);
  }

  const missing = [...langs].filter((l) => !supported.includes(l));
  assert.deepEqual(
    missing,
    [],
    `app.json supported_languages is missing: ${missing.join(', ')}. Update app.json to declare every language epub-parser can hyphenate.`,
  );
});

test('app.json min_sdk_version matches installed @evenrealities/even_hub_sdk', () => {
  const app = readJson('app.json');
  const sdkPkg = readJson('node_modules/@evenrealities/even_hub_sdk/package.json');
  assert.equal(
    app.min_sdk_version,
    sdkPkg.version,
    `app.json min_sdk_version (${app.min_sdk_version}) should match the installed SDK (${sdkPkg.version}).`,
  );
});

test('app.json network whitelist covers all hardcoded external hosts in src', () => {
  const app = readJson('app.json');
  const networkPerm = (app.permissions ?? []).find((p: any) => p.name === 'network');
  const whitelist: string[] = networkPerm?.whitelist ?? [];

  const hostsToCheck = [
    { host: 'gutenberg.org', src: 'src/gutenberg.ts' },
  ];

  for (const { host, src } of hostsToCheck) {
    const fullPath = join(repoRoot, src);
    if (!existsSync(fullPath)) continue;
    const content = readFileSync(fullPath, 'utf8');
    if (!content.includes(host) && !content.match(new RegExp(host.replace(/\./g, '\\.')))) continue;
    const matched = whitelist.some((entry) => entry.includes(host));
    assert.ok(
      matched,
      `app.json network whitelist must include "${host}" — ${src} makes requests to it.`,
    );
  }
});
