const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { kioskShimPlugin } = require('./esbuild-kiosk-shims');

// Copy shared CSS from main webapp into kiosk assets (single source of truth)
fs.copyFileSync(
  path.resolve(__dirname, '../css/modules/weather-overlay.css'),
  path.resolve(__dirname, 'css/weather-overlay.css')
);
console.log('📋 Copied weather-overlay.css from main app');

// Provenance build stamp (runtime-provenance P0): a header line Kotlin's ProvenanceReporter
// reads straight from the APK asset, answering "is the bundle on this device the one I just
// built?" without any WebView eval. Also exposed as window.__DASHIE_KIOSK_BUILD for JS.
const { execSync } = require('child_process');
let gitSha = 'unknown';
try { gitSha = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch {}
const buildStamp = `${gitSha} ${new Date().toISOString()}`;

// Shared build options
const sharedOptions = {
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'esm',
  external: ['node:fs', 'node:path'],
  target: ['chrome100'],
  metafile: true,
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
];

// Build all entries in parallel
Promise.all(
  entries.map(entry =>
    esbuild.build({ ...sharedOptions, ...entry })
  )
).then(results => {
  for (const result of results) {
    for (const [file, info] of Object.entries(result.metafile.outputs)) {
      const sizeKB = (info.bytes / 1024).toFixed(1);
      console.log(`\u2705 Built: ${file} (${sizeKB} KB)`);
    }
  }
}).catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
