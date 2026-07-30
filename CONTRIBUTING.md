# Contributing

Short version: **bug reports and feature requests are very welcome. Code
contributions are not being accepted yet.** Please read this before opening a
pull request, so a PR doesn't sit unmerged and waste your afternoon.

## Where the project is right now

Chickadee is in a small closed beta. The code moves fast, the add-on/console/
integration seams are still being redrawn, and parts of the tree are generated
by tooling that lives outside this repo (see
[PROVENANCE.md](PROVENANCE.md)) — so a hand-written patch to the wrong file
gets clobbered by the next release build rather than merged.

Until the beta ends and those seams settle, the maintainer is not accepting
external code. That's a capacity-and-churn decision, not a permanent policy.

## What genuinely helps right now

- **Bug reports** — [open an issue](../../issues/new/choose). Real-world HA
  setups are the thing we can't manufacture, and reports about them are the
  most useful contribution available today.
- **Feature requests**, including "this fights my setup" and "this assumption
  is wrong for me."
- **Design pushback** on the docs. If [PROVENANCE.md](PROVENANCE.md) or
  [PRIVACY.md](PRIVACY.md) doesn't answer a question you actually have, saying
  so is worth more than a patch.
- **Telling us what a patch *would* say.** An issue that describes the fix,
  with the file and the reasoning, is something the maintainer can act on
  immediately.

Integration issues (entities, config flow, pipeline setup) belong in
[dashie-voice-integration](https://github.com/jwlerch78/dashie-voice-integration/issues).

## If you want to send code anyway

Ask first in an issue. If we agree it should be a PR:

1. **Sign the [CLA](CLA.md)** — add your line to
   [CONTRIBUTORS.md](CONTRIBUTORS.md) in the PR. This is required for any code
   contribution, including a one-line fix.
2. **Don't edit generated trees.** `dashie-ha-dev/` and the vendored `integration/` trees are build
   output. Editing them is gated by a pre-commit hook; the change belongs
   upstream of the generator, which for some files means the private Dashie
   monorepo — say so in the issue and the maintainer will carry it across.
3. One logical change per PR, and say how you tested it on a real HA install.

## Why a CLA and not a DCO

A DCO would be friendlier, and we'd prefer it. It doesn't work here.

A DCO certifies that you had the right to submit your code. It does not grant
us the right to *run* your code in a service we don't publish the source of —
and Chickadee Cloud, the hosted convenience that funds this project, is exactly
that (the reasoning is in [PROVENANCE.md](PROVENANCE.md#what-chickadee-cloud-runs--and-what-isnt-published)).
Today the question doesn't arise: one author, sole copyright holder, and AGPL
binds licensees rather than the person granting the license. The first merged
outside patch changes that, silently, and the honest time to say so is before
it happens rather than after.

The CLA is Apache-ICLA-shaped: you keep your copyright, your code still ships
to everyone under AGPL-3.0, and you additionally license it to us broadly
enough that the funding model keeps working. We know CLAs put some people off.
That cost is real and we're choosing it over the alternative, which is finding
out mid-beta that a merged patch can't ship.

## License

By contributing you agree your contribution is licensed under
[AGPL-3.0](LICENSE) and under the terms of [CLA.md](CLA.md).
