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

🔴 **AMENDED 2026-09-21 (John): the axis is the ACCOUNT, not the build.** The
add-on console can sign in to a Dashie account and manage that household's
devices — *"the console can still manage a family instance, it shouldn't limit
the family options. it should show both."* Keying these off `isPublishedBuild()`
hid the options of the very account being managed: a family customer running the
HA add-on could not set their own device's theme, and the swatch did not react.

| Setting | Account-less console |
|---|---|
| `display.themeFamily` | whole control hidden |
| `display.layoutMode` | `widgets` dropped — that option *is* the family dashboard |
| `photos.sourceType` | `supabase` (cloud albums) and `google_drive` dropped |

⚠️ **`CLOSED_DELTA_PAGES` / I1 are unaffected and stay on the BUILD axis.** Those
pages are not in this source tree at all — that is source isolation. This table
only ever governed options inside pages *both* editions ship, which is a
visibility choice, and the right question for one is "whose devices am I looking
at", not "which zip was I built from".

📌 **The `google_drive` note that used to sit here was wrong, and worth recording.**
It claimed Drive "needs the Google **Drive** OAuth scope, and the HA edition's
sign-in brand (`dashie_ha`) requests identity only". That is not merely stale, it
is structurally impossible: sign-in does not vary by edition at all —
`js/lib/console-auth.js` contains **zero** `BRAND.` references, both editions
share it, and it requests one fixed scope string including `drive.file`
(`console-auth.js:839`). There is no per-edition OAuth client here to differ.
A justification nobody could have checked is how a product decision acquires a
technical-sounding reason it never had.

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
- **I7 — No `FAMILY_ONLY_OPTIONS` entry is reachable WITHOUT AN ACCOUNT.**
  (Amended 2026-09-21; was "in a published build".) Two halves, and the second is the one that
  bites: the gate must **refuse** the option, *and* some render path must
  actually **ask** it. Registering a key in `FAMILY_ONLY_OPTIONS` does not gate
  it — a fourth entry with no chokepoint reads as protected and renders anyway.

## Enforcement, and the gap

| Invariant | Gate | Status |
|---|---|---|
| I1, I2 | `scripts/check-console-tree.sh` (file/string leaks) | automated, wired into `release.sh` |
| I3 | on-box runbook A4–A7 | manual |
| I4 | on-box runbook F | ⚠️ manual, and not yet run |
| I5 | local-mode Stage 1 | no standing gate |
| I6 | `scripts/hooks/pre-commit` → `check-generated-tree.sh` | automated |
| I7 | `scripts/check-family-only-options.test.ts` (executes the gate) | **automated**, via `check-console-tree.sh` §6 |

`check-console-tree.sh` §1–5 catch **file and string** leaks, not **behavioural**
ones. A family feature reachable in the published build through a runtime branch
passes those checks. That blind spot stopped being theoretical on 2026-07-30,
when `devices` left `CLOSED_DELTA_PAGES` for option-level gating — which moved
three family-only options from "absent file, statically provable" to "present
file, runtime branch". §6 exists for exactly that, and it **executes**
`feature-gate.js` rather than reading it.

What §6 asserts, and what it does not:

- ✅ every registered entry is refused in the published build, kept in the full
  build, and does not over-reach onto unlisted values
- ✅ an unknown/missing `BRAND.build` fails **closed** with a one-shot `DROP:` —
  the contract-#56 defect, now regression-locked
- ✅ every registered key is **reachable** by a gate call site: a literal
  `optionAllowed`/`filterOptions`, or an `openPicker(…,'<cat>','<key>',…)` that
  `renderPickerModal()` gates generically
- ✅ that generic chokepoint still filters. It is load-bearing on its own:
  `display.layoutMode` has no literal call site anywhere, so without this
  assertion the reachability check would stay green while the option came back
- ❌ it does not render the page. A4–A7 on the box remain the account-boundary
  check; I7 is about which **options** exist, not who may see the page

All three failure modes were verified to go red against a mutated copy of the
tree (`I7_CONSOLE_DIR` points the suite at a copy for exactly that purpose).

Known cosmetic wrinkle, not a leak: `openPicker` passes `'widgets'` as the Layout
picker's `defaultValue`, and in the published build that value is filtered out of
the options — so an unset device renders the select with nothing matching and the
browser shows the first entry. `widgets` is never *offered*, so it cannot be
chosen; the summary row separately reports a device's real mode, which is honest.

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
