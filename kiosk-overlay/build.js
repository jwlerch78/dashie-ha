const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { kioskShimPlugin, chickadeeShellShimPlugin } = require('./esbuild-kiosk-shims');

// Copy shared CSS from main webapp into kiosk assets (single source of truth).
//
// ⚠️ Tolerant of the source's ABSENCE since 2026-08-18 (#32 D4), and the reason is about the
// PUBLISHED Android tree, not about this one. build.js now ships in the open-source Android
// repo so the two bundles in the APK are not opaque blobs. That tree has the overlay source
// but not `../css/modules/` — it is the private webapp repo's.
//
// Unguarded, this line threw ENOENT on line 7, before esbuild ran, and the error a stranger
// saw named a STYLESHEET. The real boundary is the @dashie/* import aliases below; failing
// first on an unrelated file is a misleading error, which is worse than a loud one.
// `css/weather-overlay.css` is already present in that tree (the sync copies it), so the copy
// is a convenience for the private build. Behaviour here is unchanged when the source exists.
const sharedCss = path.resolve(__dirname, '../css/modules/weather-overlay.css');
if (fs.existsSync(sharedCss)) {
  fs.copyFileSync(sharedCss, path.resolve(__dirname, 'css/weather-overlay.css'));
  console.log('📋 Copied weather-overlay.css from main app');
} else if (fs.existsSync(path.resolve(__dirname, 'css/weather-overlay.css'))) {
  console.log('📋 weather-overlay.css: no shared source here — using the copy already in css/');
} else {
  console.error('DROP: weather-overlay.css missing from BOTH ../css/modules/ and ./css/ — the weather overlay will be unstyled.');
}

// Provenance build stamp (runtime-provenance P0): a header line Kotlin's ProvenanceReporter
// reads straight from the APK asset, answering "is the bundle on this device the one I just
// built?" without any WebView eval. Also exposed as window.__DASHIE_KIOSK_BUILD for JS.
const { execSync } = require('child_process');
let gitSha = 'unknown';
try { gitSha = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch {}
const buildStamp = `${gitSha} ${new Date().toISOString()}`;

// ⚠️ The stamp is the ONLY non-deterministic thing in this build, and both halves of it
// churn: the timestamp on every run, the SHA whenever HEAD moves. Written unconditionally,
// that made every no-op rebuild rewrite each bundle — dirtying dashieapp_staging AND, via
// sync-kiosk-overlay.sh, dashie-android (and dashie-ha-addon with --addon). Nobody committed
// those diffs, because a stamp-only diff reads as noise; and the "don't touch other threads'
// files" rule then froze them in place, so the trees stayed permanently dirty.
//
// The real cost was not the noise. It was that a GENUINE bundle change became
// indistinguishable from stamp churn in `git status` — two modified .bundle.js files either
// way — so a real change could sit uncommitted and never reach the APK. That is the
// "authored but unreached" failure class the standing rules exist to prevent.
//
// Fix: write a bundle only when its CODE changed (banner excluded from the comparison).
// A no-op rebuild leaves the files untouched, so a dirty bundle now always means a real
// change. The stamp's meaning narrows from "the last time anyone ran a build" to "the build
// that last changed this bundle" — which is what the provenance question actually wants.
//
// The banner FORMAT is unchanged, so ProvenanceReporter.bundleStamp()'s
// `DASHIE-BUNDLE-BUILD\s+(\S+\s+\S+)` regex keeps matching. No Kotlin change, no contract row.

/** Strip the two-line provenance banner so two builds can be compared on code alone.
 *  Tolerates its absence — bundles predating the banner still compare correctly. */
function stripBanner(text) {
  return text
    .replace(/^\/\/ DASHIE-BUNDLE-BUILD [^\n]*\n/, '')
    .replace(/^window\.__DASHIE_KIOSK_BUILD='[^\n]*';\n/, '');
}

// Shared build options
const sharedOptions = {
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'esm',
  external: ['node:fs', 'node:path'],
  target: ['chrome100'],
  metafile: true,
  // esbuild hands back the bytes instead of writing them; the write decision is ours,
  // in the .then() below. Without this, esbuild writes before we can compare.
  write: false,
  banner: { js: `// DASHIE-BUNDLE-BUILD ${buildStamp}\nwindow.__DASHIE_KIOSK_BUILD='${buildStamp}';` },
};

// Build entries
// NOTE: kiosk-settings and dash-menu bundles removed (2026-03-11).
// Native Kotlin now handles sidebar, control center, and settings in kiosk mode.
// Only kiosk-services (timers/voice/AI) and kiosk-shell (onboarding/HA iframe mgmt) remain.
const entries = [
  {
    entryPoints: ['js/kiosk-services.js'],
    outfile: 'dist/kiosk-services.bundle.js',
    // Resolve import map aliases for shared vendor code
    alias: {
      '@dashieapp/core-utils': './js/vendor/core-utils/src/index.js',
      '@dashieapp/timer-service': './js/vendor/timer-service/src/index.js',
      // SINGLE SOURCE (2026-07-18): the repo-root copy — the same tree the Kotlin data codegen
      // (gen-android-intent-data.mjs) and the golden vectors read. The former kiosk-local copy
      // under kiosk-overlay/js/vendor/dashie-shared/ was a hand-synced mirror that drifted
      // (missing keywords sent music phrasings to the full overlay); it is DELETED.
      '@dashieapp/intent-classifier': '../js/vendor/dashie-shared/intent-classifier/src/index.js',
    },
  },
  {
    entryPoints: ['js/kiosk-shell.js'],
    outfile: 'dist/kiosk-shell.bundle.js',
    // Same aliases as dash-menu (shared UI/utils from main webapp)
    alias: {
      '@dashie/ui': path.resolve(__dirname, '../js/ui'),
      '@dashie/utils': path.resolve(__dirname, '../js/utils'),
      '@dashie/config': path.resolve(__dirname, '../config.js'),
    },
    plugins: [kioskShimPlugin],
  },
  // ── The CHICKADEE shell — same entry point, one module stubbed ────────────────────────────
  //
  // John ruled the Chickadee shell carries no account/session bridge (2026-08-02), and the goal
  // is a property of the ARTIFACT: zero account/session/Supabase strings in an account-free
  // product. A runtime gate cannot deliver that, because the real module's cloud imports are
  // DYNAMIC — already inert at runtime without a session, but inlined at bundle time. So the
  // edition split belongs here.
  //
  // ⚠️ Emitted to `dist-chickadee/`, OUTSIDE the tree `sync-kiosk-overlay.sh` rsyncs into
  // `src/main/assets/webapp/`. Anything under `dist/` reaches BOTH artifacts, which would put a
  // second shell bundle in the Dashie APK and defeat the point. The sync script excludes this
  // directory and places the file into `src/chickadeeBrand/assets/` instead, where it OVERRIDES
  // main's copy at the same asset path for the Chickadee flavors only.
  //
  // 🔴 Override, never removal — the distinction that decides what this mechanism can and cannot
  // fix. Android asset merging ADDS and REPLACES; it cannot subtract. It works here because we
  // are substituting a file that exists in both editions. It does NOT work for the five Dashie
  // mark files, which would need to MOVE out of main/ — a separate change, correctly still
  // deferred rather than folded in here on momentum.
  {
    entryPoints: ['js/kiosk-shell.js'],
    outfile: 'dist-chickadee/kiosk-shell.bundle.js',
    alias: {
      '@dashie/ui': path.resolve(__dirname, '../js/ui'),
      '@dashie/utils': path.resolve(__dirname, '../js/utils'),
      '@dashie/config': path.resolve(__dirname, '../config.js'),
    },
    plugins: [kioskShimPlugin, chickadeeShellShimPlugin],
  },
];

// Build all entries in parallel
Promise.all(
  entries.map(entry =>
    esbuild.build({ ...sharedOptions, ...entry })
  )
).then(results => {
  let wrote = 0, kept = 0;
  for (const result of results) {
    for (const out of result.outputFiles) {
      const rel = path.relative(__dirname, out.path);
      const next = out.text;

      let prev = null;
      try { prev = fs.readFileSync(out.path, 'utf8'); } catch { /* first build \u2014 no file yet */ }

      // Compare on code alone. Equal \u2192 leave the file completely untouched, stamp and all,
      // so the working tree stays clean and `git status` keeps its signal.
      if (prev !== null && stripBanner(prev) === stripBanner(next)) {
        console.log(`\u23ed\ufe0f  Unchanged: ${rel} (kept existing stamp)`);
        kept++;
        continue;
      }

      fs.mkdirSync(path.dirname(out.path), { recursive: true });
      fs.writeFileSync(out.path, next);
      const sizeKB = (Buffer.byteLength(next) / 1024).toFixed(1);
      console.log(`\u2705 Built: ${rel} (${sizeKB} KB)`);
      wrote++;
    }
  }
  // \u2500\u2500 Record that a build RAN, regardless of whether it wrote anything \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  //
  // The staleness guard in check-bridge-globals.mjs used to ask "is any kiosk source newer than
  // the newest bundle?" That premise contradicts this file's deliberate don't-rewrite-unchanged
  // behaviour, and the contradiction is a DEADLOCK, not a nuisance: edit a comment in a kiosk
  // source, and the bundle is legitimately unchanged, so the guard fails with "rebuild first" \u2014
  // you rebuild, nothing is written, and it fails again, forever. It gates APK builds, so that
  // is a hard stop reachable by editing a comment.
  //
  // The guard's real question is "did a build run since this source was last edited?", which
  // only this file can answer. So it is answered here, unconditionally.
  fs.writeFileSync(path.join(__dirname, '.last-build'), `${buildStamp}\n`);

  console.log(`\n\ud83d\udce6 ${wrote} bundle(s) written, ${kept} unchanged.`);
  if (wrote > 0) {
    // Loud on purpose: a written bundle is a real change that MUST be committed and synced,
    // or the APK ships different JS than the repo says it does.
    console.log('   \u26a0\ufe0f  Commit the changed bundle(s) and run ./sync-kiosk-overlay.sh before building the APK.');
  }
}).catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
