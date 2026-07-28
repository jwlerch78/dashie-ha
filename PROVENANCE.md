# Provenance — who builds Chickadee, and how it relates to Dashie

Chickadee is built and operated by the maker of
[Dashie](https://dashieapp.com), a (closed-source, commercial) family
dashboard for Home Assistant. This page states the relationship plainly so
you don't have to reverse-engineer it from the code.

## The split

**Chickadee** is the open core: the voice/AI pipeline — add-on, console,
brain runtime, and HA integration — licensed AGPL-3.0. Every capability
works fully self-hosted with your own engines and keys, forever.

**Dashie** is a closed product built *on top of* this open core: family
dashboard clients (tablets/TVs) whose private console pages (calendar,
photos, chores, subscriptions) overlay the open console.

The money flow is the [Nabu Casa](https://www.nabucasa.com/) shape:
the open project is funded by an optional hosted convenience —
**Chickadee Cloud**, metered credits, no subscription — plus the separate
Dashie product. Nothing in Chickadee is feature-gated on paying.

## Where each piece is developed

| Piece | Canonical home | Notes |
|---|---|---|
| Add-on server + brain runtime | this repo (`chickadee/server/`) | The brain core (`server/brain/`) is a generated bundle **with its TypeScript source vendored alongside**; the generator lives in the Dashie monorepo, where the same core is built for Dashie's clients |
| Console SPA | this repo (`chickadee/frontend/console/`) — **canonical since 2026-07-27** | The Dashie build vendors this core and overlays its private pages (a "delta"). The empty `DELTA-SCRIPTS` block in `index.html` is that seam. Historical note: before 2026-07-27 the direction was reversed (the console was vendored *from* Dashie's private repo) — the inversion made the public repo the source of truth |
| HA integration | [chickadee-integration](https://github.com/jwlerch78/chickadee-integration) | Vendored into the add-on image at release (the add-on's auto-installer ships it); also installable via HACS |

## Why some identifiers say "dashie"

Chickadee shares its account/billing backend with Dashie (one account
system — a Chickadee account is the same account a Dashie user has, minus
the family-product data). Because shipped Dashie apps already speak this
protocol, several **wire values keep the `dashie` name for compatibility**:
the `dashie_cloud` engine id, some `/api/dashie/voice/*` HTTP routes served
for Dashie satellite devices, localStorage keys, and `dashie-*` CSS class
names. These are compatibility contracts, not hidden branding — display
identity is centralized in `js/lib/brand.js`.

## Development style

This project moved fast on top of a mature codebase (Dashie's voice stack,
in production on real households since 2025) and is heavily AI-assisted,
human-reviewed. The public history starts 2026-07-25 because that's when
the repos were split out and opened — not when the code was born.

Questions about any of this: open an issue, or hello@getchickadee.org.
