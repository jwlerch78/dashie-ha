// ── THE KIOSK BUILD CONFIGURATION — ONE COPY, TWO CONSUMERS ──────────────────────────────────
//
// `build.js` (which writes the bundles) and `scripts/check-bridge-globals.mjs` §2a (which proves
// they are still BUILDABLE, the gate that exists because of the vc209 green-over-an-unbuildable-
// bundle) both need this config. Until 2026-10-16 the gate hand-mirrored it, and the mirror had
// drifted in both directions that matter:
//
//   • it built 1 of the 3 entries, so kiosk-services and the Chickadee shell had NO buildability
//     check at all — the vc209 hole was still open for two of three bundles;
//   • its options omitted `external: ['node:fs', 'node:path']`, which is not merely stale but
//     WRONG: measured 2026-10-16, kiosk-services cannot be built without it — it dies on
//     `Could not resolve "node:fs"` in js/vendor/core-utils/src/storage.js. So extending the
//     mirror to the missing entries would have produced a false RED, not a new pass.
//
// That is CLAUDE.md standing rule 1 (the seam test) in its literal case: a second copy of a list,
// so share the first rather than add a `JS_KOTLIN_CONTRACTS` row and a gate for a hand-mirror.
//
// 🔑 WHY THIS FILE HAS NO SIDE EFFECTS, deliberately: `build.js`'s top level copies
// weather-overlay.css and shells out for the git SHA, so merely *reading the config* used to mean
// running those. The gate requires this module instead, and requiring it does nothing but build
// two objects.
//
// ⚠️ `absWorkingDir` is what lets the paths below stay RELATIVE and still resolve for a caller
// whose cwd is anywhere (the gate runs from the repo root). Do not "fix" them into absolute paths;
// relative + absWorkingDir is why the two consumers can share one copy.
//
// 📌 Not shipped in the APK: `sync-kiosk-overlay.sh`'s asset rsync excludes `build*.js`, so this
// file is covered by the same glob that was widened when build-banner.js first appeared beside
// build.js (sync-kiosk-overlay.sh:54-55, :73). The `--addon` rsync excludes only `build.js`
// exactly, so this file travels to the HA add-on tree alongside build-banner.js, as it must to
// keep that copy runnable.
const path = require('path');
const { kioskShimPlugin, chickadeeShellShimPlugin, ROOT_CONFIG } = require('./esbuild-kiosk-shims');

// Shared build options
const sharedOptions = {
  // Resolve every relative path below against THIS directory, not the caller's cwd.
  absWorkingDir: __dirname,
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'esm',
  external: ['node:fs', 'node:path'],
  // 🔴 chrome61, NOT chrome100 (John, 2026-09-28: "Yes - lower to 61"). See BUGS D-142/D-178/D-184.
  //
  // `target` is PERMISSION TO EMIT, not an instruction to inject: it tells esbuild what it may
  // leave UNLOWERED. At chrome100 it left 555 optional-chainings and 56 nullish-coalescings in
  // kiosk-shell.bundle.js, so the bundle's real floor was Chrome 80 — while `minSdk = 23` claims
  // we support platforms whose stock WebView is far below that. 61 is the floor set by the
  // `<script type="module">` tag in kiosk-shell.html, so it is the lowest target worth asking for
  // without also abandoning modules.
  //
  // Why it matters, measured rather than assumed (D-142): a WebView that cannot parse the bundle
  // does not error, does not crash and logs NOTHING — the tag is silently ignored and the user
  // sees a black screen. One reporter's Android 6 tablet (Chrome 50) produced ZERO [KioskShell]
  // lines in 4,700 of logcat while the page itself loaded cleanly.
  //
  // ⚠️ THIS FLAG IS NOT THE WHOLE FLOOR. Code we ship as a STRING and eval in the HA realm
  // (`evalInHaIframe`) is DATA to esbuild and SYNTAX to the runtime, so no target can lower it.
  // Those sites were rewritten by hand (D-184); if you add an injected-script string, it must be
  // ES2019 by hand — nothing here will catch it for you.
  target: ['chrome61'],
  metafile: true,
  // esbuild hands back the bytes instead of writing them; the write decision is ours,
  // in the .then() below. Without this, esbuild writes before we can compare.
  write: false,
  // NOTE: no `banner` here — it is PER-ENTRY now (see bannerFor / the build loop). A shared
  // banner is what made every bundle write the same global; keeping the key correct requires
  // knowing the outfile, which only the entry does.
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
      '@dashie/config': ROOT_CONFIG, // the same file the shim strips keys from - one constant
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
      '@dashie/config': ROOT_CONFIG, // the same file the shim strips keys from - one constant
    },
    plugins: [kioskShimPlugin, chickadeeShellShimPlugin],
  },
];

module.exports = { sharedOptions, entries };
