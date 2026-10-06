// SPDX-License-Identifier: AGPL-3.0-only
// server/api/freeform.js
// Render the Freeform prompt box through Home Assistant's own Jinja engine.
//
// Auth: requireIngressUser, the same gate /api/ha/control uses. The template
// runs inside HA with the add-on's token, so it can read any state the add-on
// can — `{{ states('switch.anything') }}` is a legitimate thing to write in
// this box, and is exactly what an HA user expects it to do. That makes the
// endpoint an HA read surface, so it takes the HA-user gate rather than the
// Dashie-account one: a box with no Dashie account still has HA users, and the
// prompt editor has to work there.
//
// ⚠️ This is NOT a general template proxy, even though that is what it looks
// like. It is the prompt editor's preview. If anything else ever needs to
// render a template, give it its own route with its own reason — a route named
// after a feature can be reasoned about, and `POST /api/template` with
// arbitrary bodies cannot.

const express = require('express');
const haClient = require('../ha-client');
const { requireIngressUser } = require('../require-ingress-user');

const router = express.Router();

/** A prompt is a prompt, not a document. Long enough for a thorough one,
 *  short enough that nobody pastes a novel into the model on every turn. */
const MAX_TEMPLATE = 16000;

/**
 * POST /api/freeform/render   { template, variables? }
 *   200 { rendered }
 *   400 { error }   — HA's own words for a bad template, passed through
 *
 * A Jinja error is a NORMAL outcome here, not a server fault: the user is
 * mid-edit and the template is wrong. It answers 400 with HA's message so the
 * editor can show it under the box, and deliberately does not log it as an
 * error — a console that logged every keystroke-in-progress would bury the
 * failures that matter.
 */
router.post('/render', requireIngressUser('freeform-render'), express.json({ limit: '64kb' }), async (req, res) => {
    const { template, variables } = req.body || {};
    if (typeof template !== 'string') return res.status(400).json({ error: 'template required' });
    if (template.length > MAX_TEMPLATE) {
        return res.status(400).json({ error: `Prompt is too long — ${template.length} characters, limit ${MAX_TEMPLATE}.` });
    }

    // Only our own namespaced variables are forwarded. A caller-supplied
    // `device_name` would SHADOW HA's own device_name() function and silently
    // break any template using it (measured 2026-10-03), so the allowlist is
    // the guard rather than a convention anyone has to remember.
    const safe = {};
    for (const [k, v] of Object.entries(variables || {})) {
        if (/^dashie_[a-z0-9_]+$/.test(k) && (typeof v === 'string' || typeof v === 'number')) safe[k] = v;
    }

    try {
        const out = await haClient.renderTemplate(template, safe);
        if (out.ok) return res.json({ rendered: out.rendered });
        return res.status(400).json({ error: out.error });
    } catch (e) {
        // This branch is HA being unreachable or unconfigured — a real fault,
        // and distinct from the template being wrong. Say which, or the user
        // spends their time rewriting a template that was never the problem.
        console.warn(`[api/freeform] render failed: ${e.message}`);
        return res.status(502).json({ error: `Home Assistant did not answer: ${e.message}` });
    }
});

module.exports = router;
