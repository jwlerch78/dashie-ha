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

## What Chickadee Cloud runs — and what isn't published

Chickadee Cloud is a paid hosted service, and this repo is AGPL. That
combination deserves a straight answer rather than a shrug, so here it is.

**What the cloud runs: the same brain core that's in this repo.** The
orchestrator, prompt builder, templates, dialog policy, parsers, and tool
implementations under `chickadee/server/brain/src/` are the literal input set
of the bundle the add-on runs, and the cloud runs those same modules with a
different I/O shell injected into the one `OrchestratorIO` seam. You can see
that seam from here: `chickadee/server/brain/chickadee-io.js` is the add-on's
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
`chickadee-io.js` disables the metered tools and says so in its header comment.

**Why this isn't an AGPL §13 dodge.** §13, the network-use clause, exists
specifically to close the "run it as a service, publish nothing" gap that GPL
leaves open, so picking AGPL and then running a hosted service on unpublished
code is a fair thing to interrogate. Two answers, and the first is the real
one:

- **We are the sole copyright holder.** AGPL is a license we *grant*; it does
  not bind us for our own code. A copyright holder may run a private, modified
  build of their own program as a service and owes nobody source. That is the
  same position MongoDB, Elastic, Grafana, and Sentry occupy. It isn't a
  loophole in AGPL — it's how copyright works, and §13 was never aimed at the
  author.
- **Independently, none of the withheld code would help you self-host.** Every
  piece above is a binding to *our* Supabase project, *our* billing tables, or
  *our* vendor keys. The add-on ships its own equivalent of each, in this repo,
  and those are the ones you'd actually run. Publishing our HTTP shell would
  give you a file you'd delete.

**If that ever stops being true, we'll say so.** The sole-copyright-holder
answer has an expiry date: the first time outside code lands in this repo, it
reaches us under AGPL like everyone else's, and a cloud build containing a
modified version of it *would* carry §13 obligations. That's why
[CONTRIBUTING.md](CONTRIBUTING.md) and [CLA.md](CLA.md) exist and why the CLA
is a broad-grant CLA rather than a DCO — a DCO wouldn't cover it, and the
honest time to work that out is before a merge, not after.

**The Nabu Casa parallel, stated precisely.** The *funding model* is Nabu
Casa's: an open project, an optional paid hosted convenience, nothing
feature-gated on paying. The *licenses* differ, and it's worth stating rather
than letting someone catch it — Home Assistant is Apache-2.0 with a closed
Nabu Casa backend; we chose the more restrictive copyleft for the open part.
That makes withheld glue more conspicuous, not less. We'd still rather have it
that way than a permissive license that lets anyone — us included — close the
core later.

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

One `dashie` name is deliberately **user-facing**, and it isn't a wire value:
the **`hey_dashie` wake word**. Chickadee ships two custom microWakeWord
models — `chickadee` and `hey_dashie` — and offers them in the same picker as
the community words (Okay Nabu, Hey Jarvis, Alexa). Shipping a wake word
named after a product is the ecosystem norm, not a funnel: openWakeWord ships
`alexa` and `hey_mycroft`, microWakeWord ships `okay_nabu`. `hey_dashie` is
there so Dashie satellites work out of the box; nothing selects it for you
(the default on this build is `chickadee`), and picking it changes nothing
about where your audio goes. Its manifest credits Dashie as the model's
author because Dashie trained it — attribution, not advertising.

### What that means for this repo's history

Say the quiet part: this repo is an **extraction from a commercial codebase**,
not a clean-room build. Until 2026-07-27 the console tree here still contained
Dashie's subscription/paywall modules and its family-product pages, and they
were removed in a single commit (`ea2f9d3`, "REPO INVERSION"), with the Dashie
logo assets going in `59167e6`. Git keeps deleted content, so all of it is
still recoverable from this repo's history — `git show
ea2f9d3^:chickadee/frontend/console/js/lib/subscribe-gate.js` works, and we're
not going to rewrite history to hide that.

Nothing sensitive is in there: a full-history secret scan finds only the two
Supabase **anon** keys that are public by design. What's in there is the fact
above — that the open project was made by subtraction. That's how open-core
extractions look, and it's the same shape Nabu Casa's is; we'd rather you read
it here than discover it and wonder what else wasn't said.

The maintainer's own HA hostname also appears in early history (scrubbed at
HEAD in `a5e36b6` in favor of a `CHICKADEE_HA_HOST` env var). It's a
Cloudflare-fronted address with no credential attached, so the scrub was
hygiene, not damage control.

## Known Dashie residue (being generalized)

Full candor about what's still Dashie-shaped in the current beta:

- **The assistant's built-in help knowledge base** (`dashie_help` tool,
  `server/brain/src/_shared/tools/dashie-kb.generated.ts`) currently covers
  the Dashie app family — ask the assistant for product help and some
  answers describe Dashie features. It's 67 chunks, including questions like
  "How is Dashie different from Fully Kiosk Browser?" and "How do chores
  work?". It's generated from the shared docs pipeline and is on the list to
  generalize per-brand.
- **The base system prompt is still Dashie-shaped, in every mode** —
  including a fully local, account-less one. `server/brain/src/
  voice-conversation/templates.ts` opens with "You are {{ASSISTANT_NAME}},
  the voice assistant for a family dashboard — calendar, photos, weather,
  chores, timers, and smart-home control" (the name is substituted, and is
  "Chickadee" here), and instructs the model to suggest emailing
  **support@dashieapp.com** when it can't answer. So a self-hosted user
  running Ollama can be pointed at a commercial product's support address by
  their own local model. Same root cause as the KB above — one shared prompt
  core — and on the same list. Until then it's worth knowing the prompt you
  are running; it's readable at that path, and in the shipped
  `voice-brain.bundle.js`.
- **The image-search tool** hardcodes a Dashie logo URL and a `photographer:
  'Dashie'` attribution for its own-brand result
  (`_shared/tools/image_search.ts`).
- **`scripts/check-console-tree.sh`** (wired into `release.sh`) is a release
  gate whose job is proving the Dashie delta hasn't leaked back into this
  tree: it fails the release if any module on a hardcoded list of private
  paths appears (28 of them today), or if
  the tree contains paywall strings it greps for by phrase ("trial has
  ended", "Subscribe to unlock", "Manage Subscription", …). It exists because
  the console is shared source with a commercial build, and it is the
  mechanism that keeps this repo free of that build's commerce. Named here
  because a gate that scrubs subscription phrases out of an "open" tree
  should be something you read about in the disclosure, not something you
  find in `scripts/`.
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
  [chickadee-integration/CONTRACTS.md](https://github.com/jwlerch78/chickadee-integration/blob/main/CONTRACTS.md)
  (see this repo's `CONTRACTS.md` pointer).

## Development style

This project moved fast on top of a mature codebase (Dashie's voice stack,
in production on real households since 2025) and is heavily AI-assisted,
human-reviewed. The public history starts 2026-07-25 because that's when
the repos were split out and opened — not when the code was born.

Questions about any of this: open an issue, or hello@getchickadee.org.
