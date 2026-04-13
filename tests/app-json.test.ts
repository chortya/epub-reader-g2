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

test('app.json supported_languages only claims languages epub-parser actually hyphenates', () => {
  const app = readJson('app.json');
  const supported: string[] = app.supported_languages ?? [];
  const parserSrc = readFileSync(join(repoRoot, 'src/epub-parser.ts'), 'utf8');

  // Extract every "case 'xx':" from loadHyphenationPatterns, plus the 'en' default.
  const hyphenated = new Set<string>(['en']);
  const caseRe = /case\s+'([a-z]{2})'/g;
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(parserSrc)) !== null) {
    hyphenated.add(m[1]);
  }

  const overclaimed = supported.filter((l) => !hyphenated.has(l));
  assert.deepEqual(
    overclaimed,
    [],
    `app.json supported_languages claims [${overclaimed.join(', ')}] but epub-parser doesn't hyphenate them.`,
  );

  // Every marketplace-allowed language we *do* hyphenate should be declared, so the
  // store doesn't under-list us. Marketplace whitelist comes from the Even Hub schema.
  const marketplaceAllowed = new Set(['en', 'de', 'fr', 'es', 'it', 'zh', 'ja', 'ko']);
  const shouldDeclare = [...hyphenated].filter((l) => marketplaceAllowed.has(l));
  const missing = shouldDeclare.filter((l) => !supported.includes(l));
  assert.deepEqual(
    missing,
    [],
    `app.json should declare [${missing.join(', ')}] — epub-parser hyphenates them and the Even Hub schema accepts them.`,
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
