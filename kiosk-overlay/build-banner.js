// kiosk-overlay/build-banner.js
//
// The provenance banner: the two-line header every kiosk bundle carries, and the strip that
// removes it so two builds can be compared on CODE alone.
//
// ## Why this is its own module rather than two functions inside build.js
//
// Both halves are load-bearing and neither can be checked by running the build:
//
//  1. `stripBanner` MUST remove exactly what `banner` emits. If it does not, every rebuild sees a
//     difference, rewrites every bundle, and the content-stable behaviour build.js was changed to
//     get (2026-07-31) silently reverts to permanent churn — the state in which a genuine bundle
//     change is indistinguishable from noise in `git status`.
//  2. The `// DASHIE-BUNDLE-BUILD <sha> <time>` comment line is parsed by KOTLIN
//     (`ProvenanceReporter.readBundleStamp`, a `DASHIE-BUNDLE-BUILD\s+(\S+\s+\S+)` regex reading
//     the APK asset directly). That is a cross-boundary contract with no shared build —
//     JS_KOTLIN_CONTRACTS #77.
//
// Checking either by running `node build.js` means rebuilding bundles, which dirties two repos and
// is a supervised operation. So the rule lives here, `build.js` consumes it, and
// `scripts/check-bundle-banner.mjs` asserts both invariants against THIS module — not against a
// second copy of the format, which is the hand-mirror the whole exercise is about.

const path = require('path');

/**
 * 🔴 One global, N writers — the defect this shape exists to prevent (T s43 cont.26).
 *
 * Every bundle used to assign the same `window.__DASHIE_KIOSK_BUILD` scalar. Three bundles load
 * into one page, so LOAD ORDER decided the value and it was wrong for at least two of them. It
 * could not be right in principle either: content-stable builds give each bundle the stamp of the
 * build that last changed IT, and those legitimately differ by weeks.
 *
 * Each bundle writes its own KEY into an accumulating map instead, so no writer clobbers another.
 * The retired scalar had no readers anywhere in either repo — a write-only global that could only
 * ever be wrong — so it was dropped rather than kept alongside.
 */
const BUNDLE_GLOBAL = '__DASHIE_KIOSK_BUILDS';

/** The comment line Kotlin parses. Kept per-file and unchanged by the 2026-08-22 keying fix. */
const COMMENT_PREFIX = '// DASHIE-BUNDLE-BUILD';

/**
 * The banner for one bundle.
 * @param {string} outfile e.g. `dist/kiosk-shell.bundle.js` — only the basename is used as the key
 * @param {string} buildStamp `<short-sha> <ISO-8601>`
 */
function bannerFor(outfile, buildStamp) {
  const key = path.basename(outfile);
  return `${COMMENT_PREFIX} ${buildStamp}\n`
    + `window.${BUNDLE_GLOBAL}=window.${BUNDLE_GLOBAL}||{};`
    + `window.${BUNDLE_GLOBAL}[${JSON.stringify(key)}]=${JSON.stringify(buildStamp)};\n`;
}

/**
 * Remove the banner so two builds compare on code alone.
 *
 * Tolerates its absence (bundles predating the banner compare correctly) and still strips the
 * RETIRED single-global form, so a bundle built before 2026-08-22 is not rewritten by the format
 * change alone — it picks up the keyed form the next time its own code changes. With no readers
 * of either global, nothing depends on when that happens.
 */
function stripBanner(text) {
  return text
    .replace(/^\/\/ DASHIE-BUNDLE-BUILD [^\n]*\n/, '')
    .replace(/^window\.__DASHIE_KIOSK_BUILDS=[^\n]*;\n/, '')
    .replace(/^window\.__DASHIE_KIOSK_BUILD='[^\n]*';\n/, '');   // retired form
}

module.exports = { bannerFor, stripBanner, BUNDLE_GLOBAL, COMMENT_PREFIX };
