/* ============================================================
   Brand — Chickadee (open-core build).
   CANONICAL since the 2026-07-27 repo inversion: the console is
   developed in this repo; this file IS the Chickadee brand (the
   Dashie build keeps its own brand.js as part of its delta —
   see PROVENANCE.md for the relationship).

   Wire values deliberately stay Dashie's (shared-backend
   contracts, not brand): the `dashie_cloud` engine ID,
   localStorage keys, dashie-* CSS classes, and option/wake-word
   IDs. Only display identity lives here.
   ============================================================ */

const BRAND = {
    // 'chickadee' flips FeatureGate's open-build rules (family pages off,
    // voice/AI + credits ungated). Absent in the Dashie brand.js.
    build: 'chickadee',

    // Product + assistant naming
    productName: 'Chickadee',
    consoleName: 'Chickadee Console',
    assistantName: 'Chickadee',
    wakePhrase: 'your wake word',    // HA pipelines bring their own wake word
    cloudName: 'Chickadee Cloud',    // display label for the `dashie_cloud` engine
    teamName: 'the Chickadee team',

    // Web presence — first-party Chickadee surfaces now live on
    // getchickadee.org (landing + legal). Accounts/billing still ride the
    // Dashie backend; the footerNote below keeps that disclosure in plain
    // sight (the Dashie connection is documented, not hidden).
    domain: 'getchickadee.org',
    supportEmail: 'support@getchickadee.org',
    // Rendered under the legal links on the login card — the plain-sight
    // disclosure that the account system is shared with Dashie.
    footerNote: 'Accounts &amp; billing are provided by Dashie (dashieapp.com), the makers of Chickadee.',

    // Brand assets (paths relative to the console root)
    logo: 'assets/chickadee-logo.png',
    icon: 'assets/chickadee-icon.png',

    // Docs / legal — Chickadee's own policies on getchickadee.org
    urls: {
        privacy: 'https://getchickadee.org/privacy',
        terms: 'https://getchickadee.org/terms',
    },
};

// Keep the tab identity brand-driven (defensive — the statics already
// ship Chickadee values in this tree).
try {
    document.title = BRAND.consoleName;
    const fav = document.querySelector('link[rel="icon"]');
    if (fav) fav.href = BRAND.icon;
} catch (_) { /* non-browser */ }

// Chickadee theme: brand wing-blue accent (#2C6ECE, sampled from the logo's
// wing) replaces Dashie orange. The console is fully accent-var driven, so
// four variable overrides re-skin everything (preset outlines/checkmarks,
// toggles, tabs, active nav, primary buttons); the one exception is the
// active nav-icon tint, which is a CSS filter (filters can't read vars) —
// overridden with a blue-producing chain. Injected AFTER the stylesheets
// (brand.js is the first <script>, below the <link>s) so equal-specificity
// rules win by order; the vendored CSS stays byte-identical to upstream.
try {
    const theme = document.createElement('style');
    theme.textContent = [
        ':root {',
        '  --accent: #2C6ECE;',
        '  --accent-hover: #2559A8;',
        '  --accent-bg: rgba(44, 110, 206, 0.08);',
        '  --accent-bg-hover: rgba(44, 110, 206, 0.14);',
        '}',
        '.sidebar-nav-item.active .nav-icon img {',
        '  filter: brightness(0) saturate(100%) invert(36%) sepia(78%) saturate(1350%) hue-rotate(203deg) brightness(94%) contrast(92%);',
        '}',
    ].join('\n');
    document.head.appendChild(theme);
} catch (_) { /* non-browser */ }

window.BRAND = BRAND;
