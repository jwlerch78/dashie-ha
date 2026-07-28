# Brain source

This directory is the TypeScript source of `../voice-brain.bundle.js` — the
exact input set of the bundle (derived from the esbuild metafile), vendored on
every `sync-brain-bundle.sh` run. The bundle is the build artifact; this is
the source of truth it is built from. Both are covered by the repository
LICENSE.

Built by `build-node-brain.mjs` (esbuild, CJS, Node platform). The same core
runs unmodified as a Deno edge function in Dashie Cloud — the add-on injects
its own Node I/O layer.
