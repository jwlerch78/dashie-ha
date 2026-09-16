// kiosk-overlay/key-guard.js
//
// The kiosk bundles must carry no Google API key (the kiosk never shows a map). The shim strips the keys
// from the repo-root config.js; this guard checks the OUTCOME, whatever the cause: a skipped strip, a new
// key constant, or a hardcoded key in a newly imported module. build.js refuses to write any bundle it
// flags — in dist/ AND dist-chickadee/ (the chickadee tree is the one that gets vendored).
// Thread A s199, O -3d approved A-status s199 cont.8. Tests: esbuild-kiosk-shims.test.cjs.
//
// 🔴 Reports COUNTS and file names only. A key value must never reach a terminal or a CI log.

const GOOGLE_KEY = /AIza[0-9A-Za-z_-]{35}/g;

/** How many real-shape Google API keys the text contains. */
function countGoogleKeys(text) {
  return (String(text).match(GOOGLE_KEY) || []).length;
}

/**
 * @param {{rel: string, text: string}[]} outputs every bundle about to be written
 * @returns {{rel: string, count: number, message: string}[]} the ones that must NOT be written
 */
function refuseKeyedOutputs(outputs) {
  return outputs
    .map(o => ({ rel: o.rel, count: countGoogleKeys(o.text) }))
    .filter(r => r.count > 0)
    .map(r => ({ ...r, message: `DROP: kiosk build — ${r.count} Google API key(s) in ${r.rel}; bundle NOT written` }));
}

module.exports = { countGoogleKeys, refuseKeyedOutputs };
