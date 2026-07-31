# Console isolation — one core, two editions

This console is shared source. It ships in two editions, and the whole point of
the machinery below is that the closed half can never leak into the published
half. Read this before touching `js/lib/feature-gate.js`, `js/lib/brand.js`, or
the `DELTA-SCRIPTS` block in `index.html`.

```
PUBLISHED CORE  (inspectable — this tree)
  console shell · voice/AI · engine routing · HA config · brain + tests
        │ vendored downstream (never upstream)
        ▼
CLOSED FAMILY DELTA  (calendar, chores, family, rewards, locations,
                      photos, video-feeds, preferences)
        ├── Dashie Console add-on (full)  → HA users with a Dashie account
        └── web console                   → consumer families
```

Until 2026-07-30 this boundary was cut on a **brand** axis (Chickadee vs
Dashie). It is the same boundary; it is now named for what it actually is — an
**edition** axis. Nothing about the mechanism changed.

## The four mechanisms

| Mechanism | Where | Role |
|---|---|---|
| `BRAND.build` (`'published'` \| `'full'`) | `js/lib/brand.js`, one per edition | the single bit distinguishing builds |
| `FeatureGate.CLOSED_DELTA_PAGES` | `js/lib/feature-gate.js` | enumerates the closed delta |
| `DELTA-SCRIPTS` block | `index.html` | the seam where the full build injects its private pages |
| vendoring direction | published repo is canonical since 2026-07-27 | the family console vendors this core and overlays its delta |

## Two grains of gating

`CLOSED_DELTA_PAGES` removes whole pages. Since 2026-07-30 there is also
`FAMILY_ONLY_OPTIONS`, which removes individual **options** from sections that
belong in both editions — the case publishing the Devices pages surfaced:

| Setting | Published build |
|---|---|
| `display.themeFamily` | whole control hidden (seasonal families are family-only) |
| `display.layoutMode` | `widgets` dropped — that option *is* the family dashboard |
| `photos.sourceType` | `supabase` (cloud albums) and `google_drive` dropped |

`google_drive` is worth its own note: it needs the Google **Drive** OAuth scope,
and the HA edition's sign-in brand (`dashie_ha`) requests identity only. So it is
not merely withheld — it could not work here. If that scope decision is ever
revisited, this option comes back with it.

Applied at the two chokepoints rather than per caller: `renderPickerModal()`
filters every picker by `category.key`, and `_photoSourceOptions()` filters the
source list. A new picker is gated automatically.

## Invariants

- **I1 — No family page source in the published tree.** Every name in
  `CLOSED_DELTA_PAGES` must have no page module here. Not hidden: **absent**.
- **I2 — The published build's `DELTA-SCRIPTS` block stays empty.**
- **I3 — No published code path requires an account.** Ingress identity is
  *identity, never authorization* (`server/ingress-identity.js`); it grants
  nothing cloud-side.
- **I4 — No published code path calls a metered cloud tool when self-hosted
  engines are configured.** This is the claim a hostile reader tests first.
- **I5 — Config for user-owned engines never persists to Dashie cloud.**
- **I6 — Shared-shell edits are made in this tree and flow downstream.** The
  family console never hand-edits its vendored copy of a shared file.

## Enforcement, and the gap

| Invariant | Gate | Status |
|---|---|---|
| I1, I2 | `scripts/check-console-tree.sh` (file/string leaks) | automated, wired into `release.sh` |
| I3 | on-box runbook A4–A7 | manual |
| I4 | on-box runbook F | ⚠️ manual, and not yet run |
| I5 | local-mode Stage 1 | no standing gate |
| I6 | `scripts/hooks/pre-commit` → `check-generated-tree.sh` | automated |

`check-console-tree.sh` catches **file and string** leaks, not **behavioural**
ones. A family feature reachable in the published build through a runtime branch
passes the linter. That is the standing risk in this design: behavioural gating
needs runbook **A7** (the full console still requires its account) re-run on
every release, not just at authorship.

## Why `isPublishedBuild()` fails closed

`BRAND.build` used to be *absent* from the full build's brand.js, so "unknown"
meant "not published" meant full-build behaviour — every family page visible.
That failed OPEN on I1, the invariant that matters most, and made a typo or a
half-generated brand.js indistinguishable from a deliberate full build.

Both brand.js files now state `build` explicitly. Anything unrecognised is
treated as **published** (the restrictive case) and logs a distinctive
`DROP: unknown BRAND.build` warning, per CLAUDE.md's no-silent-drops rule.

**Do not invert the polarity to `hasFamilySuite()`.** It flips ~20 call sites
across the source and generated trees, and a logic-flip bug is the last thing
you want in the gate that enforces "no family pages in the published build."
