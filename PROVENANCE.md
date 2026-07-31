# Provenance — what this repo is, and how it relates to the rest of Dashie

This is **Dashie for Home Assistant**, built and operated by the maker of
[Dashie](https://dashieapp.com). One product, two editions — this page states
the relationship plainly so you don't have to reverse-engineer it from the code.

Until 2026-07-30 this repo carried a second brand name, "Chickadee", and was
framed as an open core with Dashie as a closed product on top. That framing is
retired. The brand is gone; the **boundary it described is unchanged** — the same
code is published, the same code is withheld, on the same seam. Only the name and
the story about it moved. Git history still says Chickadee throughout, and it is
left that way deliberately: the disclosure trail below depends on that history
being intact and unrewritten.

## The two editions

**Dashie for Home Assistant** — this repo. The voice/AI pipeline: add-on,
console, brain runtime, and the HA integration. Every capability works fully
self-hosted, with your own engines and your own keys, forever. No account is
required for any of it.

**Dashie** (the family product) — tablet/TV dashboard clients whose private
console pages (calendar, photos, chores, family, subscriptions) overlay this
console as a **delta**. Those pages are not published. In this build they are
not hidden — they are **absent**, and a release gate proves it (see
`scripts/check-console-tree.sh`, and `dashie-ha/frontend/console/CONSOLE_ISOLATION.md`
for the full set of invariants).

The money flow is the [Nabu Casa](https://www.nabucasa.com/) shape: the free
edition is funded by an optional hosted convenience — **Dashie Cloud**, metered
credits, no subscription — plus the separate paid family product. **Nothing in
this edition is feature-gated on paying.**

## What Dashie Cloud runs — and what isn't published

Dashie Cloud is a paid hosted service and this repo is published source. That
combination deserves a straight answer rather than a shrug, so here it is.

**What the cloud runs: the same brain core that's in this repo.** The
orchestrator, prompt builder, templates, dialog policy, parsers, and tool
implementations under `dashie-ha/server/brain/src/` are the literal input set
of the bundle the add-on runs, and the cloud runs those same modules with a
different I/O shell injected into the one `OrchestratorIO` seam. You can see
that seam from here: `dashie-ha/server/brain/addon-io.js` is the add-on's
shell. The cloud has an equivalent one, and that shell is the difference.

**What isn't published: the cloud's deployment glue and its key-holding
proxies.** Concretely, four things —

1. **The HTTP entry point.** Deno `serve`, CORS headers, a `?warmup` ping that
   boots the isolate on wake-word, and the NDJSON streaming wrapper that emits
   stage events. About 95 lines whose entire job is turning a POST into a call
   to the published orchestrator.
2. **Auth and DB access.** JWT verification against our Supabase project, and
   a service-role client used to read personality/config rows.
3. **Metering and billing.** Credit pre-flight, per-turn debit from real
   API-returned token counts, rate limiting, and the interaction/usage log
   writes.
4. **The third-party gateways our published tools call** — `ai-gateway`,
   `web-search-gateway`, `serper-image-search`, `sports-gateway`. These hold
   our vendor API keys, which is the whole reason they're separate functions.

That last one has a visible consequence worth naming: some published tools are
clients of unpublished proxies. `_shared/tools/image_search.ts` and
`_shared/tools/sports.ts` POST to endpoints that exist only in our cloud. On
the self-hosted path those tools are **off**, not silently proxied through us —
`addon-io.js` disables the metered tools and says so in its header comment.

**That refusal is now tested, not just asserted.** It was probed adversarially
on 2026-07-30 with a stub endpoint returning brain-shaped responses that
*demand* each metered tool — a stronger instrument than a real model, which only
tests whether it happens to *ask*. Sports and web search refused structurally.
Image search **did not**: a caller sending `retrieve_pictures: true` could
re-enable it, because the request override beats the account default by design
and the self-hosted shell's spend check fails open so that a bring-your-own-key
turn can run. The call missed our servers only by accident — an unset base URL
made it throw at parse, before DNS or any socket. **Nothing leaked, and the
local-mode claim in [PRIVACY.md](PRIVACY.md) was never false**, but the refusal
was an accident rather than a decision. It is now an explicit flag on the
self-hosted shell, with regression tests, one of which was confirmed to fail
without the fix. Still owed: the same probes driven on a real HA box.

**On licensing.** The terms that apply are whatever [LICENSE](LICENSE) says;
that file is authoritative and this page is not a licence. Earlier versions of
this document argued at length for a particular licence choice as part of the
open-core story. That argument is withdrawn along with the story — it was
reasoning about a two-brand structure that no longer exists, and licence
lawyering is not what this page is for.

**What does not depend on the licence is the boundary above.** Published is
published; the four withheld items are withheld; the seam between them is a
single named interface you can read. If that ever changes, this page changes with
it — the commitment here is disclosure, not a specific licence.

**One claim on this page rests on trust.** "The cloud runs the same core" is
not currently verifiable from outside. The bundle header and
`voice-brain.bundle.meta.json` cite source SHA `dda157e0d`, but that commit
lives in a private monorepo, so there is no public object to diff against.
We state it because it's true, not because you can check it. If that bothers
you, open an issue and say so — reproducible-build metadata is the obvious
fix and we'd rather be pushed into it than assumed trustworthy.

## Where each piece is developed

| Piece | Canonical home | Notes |
|---|---|---|
| Add-on server + brain runtime | this repo (`dashie-ha/server/`) | The brain core (`server/brain/`) is a generated bundle **with its TypeScript source vendored alongside**; the generator lives in the Dashie monorepo, where the same core is built for the family edition's clients |
| Console SPA | this repo (`dashie-ha/frontend/console/`) — **canonical since 2026-07-27** | The family build vendors this core and overlays its private pages (the "delta"). The empty `DELTA-SCRIPTS` block in `index.html` is that seam. Historical note: before 2026-07-27 the direction was reversed (the console was vendored *from* the private repo) — the inversion made this repo the source of truth |
| HA integration | [dashie-voice-integration](https://github.com/jwlerch78/dashie-voice-integration) | Vendored into the add-on image at release (the add-on's auto-installer ships it); also installable via HACS |

## Why identifiers, wake words and support links all say "dashie"

Because it is all one product now. This is worth a heading only because it used
to require an explanation: two brands sharing one account system meant a pile of
`dashie`-named wire values inside a differently-named project. One brand makes
most of that unremarkable.

Two things are still worth knowing:

- **Some wire values are compatibility contracts, not branding.** The
  `dashie_cloud` engine id, the `/api/dashie/voice/*` HTTP routes served for
  Dashie satellite devices, localStorage keys, and `dashie-*` CSS class names
  are spoken by shipped apps in the field and cannot be renamed unilaterally.
  Display identity is centralized in `js/lib/brand.js`.
- **One wake word is named `chickadee`.** It is a real trained microWakeWord
  model from the previous brand, still shipped and still selectable — it simply
  isn't any build's default (`hey_dashie` is, on every build since 2026-07-30).
  It stays because the id keys the model file and is persisted on devices that
  chose it; renaming it would stop those devices waking. Shipping wake words
  named after products is the ecosystem norm — openWakeWord ships `alexa` and
  `hey_mycroft`, microWakeWord ships `okay_nabu`. Nothing selects one for you,
  and picking either changes nothing about where your audio goes. The
  `hey_dashie` manifest credits Dashie as the model's author because Dashie
  trained it — attribution, not advertising.

### What that means for this repo's history

Say the quiet part: this repo is an **extraction from a commercial codebase**,
not a clean-room build. Until 2026-07-27 the console tree here still contained
the family edition's subscription/paywall modules and its family-product pages,
and they were removed in a single commit (`ea2f9d3`, "REPO INVERSION"), with the
logo assets going in `59167e6`. Git keeps deleted content, so all of it is still
recoverable from this repo's history — the tree was named `chickadee/` at that
commit, so `git show "ea2f9d3^:chickadee/frontend/console/js/lib/subscribe-gate.js"`
works — and we're not going to rewrite history to hide that.

Nothing sensitive is in there: a full-history secret scan finds only the two
Supabase **anon** keys that are public by design. What's in there is the fact
above — that the published edition was made by subtraction. That is how these
extractions look, and it is the same shape Nabu Casa's is; we'd rather you read
it here than discover it and wonder what else wasn't said.

The maintainer's own HA hostname also appears in early history (scrubbed at
HEAD in `a5e36b6` in favor of a `DASHIE_HA_HOST` env var). It's a
Cloudflare-fronted address with no credential attached, so the scrub was
hygiene, not damage control.

## Where the family edition still shows through

Full candor about what is still shaped by the family product in the current
beta. Under one brand these are less strange than they were under two — a shared
core that names the shared product is expected — but a self-hosted user is
entitled to know which parts of what they're running were written for someone
else's use case:

- **The assistant's built-in help knowledge base** (`dashie_help` tool,
  `server/brain/src/_shared/tools/dashie-kb.generated.ts`) currently covers
  the whole Dashie app family — ask the assistant for product help and some
  answers describe family-edition features you don't have. It's 67 chunks,
  including questions like "How is Dashie different from Fully Kiosk Browser?"
  and "How do chores work?". It's generated from the shared docs pipeline and
  is on the list to scope per edition.
- **The base system prompt is written for the family product, in every mode** —
  including a fully local, account-less one. `server/brain/src/
  voice-conversation/templates.ts` opens with "You are {{ASSISTANT_NAME}},
  the voice assistant for a family dashboard — calendar, photos, weather,
  chores, timers, and smart-home control", and instructs the model to suggest
  emailing **support@dashieapp.com** when it can't answer. So a self-hosted user
  running Ollama can be pointed at our support address by their own local model.
  That is now the correct address for this software rather than a different
  company's, which is most of what used to be wrong with it — but being told to
  email us about software you are running yourself is still presumptuous, and
  it's on the list. Meanwhile it's worth knowing the prompt you are running:
  it's readable at that path, and in the shipped `voice-brain.bundle.js`.
- **The image-search tool** hardcodes a Dashie logo URL and a `photographer:
  'Dashie'` attribution for its own-brand result
  (`_shared/tools/image_search.ts`).
- **`scripts/check-console-tree.sh`** (wired into `release.sh`) is a release
  gate whose job is proving the closed family delta hasn't leaked back into this
  tree: it fails the release if any module on a hardcoded list of private paths
  appears (28 of them today), or if the tree contains paywall strings it greps
  for by phrase ("trial has ended", "Subscribe to unlock", "Manage
  Subscription", …). Since 2026-07-30 it also **executes** the console's feature
  gate to prove that family-only *options* — not just whole pages — are
  unreachable here, because string checks cannot see a runtime branch. It exists
  because this console is shared source with a commercial build, and it is the
  mechanism that keeps this repo free of that build's commerce. Named here
  because a gate that scrubs subscription phrases out of a published tree should
  be something you read about in the disclosure, not something you find in
  `scripts/`.
- **Generated files** (headers say `AUTO-GENERATED`): several console lib
  files and the brain bundle are built by the shared tooling in the private
  Dashie monorepo. Their vendored output here is the readable source you
  run; comments inside them may reference that private repo's paths and
  internal docs (`.reference/…`, build plans). Those pointers are honest
  breadcrumbs, not missing pieces of this codebase.
- **Hermes** (the optional BYO-brain companion add-on offered in the
  console) currently installs from the Dashie add-on repository
  (`dashie-ha-app`) — dual-listing it in this repo is planned.
- Cross-boundary contracts are registered in
  [dashie-voice-integration/CONTRACTS.md](https://github.com/jwlerch78/dashie-voice-integration/blob/main/CONTRACTS.md)
  (see this repo's `CONTRACTS.md` pointer).

## Development style

This project moved fast on top of a mature codebase (Dashie's voice stack,
in production on real households since 2025) and is heavily AI-assisted,
human-reviewed. The public history starts 2026-07-25 because that's when
the repos were split out and opened — not when the code was born.

Questions about any of this: open an issue, or support@dashieapp.com.
