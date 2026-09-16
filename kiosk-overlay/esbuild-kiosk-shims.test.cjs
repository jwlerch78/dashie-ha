// kiosk-overlay/esbuild-kiosk-shims.test.cjs
//
// The kiosk shell bundle must carry no Google API key (the kiosk never shows a map). Thread A
// s199, O -3d approved `A-status s199 cont.8`.
//
// The defect this exists for: the strip matched config.js by FOLDER NAME (`/dashieapp_staging/config.js`),
// so a build from a worktree under any other name silently bundled both Maps keys (vc239,
// staging 8b6f919bf: 2 in kiosk-shell, 0 the commit before). Every leg below builds a throwaway
// tree whose repo folder is NOT called dashieapp_staging.
//
// 🔴 No key value is ever printed: the fixture keys are assembled at runtime, and every assertion
// reports a COUNT. A failing leg must not paste a key into a terminal or a CI log.
//
// Run: npm run test:kiosk-shims   (node --test; the plugin is CommonJS and esbuild is a Node dependency here)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const esbuild = require(path.join(__dirname, 'node_modules', 'esbuild'));
const { countGoogleKeys, refuseKeyedOutputs } = require('./key-guard');

// Real-shape fake keys: "AIza" + 35 characters from [0-9A-Za-z_-]. Built here, never written as one literal.
const PREFIX = ['A', 'I', 'z', 'a'].join('');
const FAKE_WEB = PREFIX + 'webFixture0'.repeat(4).slice(0, 35);
const FAKE_IOS = PREFIX + 'iosFixture1'.repeat(4).slice(0, 35);
const NEAR_MISS = PREFIX + 'shortFixture'.repeat(3).slice(0, 34);

/** A throwaway repo: <tmp>/<repoName>/{config.js, kiosk-overlay/{esbuild-kiosk-shims.js, js/…}}. */
function makeTree({ repoName = 'not-the-repo-name', iosKey = true, subConfig = false } = {}) {
  const repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-shims-')), repoName);
  const kiosk = path.join(repo, 'kiosk-overlay');
  fs.mkdirSync(path.join(kiosk, 'js', 'sub'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'esbuild-kiosk-shims.js'), path.join(kiosk, 'esbuild-kiosk-shims.js'));

  const config = [
    `export const GOOGLE_MAPS_WEB_API_KEY = '${FAKE_WEB}';`,
    iosKey ? `export const GOOGLE_MAPS_IOS_API_KEY = '${FAKE_IOS}';` : '',
    `export const OTHER_SETTING = 42;`,
  ].join('\n');
  fs.writeFileSync(path.join(repo, 'config.js'), config);
  fs.writeFileSync(path.join(kiosk, 'js', 'logger-config.js'), `export const LOG_LEVEL = 'info';\n`);
  fs.writeFileSync(path.join(kiosk, 'js', 'sub', 'config.js'), `export const SUB_KEY = '${FAKE_WEB}';\n`);

  const imports = [
    `import * as root from '@dashie/config';`,
    `import { LOG_LEVEL } from './logger-config.js';`,
    subConfig ? `import { SUB_KEY } from './sub/config.js';` : '',
    `globalThis.__probe = [root, LOG_LEVEL${subConfig ? ', SUB_KEY' : ''}];`,
  ].join('\n');
  fs.writeFileSync(path.join(kiosk, 'js', 'entry.js'), imports);
  return { repo, kiosk };
}

/** Bundle the tree's entry exactly the way build.js aliases `@dashie/config`. Returns the output text. */
async function bundle(tree, { withPlugin = true } = {}) {
  const plugins = [];
  if (withPlugin) {
    delete require.cache[path.join(tree.kiosk, 'esbuild-kiosk-shims.js')];
    plugins.push(require(path.join(tree.kiosk, 'esbuild-kiosk-shims.js')).kioskShimPlugin);
  }
  const result = await esbuild.build({
    absWorkingDir: tree.kiosk,
    entryPoints: ['js/entry.js'],
    bundle: true,
    format: 'esm',
    write: false,
    logLevel: 'silent',
    alias: { '@dashie/config': path.resolve(tree.kiosk, '../config.js') },
    plugins,
  });
  return result.outputFiles[0].text;
}

/** Capture console.warn lines during fn, without echoing them. */
async function captureWarns(fn) {
  const seen = [];
  const original = console.warn;
  console.warn = (...args) => { seen.push(args.join(' ')); };
  try { await fn(); } finally { console.warn = original; }
  return seen;
}

test('🔴 L1 a build from a repo folder NOT named dashieapp_staging carries no Google key', async () => {
  const out = await bundle(makeTree());
  assert.equal(countGoogleKeys(out), 0, `Google keys in the bundle: ${countGoogleKeys(out)} (want 0)`);
  assert.ok(out.includes('42'), 'the rest of config.js is still bundled');
});

test('CONTROL L2 the same build WITHOUT the plugin shows both keys, so L1 can see a key', async () => {
  const out = await bundle(makeTree(), { withPlugin: false });
  assert.equal(countGoogleKeys(out), 2, `Google keys without the strip: ${countGoogleKeys(out)} (want 2)`);
});

test('🔴 L3 only the root config.js is stripped; another config.js is left alone and says so', async () => {
  const tree = makeTree({ subConfig: true });
  let out = '';
  const warns = await captureWarns(async () => { out = await bundle(tree); });
  assert.equal(countGoogleKeys(out), 1, `Google keys: ${countGoogleKeys(out)} (want 1, the sub config's own)`);
  const drops = warns.filter(w => w.includes('DROP: kiosk-shims'));
  assert.equal(drops.length, 1, `DROP warnings: ${drops.length} (want 1: sub/config.js, none for logger-config.js)`);
  assert.ok(drops[0].includes(path.join('sub', 'config.js')), 'the warning names the file');
  assert.equal(countGoogleKeys(drops.join('\n')), 0, 'the warning never carries a key');
});

test('🔴 L4 a root config.js missing a key constant fails the build, naming the file and the constant', async () => {
  const tree = makeTree({ iosKey: false });
  await assert.rejects(bundle(tree), (err) => {
    const text = [err.message, ...(err.errors || []).map(e => e.text)].join('\n');
    assert.ok(text.includes('GOOGLE_MAPS_IOS_API_KEY'), 'names the missing constant');
    assert.ok(text.includes('config.js'), 'names the file');
    assert.equal(countGoogleKeys(text), 0, 'the error never carries a key');
    return true;
  });
});

test('🔴 L5 the output guard counts real-shape keys only', () => {
  assert.equal(countGoogleKeys(`const a = '${FAKE_WEB}';`), 1);
  assert.equal(countGoogleKeys(`'${FAKE_WEB}' '${FAKE_IOS}'`), 2);
  assert.equal(countGoogleKeys(`const a = '${NEAR_MISS}';`), 0, 'a 34-character tail is not a key');
  assert.equal(countGoogleKeys('no keys here'), 0);
});

test('🔴 L6 with the strip bypassed, the guard refuses the bundle in dist/ AND dist-chickadee/, naming file and count only', async () => {
  const keyed = await bundle(makeTree(), { withPlugin: false });
  const clean = 'export const x = 1;';
  const refused = refuseKeyedOutputs([
    { rel: 'dist/kiosk-shell.bundle.js', text: keyed },
    { rel: 'dist-chickadee/kiosk-shell.bundle.js', text: keyed },
    { rel: 'dist/kiosk-services.bundle.js', text: clean },
  ]);
  assert.deepEqual(refused.map(r => r.rel), ['dist/kiosk-shell.bundle.js', 'dist-chickadee/kiosk-shell.bundle.js']);
  assert.deepEqual(refused.map(r => r.count), [2, 2]);
  for (const r of refused) {
    assert.equal(countGoogleKeys(r.message), 0, 'the refusal message never carries a key');
    assert.ok(r.message.includes(r.rel) && r.message.includes('DROP:'), 'the refusal names the file');
  }
});
