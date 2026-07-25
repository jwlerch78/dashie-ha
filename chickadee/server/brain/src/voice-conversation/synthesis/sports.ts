/**
 * Sports synthesis MOVED to the shared tool registry: _shared/tools/sports.ts
 * (shared by the cascade brain, the Gemini Live relay, and the HTTP tool-gateway —
 * one implementation, no duplication). Re-exported here so the brain's existing
 * imports (`templateSports`, the card types) keep resolving unchanged.
 *
 * See .reference/build-plans/20260623_VOICE_TIER1_STRUCTURED_TOOLS.md §1.
 */
export { templateSports } from '../../_shared/tools/sports.ts';
export type { SportsCard, SportsTeam, SportsSynthesis } from '../../_shared/tools/sports.ts';
// Multi-game slate synthesis (the agenda-style "what games are on today" path).
export { templateSlate } from '../../_shared/tools/sports-slate.ts';
