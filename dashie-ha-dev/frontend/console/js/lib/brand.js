/* ============================================================
   Brand — the PUBLISHED build (Dashie for Home Assistant).
   CANONICAL since the 2026-07-27 repo inversion: the console is
   developed in this repo; the full (family) build keeps its own
   brand.js as part of its delta.

   Since the 2026-07-30 brand consolidation there is ONE brand.
   This file and the full build's brand.js now differ in exactly
   one meaningful field — `build` — plus whatever the family
   product legitimately names that this edition has no page for.
   Resist re-growing a second identity here: name proliferation is
   what that consolidation existed to undo.

   Wire values deliberately stay as they are (shared-backend
   contracts, not brand): the `dashie_cloud` engine ID,
   localStorage keys, dashie-* CSS classes, and option/wake-word
   IDs. Only display identity lives here.
   ============================================================ */

const BRAND = {
    // EDITION, not brand. 'published' = this inspectable core on its own;
    // 'full' = published core + the closed family delta. FeatureGate reads
    // exactly these two values and treats anything else as 'published' (the
    // restrictive case) with a loud DROP — see feature-gate.js isPublishedBuild.
    // Both brand.js files MUST state it; a missing value is a defect, not a
    // default. Registered in .reference/JS_KOTLIN_CONTRACTS.md.
    build: 'published',

    // Product + assistant naming
    productName: 'Dashie',           // the product/account ("Your Dashie account")
    consoleName: 'Dashie Console',   // tab title + login heading
    assistantName: 'Dashie',         // the voice persona ("Dashie said …", "Ask Dashie")
    wakePhrase: 'Hey Dashie',        // display only — wake-word IDs stay 'hey_dashie'
    cloudName: 'Dashie Cloud',       // display label for the `dashie_cloud` engine

    teamName: 'the Dashie team',

    // Web presence
    domain: 'dashieapp.com',
    supportEmail: 'support@dashieapp.com',

    // Brand assets (paths relative to the console root)
    logo: 'assets/dashie-logo-orange.png',
    icon: 'assets/dashie-icon.png',

    // Docs / legal
    urls: {
        privacy: 'https://dashieapp.com/privacy-policy.html',
        terms: 'https://dashieapp.com/terms-of-service.html',
    },

    // No footerNote: it used to disclose that Chickadee accounts were really
    // Dashie accounts. One brand, so there is nothing left to disclose — and a
    // disclosure of a relationship that no longer exists is just confusing.
    // (app.js renders it only when present.)
};

// Keep the tab identity brand-driven (defensive — the statics already
// ship these values in this tree).
try {
    document.title = BRAND.consoleName;
    const fav = document.querySelector('link[rel="icon"]');
    if (fav) fav.href = BRAND.icon;
} catch (_) { /* non-browser */ }

// No theme override. Until 2026-07-30 this file injected a wing-blue accent to
// re-skin the console for the Chickadee brand; both editions are Dashie now, so
// the base stylesheet's orange stands and there is nothing to override.

window.BRAND = BRAND;
