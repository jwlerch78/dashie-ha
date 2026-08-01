// SPDX-License-Identifier: AGPL-3.0-only
// js/lib/provider-auth-renderers.js
//
// One renderer per AUTH SHAPE, not per provider. Every provider here shares one
// of two shapes, and dispatching on shape is what keeps adding a provider a
// one-line manifest entry instead of a new branch in a growing if/else.
//
// The registry is open: `register(shape, fn)` lets a build that ships additional
// providers add a shape at runtime. That matters because not every way of
// configuring a provider is a text box, and a registry that assumed one would
// have to be unpicked rather than extended.
//
// 🔴 What must never appear here
//
// No price, balance, credit meter, quota readout or purchase affordance, for any
// shape. This console reports connection STATE. Where money happens is the
// provider's own account page, reachable by a plain link. A renderer is the
// natural place for a balance widget to appear "just for convenience", so the
// prohibition lives here rather than only in a plan document.

(function () {
    'use strict';

    const { AUTH, ADAPTER } = window.ProviderManifest;

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /**
     * The state line under a provider.
     *
     * 🔴 Three states, not two. "Key stored" is NOT "working": until a
     * provider's on-box adapter ships, a stored key is exactly that — stored.
     * Reporting it as working would be the console asserting a capability
     * nobody observed, and it is the specific bug the 5b boundary exists to
     * prevent (a tester pastes a key, sees "connected", and search does
     * nothing).
     */
    function statusLine(provider, configured, opts) {
        const { AUTH } = window.ProviderManifest;
        const o = opts || {};

        // A credential that CAN expire and HAS is not "configured" — it is
        // broken in a way the user has to act on, and it must not read the same
        // as working. Nothing sets this yet: every credential in this build is a
        // pasted key that stays valid until revoked. The state exists so that if
        // one ever isn't, it has somewhere to land instead of being retrofitted
        // through every call site.
        if (configured && provider.credential && provider.credential.expires && o.expired) {
            return '<span class="pm-state pm-state--expired">Credential expired — needs updating</span>';
        }
        if (provider.auth === AUTH.NONE) {
            return '<span class="pm-state pm-state--ok">Ready — nothing to configure</span>';
        }
        if (!configured) return '<span class="pm-state pm-state--unset">Not configured</span>';
        if (provider.adapter === ADAPTER.PENDING) {
            return '<span class="pm-state pm-state--stored">Key stored — not in use yet</span>';
        }
        return '<span class="pm-state pm-state--ok">Configured</span>';
    }

    function keySourceLine(provider) {
        const src = provider.keySource || {};
        if (!src.url && !src.free) return '';
        const free = src.free ? `<span class="pm-free">${esc(src.free)}</span>` : '';
        const link = src.url
            ? `<a class="pm-getkey" href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">Get a key</a>`
            : '';
        return `<div class="pm-source">${link}${free}</div>`;
    }

    const RENDERERS = {
        /** Nothing to configure. Present so "no config" is a shape, not a gap. */
        [AUTH.NONE](provider, ctx) {
            const why = provider.note ? `<p class="pm-none">${esc(provider.note)}</p>` : '';
            return `<div class="pm-body">${why}</div>`;
        },

        /** One or more text inputs. Multi-field is normal — Bedrock needs three. */
        [AUTH.API_KEY](provider, ctx) {
            const fields = (provider.fields || []).map(f => `
                <label class="pm-field">
                    <span class="pm-label">${esc(f.label)}</span>
                    <input type="${f.secret ? 'password' : 'text'}"
                           id="pm-${esc(provider.id)}-${esc(f.id)}"
                           data-provider="${esc(provider.id)}" data-field="${esc(f.id)}"
                           placeholder="${esc(f.placeholder || '')}"
                           autocomplete="off" spellcheck="false">
                </label>`).join('');
            return `<div class="pm-body">${fields}${keySourceLine(provider)}</div>`;
        },

    };

    /**
     * Register a renderer for an auth shape this file does not define.
     *
     * The extension point exists so a build with more provider kinds does not
     * have to fork this file or special-case inside an existing renderer —
     * either of which turns "one renderer per shape" back into the if/else it
     * replaced. Refuses to overwrite, so two registrations of the same shape is
     * a loud conflict rather than a last-one-wins surprise.
     */
    function register(shape, fn) {
        if (!shape || typeof fn !== 'function') {
            console.warn('DROP: register() needs a shape and a function.');
            return;
        }
        if (Object.prototype.hasOwnProperty.call(RENDERERS, shape)) {
            console.warn(`DROP: a renderer for auth shape '${shape}' is already ` +
                `registered — refusing to replace it.`);
            return;
        }
        RENDERERS[shape] = fn;
    }

    // Every declared auth shape must have a renderer. A computed key built from
    // a constant that was later renamed silently becomes the string "undefined"
    // and registers a renderer nothing can ever reach — that happened once here,
    // and no test noticed because the fallback still failed loudly, just with the
    // wrong message. This turns it into a boot-time complaint.
    for (const shape of Object.values(AUTH)) {
        if (!Object.prototype.hasOwnProperty.call(RENDERERS, shape)) {
            console.warn(`DROP: auth shape '${shape}' is declared in ` +
                `provider-manifest.js but has no renderer registered here.`);
        }
    }
    if (Object.prototype.hasOwnProperty.call(RENDERERS, 'undefined')) {
        console.warn('DROP: a renderer is registered under the key "undefined" — ' +
            'a computed [AUTH.X] key references a constant that no longer exists.');
    }

    /**
     * Render one provider's configuration body.
     * An unknown shape is a loud drop, never an empty div.
     */
    function render(provider, ctx) {
        const fn = RENDERERS[provider.auth];
        if (!fn) {
            console.warn(
                `DROP: unknown auth shape '${provider.auth}' for provider '${provider.id}' — ` +
                `no renderer registered. Add one to provider-auth-renderers.js.`);
            return `<div class="pm-body"><p class="pm-error">` +
                `This provider can’t be configured by this version of the add-on.</p></div>`;
        }
        return fn(provider, ctx || {});
    }

    function isSupported(provider) {
        return Object.prototype.hasOwnProperty.call(RENDERERS, provider.auth);
    }

    window.ProviderAuthRenderers = { render, register, isSupported, statusLine, keySourceLine, esc };
})();
