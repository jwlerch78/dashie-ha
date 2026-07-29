# Vendored third-party libraries

Libraries the console needs, committed here instead of loaded from a CDN.

## Why not a CDN

The console is an **add-on panel**. Three reasons a `<script src="https://cdn…">`
is the wrong call for one:

1. **Privacy.** PRIVACY.md promises that in local mode nothing leaves your
   network. A CDN tag breaks that on every page load — your browser hands a
   third party your IP, User-Agent, and referrer just to render the settings
   page. Whether or not the CDN logs it, the request happened, and the promise
   was ours to keep.
2. **It has to work offline.** Plenty of Home Assistant boxes are deliberately
   air-gapped or on networks that block outbound requests. A panel that needs
   the public internet to draw itself is broken on those boxes, and broken in a
   confusing way — a blank page, not an error.
3. **You should be running the code in this repo.** The previous tag was
   `@supabase/supabase-js@2` — an unpinned major range. Whatever the CDN
   resolved to that day executed with full console privileges, and it wasn't
   auditable from here. jsDelivr's own generated-file header even says not to
   use subresource integrity with those URLs, so there was no way to pin it
   with a hash either.

## What's here

| File | Upstream | License |
|---|---|---|
| `supabase-js-2.111.0.min.js` | [`@supabase/supabase-js@2.111.0`](https://github.com/supabase/supabase-js) UMD build, from `cdn.jsdelivr.net/npm/@supabase/supabase-js@2.111.0/dist/umd/supabase.js` | MIT |

The version is in the filename on purpose: it makes upgrades explicit in a
diff, and it cache-busts itself without a `?v=` query param.

## Updating

Download the exact version, drop it in, update the `<script src>` in
`../index.html` and `../login/index.html`, and update the table above:

    curl -sSLo supabase-js-<VER>.min.js \
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@<VER>/dist/umd/supabase.js"

Then delete the old file. Don't leave both — an unreferenced copy of a
JavaScript library in a repo is a question nobody wants to answer later.

## Still loaded from a CDN (known, being moved)

`../index.html` still pulls **hls.js** and **heic2any** from jsDelivr. Neither
is used by anything in this repo: they serve the video-feed and photo-upload
pages of the closed Dashie build that vendors this console as its core (see
PROVENANCE.md). They belong in that build's delta block, not in shared
`index.html`, and moving them is a change in both trees at once — tracked, not
forgotten. Until then, opening the console panel makes two third-party requests
for features the open build does not have, and that is worth knowing rather
than discovering.
