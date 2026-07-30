# Brain source

This directory is the TypeScript source of `../voice-brain.bundle.js` — the
exact input set of the bundle (derived from the esbuild metafile), vendored on
every `sync-brain-bundle.sh` run, plus `types.ts` (type-only, so esbuild
erases it and it never shows up in the metafile) and the test files listed
below. The bundle is the build artifact; this is the source of truth it is
built from. Both are covered by the repository LICENSE.

Built by `build-node-brain.mjs` (esbuild, CJS, Node platform). The same core
runs unmodified as a Deno edge function in Dashie Cloud — the add-on injects
its own Node I/O layer.

## Tests

Run them with [Deno](https://deno.land/) (they use `std/assert`):

    deno test --allow-none voice-conversation/

13 test files ship here — the ones whose imports this directory fully
satisfies. They cover the parts where the behaviour is genuinely tricky:
routing decisions (`dialog-policy`, `parse`, `multi`), prompt assembly
(`prompt`, `personality`), the sports depth/slate logic, and argument
redaction.

**Not every test in the suite is here, and it's worth saying why.** The core's
full suite also covers the cloud I/O shell — the HTTP entry point, auth, the
Supabase client, metering, and the key-holding gateway proxies. Those modules
are not published (see the repo's PROVENANCE.md for what they are and why), so
their tests would arrive as files you could read but not run. Rather than pad
the count, the sync script vendors only what executes, and it fails the build
if any vendored file's imports don't resolve in this tree — so this stays true
rather than becoming true once.
