#!/usr/bin/env node
// scan-publish-secrets.mjs — refuse to publish a tree that contains secrets.
//
// WHY THIS EXISTS
// ---------------
// We run private → public vendoring pipes. `dashie-ha-app/scripts/release.sh` has
// copied the private console into a public repo on every release since April 2026 —
// 376 files, ungated, without anyone deciding to. It happens to be clean. Nothing
// made it clean, and nothing would have caught it if it weren't.
//
// A one-time audit answers "is it clean today". This answers "is it clean at every
// future publish", which is the question that actually matters. It is cheap,
// permanent, and catches the class of error rather than one instance.
//
// CANONICAL COPY lives in dashieapp_staging/scripts/. It is VENDORED verbatim into
// the public repos so their release scripts can run it without a private checkout —
// a gate that silently degrades when the private repo is absent is not a gate.
// `npm run lint:public-mirror` fails if the copies drift. Do not edit the copies.
//
// USAGE
//   node scan-publish-secrets.mjs <dir> [<dir>...] [--allow FILE] [--quiet] [--all-files]
//
//   exit 0 → clean
//   exit 1 → findings (printed with file:line and a redacted excerpt)
//   exit 2 → bad usage / unreadable input  (never conflate "clean" with "didn't run")
//
// ALLOWLIST
//   JSON: [{ "file": "<substring or glob-ish prefix>", "match": "<literal>",
//            "reason": "<why this is safe to publish>" }]
//   `reason` is REQUIRED. An allowlist entry without a stated reason is how a real
//   leak gets waved through six months later by someone who wasn't there.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.cache',
  '__pycache__', '.venv', 'venv', 'coverage', '.gradle',
]);

// Binary/compiled things we can't meaningfully grep, plus media.
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.bmp',
  '.mp3', '.mp4', '.wav', '.ogg', '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.gz', '.tar', '.jar', '.apk', '.aab', '.so', '.dylib',
  '.pdf', '.tflite', '.onnx', '.bin', '.keystore', '.jks',
]);

// A file whose NAME alone is disqualifying.
const FORBIDDEN_NAMES = [
  { re: /^\.env(\..*)?$/,        what: 'environment file' },
  { re: /\.pem$/,                what: 'PEM file' },
  { re: /^id_(rsa|dsa|ecdsa|ed25519)$/, what: 'SSH private key' },
  { re: /\.(p12|pfx|keystore|jks)$/,    what: 'keystore' },
  { re: /^service-account.*\.json$/,    what: 'GCP service-account key' },
];

// Ordered most-specific first; `severity: 'hard'` cannot be reached by accident.
const PATTERNS = [
  { id: 'private-key-block', severity: 'hard',
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    note: 'a private key block' },
  { id: 'aws-access-key', severity: 'hard',
    re: /\bAKIA[0-9A-Z]{16}\b/g, note: 'an AWS access key id' },
  { id: 'stripe-live', severity: 'hard',
    re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{16,}/g, note: 'a live Stripe secret key' },
  { id: 'openai-key', severity: 'hard',
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, note: 'an OpenAI-style secret key' },
  { id: 'github-token', severity: 'hard',
    re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, note: 'a GitHub token' },
  { id: 'slack-token', severity: 'hard',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, note: 'a Slack token' },
  { id: 'google-api-key', severity: 'soft',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    note: 'a Google API key (client keys are unavoidable — allowlist it once, deliberately, and make sure it is restricted)' },
  { id: 'generic-assignment', severity: 'soft',
    re: /\b(?:secret|password|passwd|api_?key|auth_?token|access_?token|private_?key)\s*[:=]\s*['"][^'"\n]{16,}['"]/gi,
    note: 'a secret-shaped assignment' },
];

// JWTs get decoded rather than pattern-matched: Supabase ANON keys are public by
// design and appear all over client code, while a SERVICE_ROLE key is a total
// compromise. Same shape, opposite meaning — only the payload tells them apart.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.([A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g;

function classifyJwt(payloadB64) {
  try {
    const json = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const role = json.role || json.Role || '';
    if (role && role !== 'anon') return { bad: true, role };
    return { bad: false, role: role || '(none)' };
  } catch {
    return { bad: false, role: '(undecodable)' };  // not a JWT we understand
  }
}

function redact(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length <= 24 ? t.slice(0, 8) + '…' : t.slice(0, 12) + '…' + t.slice(-4);
}

function* walkFs(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      yield* walkFs(p);
    } else if (st.isFile()) {
      yield p;
    }
  }
}

// A PUBLISH gate must scan what git would publish — not the working directory.
// Scanning the raw filesystem blocks on gitignored local files (a developer's
// .env is the obvious one), and a gate that cries wolf on files that can never
// ship is a gate someone switches off. So inside a git work tree, enumerate
// tracked + untracked-but-not-ignored files; that is exactly the set that can
// reach a commit. Outside one (e.g. an rsync staging dir) fall back to walking.
function listFiles(root, forceAll) {
  if (!forceAll) {
    const r = spawnSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'],
                        { encoding: 'buffer' });
    if (r.status === 0) {
      return r.stdout.toString('utf8').split('\0').filter(Boolean)
        .map(p => join(root, p))
        .filter(p => !p.split('/').some(seg => SKIP_DIRS.has(seg)))
        .filter(p => { try { return statSync(p).isFile(); } catch { return false; } });
    }
  }
  return [...walkFs(root)];
}

function loadAllowlist(file) {
  if (!file) return [];
  if (!existsSync(file)) { console.error(`❌ allowlist not found: ${file}`); process.exit(2); }
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { console.error(`❌ allowlist is not valid JSON: ${e.message}`); process.exit(2); }
  if (!Array.isArray(parsed)) { console.error('❌ allowlist must be a JSON array'); process.exit(2); }
  for (const [i, e] of parsed.entries()) {
    if (!e || !e.reason || !String(e.reason).trim()) {
      console.error(`❌ allowlist entry ${i} has no "reason" — every exemption must say why it is safe.`);
      process.exit(2);
    }
  }
  return parsed;
}

const isAllowed = (allow, relPath, matched) =>
  allow.some(a => (!a.file || relPath.includes(a.file)) &&
                  (!a.match || matched.includes(a.match)));

function scanTree(root, allow, forceAll) {
  const findings = [];
  const add = (f) => findings.push(f);

  for (const abs of listFiles(root, forceAll)) {
    const rel = relative(root, abs);
    const name = basename(abs);

    for (const { re, what } of FORBIDDEN_NAMES) {
      if (re.test(name) && !isAllowed(allow, rel, name)) {
        add({ rel, line: 0, id: 'forbidden-file', severity: 'hard',
              note: `${what} committed in the tree`, excerpt: name });
      }
    }

    if (SKIP_EXT.has(extname(abs).toLowerCase())) continue;

    let text;
    try {
      const st = statSync(abs);
      if (st.size > 8 * 1024 * 1024) continue;          // too big to be source
      text = readFileSync(abs, 'utf8');
    } catch { continue; }
    if (text.includes("\0")) continue;               // binary

    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const p of PATTERNS) {
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(line)) !== null) {
          if (isAllowed(allow, rel, m[0])) continue;
          add({ rel, line: i + 1, id: p.id, severity: p.severity,
                note: p.note, excerpt: redact(m[0]) });
        }
      }
      JWT_RE.lastIndex = 0;
      let j;
      while ((j = JWT_RE.exec(line)) !== null) {
        const { bad, role } = classifyJwt(j[1]);
        if (!bad) continue;                              // anon keys are public by design
        if (isAllowed(allow, rel, j[0])) continue;
        add({ rel, line: i + 1, id: 'privileged-jwt', severity: 'hard',
              note: `a JWT with role="${role}" (anon is fine; this is not)`,
              excerpt: redact(j[0]) });
      }
    });
  }
  return findings;
}

// ── main ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const roots = [];
let allowFile = null, quiet = false, forceAll = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--allow') { allowFile = argv[++i]; }
  else if (argv[i] === '--quiet') { quiet = true; }
  else if (argv[i] === '--all-files') { forceAll = true; }
  else if (argv[i].startsWith('-')) { console.error(`unknown flag: ${argv[i]}`); process.exit(2); }
  else roots.push(argv[i]);
}
if (!roots.length) {
  console.error('usage: scan-publish-secrets.mjs <dir> [<dir>...] [--allow FILE] [--quiet] [--all-files]');
  process.exit(2);
}

const allow = loadAllowlist(allowFile);
let all = [];
for (const r of roots) {
  if (!existsSync(r)) { console.error(`❌ not found: ${r}`); process.exit(2); }
  all = all.concat(scanTree(r, allow, forceAll).map(f => ({ ...f, root: r })));
}

if (!all.length) {
  if (!quiet) console.log(`✅ secret scan clean — ${roots.join(', ')}`);
  process.exit(0);
}

console.error(`\n❌ secret scan found ${all.length} thing(s) that must not be published:\n`);
for (const f of all.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'hard' ? -1 : 1))) {
  const tag = f.severity === 'hard' ? 'BLOCK' : 'CHECK';
  console.error(`  [${tag}] ${f.rel}${f.line ? ':' + f.line : ''}`);
  console.error(`          ${f.note}`);
  console.error(`          ${f.excerpt}\n`);
}
console.error('Nothing was published. Remove the secret, or — if it is genuinely safe —');
console.error('add an allowlist entry WITH a reason and re-run.\n');
process.exit(1);
