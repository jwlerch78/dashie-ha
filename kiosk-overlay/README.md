# kiosk-overlay

The Home-Assistant-facing web layer that runs inside the Dashie Android app —
the HA dashboard host, the kiosk shell, the overlays, and the settings UI the
tablet shows on top of your Home Assistant dashboards.

## This is published to be read, not built

It is here because it is the part of the tablet app an HA user would actually
want to inspect: what it talks to, what it stores, what it renders.

**It will not build on its own.** The bundles are produced from this directory
*plus* parts of Dashie's private app tree — `build.js` aliases `@dashie/config`
to a `config.js` outside this directory, and a dozen source files import from
`../js/...`. Those are not published, so `node build.js` here will fail on
missing imports. That is expected, not an oversight.

`dist/` (the built bundles) is deliberately excluded — build output,
reproducible from source, and it would dominate every diff.

The honest summary, also in the repository README: **the add-on is genuinely
self-hostable; the tablet app is not.** What this directory offers is
inspectability — you can read what the app does on your network — not
independence.

## Canonical source

This is a synced copy. It is developed in Dashie's private app repo and pushed
here by `sync-kiosk-overlay-public.sh`, which secret-scans before it writes and
has a drift check on the other side. Corrections are welcome as issues; pull
requests against this directory cannot be merged (see CONTRIBUTING.md).
