/**
 * esbuild plugin that redirects heavyweight main-app dependencies
 * to lightweight shims for the kiosk dash-menu bundle.
 *
 * This keeps the bundle small while still importing the actual
 * volume-slider.js and brightness-slider.js from the main webapp.
 */

const path = require('path');

const SHIM_DIR = path.resolve(__dirname, 'js/shims');
const MAIN_APP_JS = path.resolve(__dirname, '../js');

/**
 * The repo-root config.js — the ONE file the Google-key strip applies to, and the file build.js aliases as
 * `@dashie/config`. Resolved from this file's own location, so it holds for any clone, worktree or copy name.
 * (The old rule matched the path ending `/dashieapp_staging/config.js`; a worktree under another name
 * silently bundled both keys — vc239, staging 8b6f919bf. Thread A s199, O -3d approved.)
 */
const ROOT_CONFIG = path.resolve(__dirname, '..', 'config.js');
const GOOGLE_KEY_CONSTANTS = ['GOOGLE_MAPS_WEB_API_KEY', 'GOOGLE_MAPS_IOS_API_KEY'];

/** Same file on disk? Compares real paths (macOS /var vs /private/var); falls back to plain resolve. */
function samePath(a, b) {
  const fs = require('fs');
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
}

/**
 * Check if the import is coming from the main webapp's js/ tree.
 */
function isFromMainApp(resolveDir) {
  return resolveDir.startsWith(MAIN_APP_JS);
}

const kioskShimPlugin = {
  name: 'kiosk-shims',
  setup(build) {
    // Strip Google Maps API keys from config.js — kiosk mode never uses maps
    build.onLoad({ filter: /config\.js$/ }, async (args) => {
      // Only the repo-root config.js. The filter also matches logger-config.js and friends; those pass
      // silently. A file named exactly config.js that is NOT the root is left alone, loudly.
      if (!samePath(args.path, ROOT_CONFIG)) {
        if (path.basename(args.path) === 'config.js') {
          console.warn(`DROP: kiosk-shims — config.js at ${args.path} is not the build root's (${ROOT_CONFIG}); Google keys NOT stripped from it`);
        }
        return null;
      }
      const fs = require('fs');
      let contents = fs.readFileSync(args.path, 'utf8');
      // Replace each API key value with an empty string. A constant that is not there means the strip
      // did not apply (a rename, a new key) — that must fail the build, never ship. Names the file and
      // the constant, never the value.
      for (const name of GOOGLE_KEY_CONSTANTS) {
        const assignment = new RegExp(`export const ${name} = '[^']*'`);
        if (!assignment.test(contents)) {
          throw new Error(`DROP: kiosk-shims — root config.js (${args.path}) has no ${name}; the Google key strip did not apply`);
        }
        contents = contents.replace(assignment, `export const ${name} = ''`);
      }
      return { contents, loader: 'js' };
    });
    // Stub theme-applier.js (kiosk is always dark, no theme toggling)
    build.onResolve({ filter: /theme-applier\.js$/ }, (args) => {
      if (isFromMainApp(args.resolveDir)) {
        return { path: path.join(SHIM_DIR, 'theme-applier-shim.js') };
      }
    });

    // Stub the main app's heavyweight logger (matches ./logger.js, ../utils/logger.js, etc.)
    build.onResolve({ filter: /logger\.js$/ }, (args) => {
      // Only shim when imported from the main app's js/ tree
      // Don't shim logger-shim.js itself or logger-config.js
      if (isFromMainApp(args.resolveDir) && !args.path.includes('logger-config') && !args.path.includes('shim')) {
        return { path: path.join(SHIM_DIR, 'logger-shim.js') };
      }
    });

    // Stub cache-buster.js (kiosk assets are in APK, no cache busting)
    build.onResolve({ filter: /cache-buster\.js$/ }, (args) => {
      if (isFromMainApp(args.resolveDir)) {
        return { path: path.join(SHIM_DIR, 'cache-buster-shim.js') };
      }
    });

    // Stub theme-registry.js (kiosk is always dark, no theme switching.
    // Exports named constants/functions that Settings display page needs.)
    build.onResolve({ filter: /theme-registry\.js$/ }, (args) => {
      if (isFromMainApp(args.resolveDir)) {
        return { path: path.join(SHIM_DIR, 'theme-registry-shim.js') };
      }
    });

    // ── app-comms is NOT shimmed. ──────────────────────────────────────
    // It used to be (a no-op stub: the weather overlay published modal:opened/closed and
    // nothing listened). That stub is LOAD-BEARING POISON now that the kiosk runs the
    // real settings stack: settings-service emits 'settings-synced-from-cloud' through
    // AppComms and settings-store subscribes to it — that pair IS the cache-first
    // convergence path (SETTINGS.md, "Account-level write model"). With a no-op
    // subscribe(), a kiosk that missed a broadcast while offline would show its stale
    // cached settings forever, with no error anywhere.
    //
    // The real module costs nothing to bundle: a Map-backed pub/sub whose only import is
    // the logger. No DOM, no AppStateManager. Do not re-add the shim.

    // Bundle Supabase REALTIME instead of the CDN-importing supabase-config.
    // The real module does `import { createClient } from 'https://cdn.skypack.dev/...'`,
    // which a wall tablet booting before its WAN is up simply cannot resolve — the module
    // never evaluates and the whole settings stack silently never exists. See
    // js/shims/supabase-realtime.js for why realtime-js rather than all of supabase-js.
    build.onResolve({ filter: /supabase-config\.js$/ }, (args) => {
      if (isFromMainApp(args.resolveDir)) {
        return { path: path.join(SHIM_DIR, 'supabase-realtime.js') };
      }
    });

    // Stub the photos-widget reload path. The settings stack touches these in exactly one
    // branch ("photo source changed → reload the widget"); a kiosk has no photos widget,
    // and both call sites already optional-chain the result. Only the IMPORT binds — and
    // it would drag widget-data-manager (1,607 lines) + its loader tree into the bundle.
    build.onResolve({ filter: /widget-data-manager\.js$|photos-data-loader\.js$/ }, (args) => {
      if (isFromMainApp(args.resolveDir)) {
        return { path: path.join(SHIM_DIR, 'widget-data-shim.js') };
      }
    });

    // Shim MobileDashboard imports (ConfirmationModal, text-input-modal, etc.)
    // Settings pages that use these are filtered out in kiosk mode, but static
    // imports must still resolve at bundle/load time.
    build.onResolve({ filter: /MobileDashboard/ }, (args) => {
      if (isFromMainApp(args.resolveDir)) {
        return { path: path.join(SHIM_DIR, 'mobile-dashboard-shim.js') };
      }
    });

    // ── Build-time page stubs ──────────────────────────────────────────
    // Kiosk mode only shows 9 pages (dashie-config, home-assistant, display,
    // voice, camera, music, photos, advanced, developer + account in debug).
    // The remaining pages are imported by settings-modal-renderer but never
    // rendered. Replacing them with empty stubs eliminates their entire
    // dependency trees (GPS service, calendar service, family service, etc.).
    // See settings-modal-renderer.js line 155 for the kiosk allowlist.
    const KIOSK_EXCLUDED_PAGES = {
      'settings-family-page.js':         { className: 'SettingsFamilyPage',        isDefault: false },
      'settings-calendar-page.js':       { className: 'SettingsCalendarPage',      isDefault: false },
      'settings-chores-rewards-page.js': { className: 'SettingsChoresRewardsPage', isDefault: false },
      'settings-locations-page.js':      { className: 'SettingsLocationsPage',     isDefault: false },
      'settings-system-page.js':         { className: 'SettingsSystemPage',        isDefault: false },
      'voice-testing-page.js':           { className: 'VoiceTestingPage',          isDefault: false },
      'voice-profile-test-page.js':      { className: 'VoiceProfileTestPage',      isDefault: false },
      'conversation-test-page.js':       { className: 'ConversationTestPage',      isDefault: true  },
    };

    for (const [filename, { className, isDefault }] of Object.entries(KIOSK_EXCLUDED_PAGES)) {
      const escapedName = filename.replace(/\./g, '\\.');
      build.onLoad({ filter: new RegExp(`/${escapedName}$`) }, () => {
        // Stubs need render() because Developer page calls render() on
        // voice-testing/voice-profile-test/conversation-test sub-screens
        const stub = isDefault
          ? `export default class ${className} { constructor() {} render() { return ''; } }`
          : `export class ${className} { constructor() {} render() { return ''; } }`;
        return { contents: stub, loader: 'js' };
      });
    }
  }
};

/**
 * CHICKADEE-only additions, applied on top of [kioskShimPlugin] for the Chickadee shell bundle.
 *
 * Separate plugin rather than an `edition` flag inside the shared one, deliberately: the shared
 * plugin describes what the KIOSK does not need (maps keys, the heavyweight logger, dev-only
 * settings pages) and is edition-blind. What an EDITION does not have is a different axis, and
 * folding the two together is how an edition check ends up in shared machinery — the seam rule's
 * whole subject. Composing two plugins keeps each one's reason for existing legible.
 *
 * Today it carries exactly one redirect. It is a plugin rather than an inline `onResolve` so the
 * next edition-scoped stub has an obvious home instead of being appended to the shared list.
 */
const chickadeeShellShimPlugin = {
  name: 'chickadee-shell-shims',
  setup(build) {
    // The account/session bridge does not exist in this edition (John, 2026-08-02). Replacing
    // the module at BUILD time is what removes the transitive auth tree — and with it the PROD
    // Supabase project id — from the artifact; a runtime gate would leave the string in place.
    build.onResolve({ filter: /kiosk-settings-sync\.js$/ }, () => ({
      path: path.join(SHIM_DIR, 'kiosk-settings-sync-shim.js'),
    }));
  },
};

module.exports = { kioskShimPlugin, chickadeeShellShimPlugin, ROOT_CONFIG };
