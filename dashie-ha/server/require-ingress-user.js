// SPDX-License-Identifier: AGPL-3.0-only
// require-ingress-user.js — "has Home Assistant already authenticated this caller?"
//
// ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────────────
//
// 🔴 It is an IMPROVEMENT, not a boundary. Say that plainly, because the
// tempting sentence — "the add-on publishes no ports, so only ingress can reach
// it" — is false in the half that matters:
//
//   • config.yaml keeps `ports: {}`, so no HOST port is published and the server
//     is NOT reachable from the LAN. That part is true and worth having.
//   • But the server binds 0.0.0.0 (index.js), so it IS reachable from Home
//     Assistant's internal docker network, where these headers are just headers
//     and anything on that network can supply them. `ingress-identity.js` says
//     so in its own docstring.
//
// So this does not stop something already inside HA's docker network. What it
// does is strictly better than the alternative it replaces:
//
//   `requireSignedIn` reads auth.readStoredJwt() — a property of the BOX — and
//   then calls next(). It never examines the caller at all. Its own error string
//   is `add_on_not_signed_in`. On a signed-in box every route it "protects" is
//   already open to any caller that can reach the socket, AND it fails closed on
//   an account-less box for operations that involve no account.
//
// This asks a question about the CALLER instead, and yields an identity to
// attribute the action to. Both are improvements; neither is a wall.
//
// ── WHY THIS IS NOT "identity used as a permission" ──────────────────────────
//
// `ingress-identity.js` closes with "this file returns identity and never a
// permission", and that rule is about DASHIE-ACCOUNT resources — household,
// credits, hosted engines. Those are someone else's money and still require a
// real signed JWT; nothing gated by THIS middleware touches them.
//
// What it guards is a service call on a Home Assistant entity, on the user's own
// box, that Home Assistant already exposes to that user. For that operation HA
// is the authority, and asking "do you hold a Dashie account" is an
// account-shaped gate on a non-account operation — the same mistake removed from
// the capability grant path (see capability.js). So the rule stands unamended
// and this lives on the other side of the line it draws.

'use strict';

const { ingressUser } = require('./ingress-identity');

/**
 * Express middleware. Attaches `req.haUser` and continues, or refuses 403.
 *
 * @param {string} what - short label for the log line, e.g. 'ha-service'.
 */
function requireIngressUser(what) {
    return function (req, res, next) {
        const user = ingressUser(req);
        if (!user) {
            // Standing rule 2: a refusal that says nothing is a refusal nobody
            // can diagnose. This one is reachable in normal operation (a direct
            // hit on the docker network, or a local dev run against the server),
            // so it names the route and stays greppable.
            console.warn(`DROP: ${what} refused — no HA ingress identity on the request`);
            return res.status(403).json({
                error: 'ingress_required',
                message: 'This endpoint is reachable only from the Home Assistant panel.',
            });
        }
        req.haUser = user;
        next();
    };
}

module.exports = { requireIngressUser };
