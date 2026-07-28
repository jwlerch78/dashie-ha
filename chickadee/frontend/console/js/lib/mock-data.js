/* ============================================================
   User identity store (historical name: MockData).
   The only live block is `user` — populated from real auth in
   app.js (_showApp). All demo/mock blocks were pruned 2026-07
   (dead: nothing referenced them; locations demo data moved
   into locations.js with the page).
   ============================================================ */

const MockData = {
    // Identity is populated from real auth in app.js (_showApp). Defaults are
    // BLANK on purpose — a placeholder like "john@example.com" here would render
    // as a convincing fake identity if the app ever shows before/without real
    // auth (the half-auth bug, now also guarded by _handleAuthFailure).
    user: {
        email: '',
        name: '',
        initials: '',
        picture: '',   // Google avatar URL when signed in (see app.js init)
        provider: 'Google',
    },
};
