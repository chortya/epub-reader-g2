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

test('app.json network whitelist lists bare https origins only', () => {
  // Even Hub matches full origins (no wildcards, no paths). Gutenberg and the
  // KOSync servers are reached through the relay (src/relay.ts), whose origin
  // scripts/check-release.mjs requires to be the whitelist at pack time.
  const app = readJson('app.json');
  const networkPerm = (app.permissions ?? []).find((p: any) => p.name === 'network');
  const whitelist: string[] = networkPerm?.whitelist ?? [];
  assert.ok(whitelist.length > 0, 'network permission needs a whitelist');
  for (const entry of whitelist) {
    const url = new URL(entry);
    assert.equal(url.protocol, 'https:', entry);
    assert.equal(url.origin, entry, `${entry} must be a bare origin`);
  }
  assert.ok(!whitelist.includes('https://evenhub.evenrealities.com'), 'unused origin');
  assert.ok(networkPerm.desc.length >= 1 && networkPerm.desc.length <= 300, 'desc must be 1-300 chars');
});

test('app.json listing fields respect Even Hub limits', () => {
  const app = readJson('app.json');
  assert.ok(app.name.length >= 1 && app.name.length <= 20, 'name 1-20 chars');
  assert.ok(!/even/i.test(app.name), 'name must not contain "Even"');
  assert.match(app.package_id, /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/);
  assert.ok(app.tagline.length <= 50, 'tagline <= 50 chars');
  assert.ok(app.description.length <= 2000, 'description <= 2000 chars');
});

test('glasses and companion UI show the app.json name', () => {
  const app = readJson('app.json');
  const client = readFileSync(join(repoRoot, 'src/even-client.ts'), 'utf8');
  const html = readFileSync(join(repoRoot, 'index.html'), 'utf8');
  assert.ok(client.includes(`'${app.name}'`), 'glasses title must match app.json name');
  assert.ok(html.includes(`<h1>${app.name} `), 'companion header must match app.json name');
});

test('pack scripts pin --sdk-ver to the installed SDK', () => {
  const pkg = readJson('package.json');
  const sdk = readJson('node_modules/@evenrealities/even_hub_sdk/package.json').version;
  for (const name of ['pack', 'pack:check', 'pack:dev']) {
    assert.ok(pkg.scripts[name].includes(`--sdk-ver ${sdk}`), `${name} must pass --sdk-ver ${sdk}`);
  }
});
