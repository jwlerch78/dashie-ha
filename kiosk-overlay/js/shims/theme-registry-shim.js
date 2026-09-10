/**
 * Stub for theme-registry.js. Kiosk is always dark; this exists so the Settings
 * pages can render without pulling the full registry (and its per-family CSS
 * metadata) into a bundle that boots on a 512 MB Echo Show.
 *
 * ── 🔴 A STUB MUST NEVER BE ABLE TO SAY YES WHEN THE REAL THING SAYS NO ─────
 * Rewritten 2026-09-07 after an audit (`tools/kiosk-shim-contract/audit.ts`)
 * measured EIGHT shape divergences against the module this stands in for. Two
 * of them were not "less detail" — they were the stub being **unable to answer
 * NO**:
 *
 *   parseThemeId('nonsense')      real → null      shim → { familyId, mode }
 *   getThemeFamily('nonexistent') real → null      shim → { id, name }
 *
 * So every validity check routed through this file answered "valid", including
 * `usable()` in `js/ui/themes/resolve-theme-family.js` — which is
 * `getThemeFamily(x) ? x : null` and therefore validated ANY string, including
 * a garbage family read out of Kotlin's pref, the precise case that arm exists
 * to reject. It shipped that way from 2026-02-23 and no gate had an opinion
 * about it, because **a wrong shape builds fine.** A missing export fails
 * loudly in an hour; this kind ships.
 *
 * 📌 And the key name was simply wrong: `{ familyId }` where the real module
 * returns `{ family }` (`theme-registry.js:245-268`). Nothing in the kiosk tree
 * read `familyId` — verified by grep — so the stub had been returning a key no
 * caller wanted while failing the one they did.
 *
 * ⚠️ BEHAVIOUR CHANGE, stated here and not only in the commit: kiosk's
 * `usable()` now REJECTS every family except `default`. That is the true
 * answer — kiosk has no orchid/fern/marigold CSS — and the chain correctly
 * falls through to `DEFAULT_THEME_FAMILY`. Unobservable today because
 * `theme-applier.js` is itself shimmed to a no-op here, so nothing paints.
 * 🔴 **PREDICTION for the first kiosk bundle that ships with this:** the moment
 * anyone gives the kiosk shell a real theme paint — `kiosk-settings-sync.js:254`
 * is the fourth hand-copy of the boot recipe and the place that would land —
 * THIS ARM is the first thing to check.
 *
 * ⚠️ Deliberately still ABSENT (O's ruling, 2026-09-07): the ten real exports
 * this file does not stub. `lint:bridge-globals` catches each one the day
 * something imports it, loudly, before a deploy. Adding them pre-emptively
 * would trade ten loud landmines for ten silent ones — every new stub is a new
 * shape that can drift.
 */

/**
 * The one family kiosk actually has CSS for. Shaped like the real registry's
 * entries (`id`, `name`, `variants`) so `getThemeFamily` can return something a
 * caller written against the real contract can read.
 */
const FAMILIES = {
  default: { id: 'default', name: 'Default', variants: { light: {}, dark: {} } },
};

/** The real registry's THEME_MODES. Inlined, not exported — see the note above. */
const MODES = ['light', 'dark'];

export const DEFAULT_THEME_FAMILY = 'default';
/** ⚠️ Deliberately 'dark' where the real module says 'light'. Kiosk is always dark. */
export const DEFAULT_THEME_MODE = 'dark';

export function getAllThemeFamilies() {
  return Object.values(FAMILIES);
}

export function getThemeFamilyIds() {
  return Object.keys(FAMILIES);
}

/** @returns the family entry, or NULL when this build has no such family. */
export function getThemeFamily(familyId) {
  return FAMILIES[familyId] ?? null;
}

export function isValidThemeFamily(familyId) {
  return Object.prototype.hasOwnProperty.call(FAMILIES, familyId);
}

export function isValidThemeMode(mode) {
  return MODES.includes(mode);
}

export function buildThemeId(familyId, mode) {
  return `${familyId}-${mode}`;
}

/**
 * @returns {{family: string, mode: string}|null}
 * `family`, not `familyId` — the real module's key. NULL for anything this
 * build cannot actually render, which is what makes the validity checks above
 * it meaningful.
 */
export function parseThemeId(themeId) {
  if (!themeId || typeof themeId !== 'string') return null;
  // Legacy ids, same two special cases the real module carries.
  if (themeId === 'light') return { family: 'default', mode: 'light' };
  if (themeId === 'dark') return { family: 'default', mode: 'dark' };

  const lastDash = themeId.lastIndexOf('-');
  if (lastDash === -1) return null;
  const family = themeId.substring(0, lastDash);
  const mode = themeId.substring(lastDash + 1);
  if (!isValidThemeFamily(family) || !isValidThemeMode(mode)) return null;
  return { family, mode };
}

export function isValidThemeId(themeId) {
  return parseThemeId(themeId) !== null;
}

/**
 * ⚠️ DECLARED DIVERGENCE — always null, where the real module returns an
 * 8-key config for a valid family+mode.
 *
 * The shim CANNOT match this: the missing keys are `cssClass`, `logoSrc`,
 * `familyName` and friends — per-family presentation data whose whole point is
 * to stay out of this bundle. Mirroring it here is the thing this file exists
 * to avoid.
 *
 * 📌 `null` rather than the old `{}` on purpose. `null` is inside the real
 * function's OWN return domain, so a caller written against the real contract
 * already handles it; `{}` is a value the real function can never return, which
 * makes it a lie about the type rather than merely less information.
 */
export function getThemeConfig() { return null; }

/** Same declared divergence, same reason. @see getThemeConfig */
export function getThemeById() { return null; }
