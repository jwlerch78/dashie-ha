// SPDX-License-Identifier: AGPL-3.0-only
// js/lib/provider-auth-renderers.js
//
// One renderer per AUTH SHAPE, not per provider. Eleven providers share three
// shapes, and dispatching on shape is what keeps adding a provider a one-line
// manifest entry instead of a new branch in a growing if/else.
//
// The registry is also the extension point. A hosted engine option — if one is
// ever offered — is a `device-flow` provider: sign in to a third party, receive
// a token. That is a genuinely different interaction from a text field, not a
// variant of one, which is precisely why this file dispatches on shape.
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
    function statusLine(provider, configured) {
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
            return `<div class="pm-body"><p class="pm-none">Works without configuration.</p></div>`;
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

        /**
         * Sign in to a third party and receive a token.
         *
         * DECLARED AND DELIBERATELY UNBUILT. There is no provider using it, and
         * building a flow with no consumer is speculative generality — the shape
         * of the eventual token exchange is not knowable from here.
         *
         * It is registered rather than omitted so the seam stays visible, and it
         * fails LOUDLY rather than rendering an empty card, because a silently
         * blank provider is the drop this codebase keeps getting bitten by. If
         * you are reading this because you saw the DROP: line, you are the
         * person who should implement it.
         */
        [AUTH.DEVICE_FLOW](provider, ctx) {
            console.warn(
                `DROP: no renderer for auth shape 'device-flow' (provider '${provider.id}'). ` +
                `The shape is declared in provider-manifest.js and intentionally not ` +
                `implemented — no provider used it when it was written. Implement it here; ` +
                `do not special-case it inside another renderer.`);
            return `<div class="pm-body"><p class="pm-error">` +
                `This sign-in method isn’t supported by this version. ` +
                `Update the add-on, or choose a provider that uses an API key.</p></div>`;
        },
    };

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

    window.ProviderAuthRenderers = { render, isSupported, statusLine, keySourceLine, esc };
})();
