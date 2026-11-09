/**
 * No-op shim for MobileDashboard components.
 * Settings pages import ConfirmationModal, MemberProfileEditor, etc.
 * from MobileDashboard — these pages are filtered out in kiosk mode
 * so the imports never execute, but they must resolve at bundle time.
 */

export class ConfirmationModal {
  constructor() {}
  show() { return Promise.resolve(false); }
}

// ── The active profile, as kiosk sees it (2026-10-18, I) ────────────────────────────────────────────
// `js/modules/MobileDashboard/core/active-profile.js` is a RE-EXPORT of
// `js/shared/kid-tablet/active-profile.js`, kept so importers outside MobileDashboard work unchanged —
// and the `/MobileDashboard/` resolver above shims it, so those importers' names have to exist here.
// `js/core/shell-role.js:47` is one, and anything that reaches `kid-data-scope.js` pulls it in (which
// is how this gap surfaced: the kid-teams gateway broke the kiosk bundle with
// "No matching export … for isParentRelationship").
//
// 🔴 THESE TWO ARE CORRECT FOR KIOSK RATHER THAN MERELY QUIET, and the difference matters because a
// stub that returns a plausible wrong value is worse than a missing one. Kiosk mode has no login and no
// profile picker, so:
//   · `getActiveProfile()` → null is the TRUE answer ("nobody is acting"), and it drives
//     `resolveShellRole` down its no-profile branch to the credential role — kiosk's actual state;
//   · `isParentRelationship` is only reached with a TRUTHY profile (`shell-role.js:111`), which the
//     line above can never produce, so it is unreachable in this bundle. `false` is the fail-closed
//     direction anyway: a parent is never inferred from a profile that does not exist.
// ⇒ a kid scope in kiosk resolves UNSCOPED, which is right: there is no kid tablet in kiosk mode.
export function getActiveProfile() { return null; }
export function isParentRelationship() { return false; }

export function showTextInputModal() { return Promise.resolve(null); }
export function showAddMemberModal() { return Promise.resolve(null); }
export class MemberProfileEditor {}
