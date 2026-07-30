// ingress-identity.js — who Home Assistant says is making this request.
//
// Supervisor's ingress proxy authenticates the user against their HA session and
// then adds identifying headers to every request it forwards:
//
//   X-Ingress-Path              the documented ingress marker
//   X-Remote-User-Id            HA user id
//   X-Remote-User-Name          username — NOT guaranteed to be present
//   X-Remote-User-Display-Name  display name — also optional
//
// Music Assistant hit the missing-username case in the field (music-assistant/
// support#4851), so Id is the signal and the two name headers are decoration.
//
// TWO RULES about what this is for, because getting them backwards would be a
// security bug rather than a UI one:
//
//   1. It answers "has Home Assistant already authenticated this person?" For a
//      panel served over ingress the answer is yes. config.yaml keeps `ports: {}`
//      so the server is not reachable on the LAN to forge these against, and the
//      console API already trusts exactly this signal — see index.js's route map:
//      "CONSOLE (HA Ingress authenticates the user; no bridge secret)".
//
//   2. It is NOT authorization for a Chickadee ACCOUNT. It grants nothing
//      cloud-side: no household, no credits, no hosted engines. Those still need
//      a real signed JWT. All this decides is whether the UI has any business
//      showing a sign-in wall to someone who only wants their own local engines.
//
// Rule 2 is why this file returns identity and never a permission.

'use strict';

/** Read HA's ingress identity off a request. Returns null when the request did
 *  not arrive through ingress (direct hit on the internal docker network, or a
 *  local dev run against the server directly). */
function ingressUser(req) {
    const h = req && req.headers ? req.headers : {};
    const id = h['x-remote-user-id'];
    if (!id) return null;
    return {
        id: String(id),
        // Either may be absent; fall back through name → id so callers always
        // have something printable, and never render "undefined" at a user.
        name: h['x-remote-user-name'] ? String(h['x-remote-user-name']) : null,
        display_name: h['x-remote-user-display-name']
            ? String(h['x-remote-user-display-name'])
            : (h['x-remote-user-name'] ? String(h['x-remote-user-name']) : null),
    };
}

/** Did this request come through HA's ingress proxy? `X-Ingress-Path` is the
 *  documented marker; the user id covers proxies that set one but not the other. */
function isIngress(req) {
    const h = req && req.headers ? req.headers : {};
    return !!(h['x-ingress-path'] || h['x-remote-user-id']);
}

module.exports = { ingressUser, isIngress };
