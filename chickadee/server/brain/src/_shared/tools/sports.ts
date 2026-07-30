/**
 * Sports tool — the single implementation shared by every consumer (cascade brain,
 * Gemini Live relay, HTTP gateway, future add-ons).
 *
 * ⚠️ Before editing, read ./SPORTS.md — the maintainer guide (the `when` param rationale,
 * ESPN's 100-event range cap, per-state card rules, card↔voice invariant) + a device-free
 * repro (./sports.repro.ts). It exists to stop you re-tripping a session's worth of bugs.
 *
 * Pipeline: sports-gateway (raw ESPN/API-Sports games[]) → pick the relevant game →
 * derive state (pre/in/post) → a spoken line + an optional card payload. Zero LLM.
 *
 * Moved here (from voice-conversation/synthesis/sports.ts + gather.runSports) so the
 * logic lives ONCE; the brain re-exports `templateSports`/`runSports` for back-compat.
 * Adds timezone-correct kickoff formatting (the old code omitted scheduled times
 * because it had no user tz — the "5pm PDT" bug).
 */

import type { ToolCard, ToolContext, ToolDef, ToolResult } from './types.ts';
import { slateCard, templateSlate } from './sports-slate.ts';

// deno-lint-ignore no-explicit-any
export interface SportsResult {
  provider: string;
  query: Record<string, any>;
  games: Array<Record<string, any>>;
  result_count: number;
  latency: number;
}

/** A loose view of the gateway's game object. */
export interface Game {
  league?: string; status?: string; detail?: string; startTime?: string; venue?: string;
  home?: string; away?: string; homeScore?: number | null; awayScore?: number | null;
  winner?: 'home' | 'away' | null;
  // Penalty-shootout result of a knockout game that ended level after regulation/ET.
  // ESPN sets `winner` on the shootout victor and gives each side a `shootoutScore`;
  // without these, an equal regulation score reads as a "tie" when there was a winner.
  homeShootout?: number | null; awayShootout?: number | null;
  events?: Array<{ type?: string; clock?: string; side?: 'home' | 'away'; player?: string; scoreValue?: number }>;
  homeRecord?: string; awayRecord?: string;
  // Compact display forms for stacked slate rows ("Diamondbacks" / "ARI") — card-only.
  homeShort?: string; awayShort?: string; homeAbbr?: string; awayAbbr?: string;
  homeLogo?: string; awayLogo?: string; homeColor?: string; awayColor?: string;
  // Baseball box (R = home/awayScore; H/E complete the line) + per-team standout.
  homeHits?: number | null; awayHits?: number | null;
  homeErrors?: number | null; awayErrors?: number | null;
  homeLeaders?: Array<{ player: string; line: string }>;
  awayLeaders?: Array<{ player: string; line: string }>;
  // Probable starting pitchers (MLB scheduled games).
  homeProbable?: string; awayProbable?: string;
}

export type State = 'pre' | 'in' | 'post';

export interface SportsTeam {
  name: string; score: number | null; record?: string; logo?: string; color?: string;
}
/** Sport-agnostic key stats for the card (renderer shows whatever's present):
 *  • lines — paired team numbers (baseball R/H/E, possession, …) rendered "label home–away".
 *  • highlights — labeled contributors (soccer goals grouped by team, baseball HR / W-L-S, …). */
export interface SportsStatLine { label: string; home: string; away: string }
export interface SportsHighlight { label: string; detail: string }

export interface SportsCard {
  type: 'sports';
  league?: string;
  state: State;
  detail?: string;
  venue?: string;
  home: SportsTeam;
  away: SportsTeam;
  winner?: 'home' | 'away' | null;
  lines?: SportsStatLine[];
  highlights?: SportsHighlight[];
  // Legacy soccer scorers — kept so an older renderer still shows them; the generic
  // renderer reads `highlights`. Remove once all clients render highlights.
  scorers?: Array<{ player: string; side?: 'home' | 'away'; clocks: string[] }>;
}
export interface SportsSynthesis {
  voice: string;
  text: string | null;
  structured_data: SportsCard | null;
  fallback?: boolean;
}

// ── gateway fetch ────────────────────────────────────────────────────────────

/** Runtime-agnostic env read: this module runs in the cloud (Deno) AND inside the
 *  add-on's Node brain bundle, where a bare `Deno.env.get` is a ReferenceError.
 *  Node callers should pass ctx (io.toolConn); this is the fallback. */
function envVar(key: string): string {
  try {
    const d = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno;
    if (d?.env?.get) return d.env.get(key) ?? '';
  } catch { /* not Deno */ }
  try {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[key] ?? '';
  } catch { /* not Node either */ }
  return '';
}

/** Self-fulfill a sports score/schedule lookup via sports-gateway. Reads creds from
 *  [ctx] when provided, else falls back to env (so the brain's existing env-based
 *  callers keep working). Provider 'auto' = ESPN → API-Sports fallback. */
export async function runSports(
  // deno-lint-ignore no-explicit-any
  query: Record<string, any>,
  ctx?: { supabaseUrl?: string; anonKey?: string; jwt?: string; provider?: string },
): Promise<SportsResult> {
  const url = ctx?.supabaseUrl || envVar('SUPABASE_URL');
  const key = ctx?.anonKey || envVar('SUPABASE_ANON_KEY');
  const provider = ctx?.provider ?? 'auto';
  // Forward the USER JWT so the gateway can attribute + gate the paid call (mirrors
  // image_search.runImageSearch); fall back to the anon key when anonymous. The gateway's
  // gateway_auth_enforce gate reads the `sub` from this Bearer.
  const auth = ctx?.jwt ? `Bearer ${ctx.jwt}` : `Bearer ${key}`;
  const resp = await fetch(`${url}/functions/v1/sports-gateway`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: auth },
    body: JSON.stringify({ provider, query }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.error || body.message || `HTTP ${resp.status}`);
  return body as SportsResult;
}

// ── synthesis (template, no LLM) ─────────────────────────────────────────────

function resolveWhen(query: Record<string, unknown>): 'last' | 'next' | 'live' | '' {
  const w = String(query?.when ?? '').toLowerCase();
  if (w === 'last' || w === 'next' || w === 'live') return w;
  const t = String(query?.type ?? '').toLowerCase();
  if (t === 'schedule') return 'next';
  if (t === 'score') return 'last';
  return '';
}

export function deriveState(g: Game): State {
  const s = (g.status || '').toLowerCase();
  const d = (g.detail || '').toLowerCase();
  // A postponed/suspended/cancelled game isn't being played: ESPN sends it with 0–0 scores and
  // no final/scheduled marker, so it fell to 'in' and the slate voiced it as "X and Y tied 0–0"
  // (field 2026-07-28: yesterday's rained-out Reds–Guardians game read as a live tie).
  if (/postpon|suspend|cancel/.test(s) || /postpon|suspend|cancel/.test(d)) return 'pre';
  if (g.winner || s.includes('final') || s.includes('full')) return 'post';
  if ((g.homeScore == null && g.awayScore == null) || s.includes('scheduled') || s.includes('pre')) return 'pre';
  return 'in';
}

function pickGame(games: Game[], team: string, when: string): Game {
  const matches = team
    ? games.filter((g) => (g.home || '').toLowerCase().includes(team) || (g.away || '').toLowerCase().includes(team))
    : games.slice();
  const pool = matches.length ? matches : games;
  const byState = (st: State) => pool.filter((g) => deriveState(g) === st);

  if (when === 'last') return byState('post').slice(-1)[0] || byState('in')[0] || pool[0];
  if (when === 'next') return byState('pre')[0] || pool[0];
  if (when === 'live') return byState('in')[0] || pool[0];
  return byState('in')[0] || byState('post').slice(-1)[0] || byState('pre')[0] || pool[0];
}

function groupScorers(g: Game): Array<{ player: string; side?: 'home' | 'away'; clocks: string[] }> {
  const out: Array<{ player: string; side?: 'home' | 'away'; clocks: string[] }> = [];
  for (const e of g.events || []) {
    if (!e.player || (e.scoreValue ?? 0) <= 0) continue;
    let entry = out.find((s) => s.player === e.player && s.side === e.side);
    if (!entry) { entry = { player: e.player, side: e.side, clocks: [] }; out.push(entry); }
    if (e.clock) entry.clocks.push(e.clock);
  }
  return out;
}

function scorersText(g: Game): string | null {
  const scorers = groupScorers(g);
  if (!scorers.length) return null;
  const list = scorers.map((s) => `${s.player}${s.clocks.length ? ` (${s.clocks.join(', ')})` : ''}`).join(', ');
  return `Scorers: ${list}`;
}

/** Soccer's contribution to the generic `highlights`: scorers grouped by team, so the
 *  card shows "Argentina: Messi (12') · Brazil: …". This is the per-sport population
 *  for soccer; other sports fill `highlights`/`lines` differently (baseball: HR + W/L/S
 *  + R/H/E) — see the build plan. */
function soccerHighlights(g: Game): SportsHighlight[] {
  const scorers = groupScorers(g);
  if (!scorers.length) return [];
  const fmt = (list: typeof scorers) =>
    list.map((s) => `${s.player}${s.clocks.length ? ` (${s.clocks.join(', ')})` : ''}`).join(', ');
  const out: SportsHighlight[] = [];
  const home = scorers.filter((s) => s.side === 'home');
  const away = scorers.filter((s) => s.side === 'away');
  const neutral = scorers.filter((s) => !s.side);
  if (home.length) out.push({ label: g.home || 'Home', detail: fmt(home) });
  if (away.length) out.push({ label: g.away || 'Away', detail: fmt(away) });
  if (neutral.length) out.push({ label: 'Scorers', detail: fmt(neutral) });
  return out;
}

const isBaseball = (g: Game) => /mlb|baseball/i.test(g.league || '');

/** Each team's standout line from the provider's home/awayLeader — sport-agnostic
 *  (baseball "1-2, HR, RBI, R", basketball "30 PTS", hockey "2 G", football "245 YDS";
 *  the provider picks the sport-appropriate category). */
function leaderHighlights(g: Game): SportsHighlight[] {
  // Join a team's leaders into ONE line ("McDavid 2 G · Draisaitl 3 A" for hockey;
  // "Allen 245 PASS · Cook 85 RUSH · Diggs 90 REC" for football) — one row per team,
  // matching the single-standout layout. Baseball/basketball have exactly one.
  const line = (ls?: Array<{ player: string; line: string }>) =>
    (ls || []).filter((l) => l.player).map((l) => `${l.player} ${l.line}`).join(' · ');
  const out: SportsHighlight[] = [];
  const h = line(g.homeLeaders), a = line(g.awayLeaders);
  if (h) out.push({ label: g.home || 'Home', detail: h });
  if (a) out.push({ label: g.away || 'Away', detail: a });
  return out;
}
/** Pre-game baseball highlights = probable starting pitchers (records already show in the
 *  team names). Batting-average leaders are meaningless before first pitch, so a scheduled
 *  game shows pitchers or nothing — never season stat lines. */
function pitcherHighlights(g: Game): SportsHighlight[] {
  const out: SportsHighlight[] = [];
  if (g.awayProbable) out.push({ label: g.away || 'Away', detail: `${g.awayProbable} (P)` });
  if (g.homeProbable) out.push({ label: g.home || 'Home', detail: `${g.homeProbable} (P)` });
  return out;
}

const WEEKDAYS: Record<string, string> = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
  Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
};

export function tidyDetail(detail?: string): string {
  let d = (detail || '').trim();
  if (!d) return '';
  d = d.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/, (_m, abbr) => WEEKDAYS[abbr] || abbr);
  d = d.replace(/\s+([A-Z]{2,4})\.?$/, (m, abbr) => (abbr === 'AM' || abbr === 'PM') ? m : '');
  // "5:58 - 3rd Quarter" → "5:58 - 3rd" (also Inning/Period/Half after an ordinal):
  // the spelled-out unit wrecks the slate's right-column alignment, and the ordinal
  // alone reads fine. Worded periods with no ordinal ("First Half", "Halftime") stay.
  d = d.replace(/(\d+(?:st|nd|rd|th))\s+(?:Quarter|Inning|Period|Half)\b/gi, '$1');
  return d.trim();
}

/** Local YYYY-MM-DD in tz (en-CA gives ISO order), for whole-day comparisons. */
function ymdInTz(d: Date, tz?: string): string {
  return new Intl.DateTimeFormat('en-CA', { ...(tz ? { timeZone: tz } : {}), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Day label in the user's zone: "Today" / "Tomorrow" / "Yesterday" for ±1 day, else a
 *  short date "Sat, Jun 27". Relative labels read far more naturally than a bare date for
 *  the common near-term cases. Empty when startTime isn't parseable. */
export function relativeDay(startTime: string | undefined, tz?: string): string {
  if (!startTime) return '';
  const d = new Date(startTime);
  if (isNaN(d.getTime())) return '';
  const gameYmd = ymdInTz(d, tz);
  const nowYmd = ymdInTz(new Date(), tz);
  const diff = Math.round((Date.parse(`${gameYmd}T00:00:00Z`) - Date.parse(`${nowYmd}T00:00:00Z`)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  try {
    return new Intl.DateTimeFormat('en-US', { ...(tz ? { timeZone: tz } : {}), weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  } catch { return ''; }
}

/** SPOKEN day label — "Today" / "Tomorrow" / "Sunday, July 19".
 *
 *  WHY THIS EXISTS: `relativeDay` is abbreviated for the CARD ("Sun, Jul 19"), and the same
 *  string reaches the model in SPORTS_DATA (prompt.ts:211 stringifies the whole result), which
 *  reads it out verbatim — TTS then says "sun" and "jul". Field-confirmed 2026-07-16 on the
 *  Samsung: "Spain play Argentina, Sun, Jul 19." Weather already gets this right
 *  (weather.ts:108, weekday:'long'); sports was the outlier.
 *
 *  Fixing the DATA rather than asking the model to expand abbreviations: today's third case of a
 *  prompt plea losing to a mechanical fix. The card keeps its compact `relativeDay` — this is
 *  additive, so no display gets wider. */
export function relativeDaySpoken(startTime: string | undefined, tz?: string): string {
  const rel = relativeDay(startTime, tz);
  // Today/Tomorrow/Yesterday are already speakable — and better than a bare date.
  if (!rel || rel === 'Today' || rel === 'Tomorrow' || rel === 'Yesterday') return rel;
  try {
    const d = new Date(startTime as string);
    return new Intl.DateTimeFormat('en-US', {
      ...(tz ? { timeZone: tz } : {}),
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(d);
  } catch { return rel; }
}

/** Local clock time "5:45 PM" in the user's zone (normalize V8's narrow no-break space
 *  before AM/PM to a normal space so it renders/reads cleanly). */
export function clockTime(startTime: string | undefined, tz?: string): string {
  if (!tz || !startTime) return '';
  const d = new Date(startTime);
  if (isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
      .format(d).replace(/[\u202f\u00a0]/g, ' ');
  } catch { return ''; }
}

/** Scheduled date+time for the card/voice in the user's zone, e.g. "Today, 5:45 PM" /
 *  "Tomorrow, 1:10 PM" / "Sat, Jun 27, 7:05 PM". Falls back to ESPN's detail (digit-only,
 *  so a bare "Scheduled" is dropped) when there's no tz/startTime. */
export function scheduleWhen(g: Game, tz?: string): string {
  const day = relativeDay(g.startTime, tz);
  const time = clockTime(g.startTime, tz);
  if (day && time) return `${day}, ${time}`;
  if (day) return day;
  const d = tidyDetail(g.detail);
  return d && /\d/.test(d) ? d : '';
}

/** SPOKEN scheduled date+time — "Today, 5:45 PM" / "Sunday, July 19, 3:25 PM".
 *
 *  Twin of `scheduleWhen`, which stays ABBREVIATED for the card. Anything that ends up in a
 *  `voice` string must use this one: the template's line is fed straight to TTS, which
 *  pronounces "Sun" and "Jul" as words.
 *
 *  ⚠️ `clockTime` returns '' without a tz, so a caller that omits `timezone` gets a date with NO
 *  kickoff time — field-confirmed via the HA gateway, which never sends it. Fixing that is the
 *  caller's job; this function can only format what it's given. */
export function scheduleWhenSpoken(g: Game, tz?: string): string {
  const day = relativeDaySpoken(g.startTime, tz);
  const time = clockTime(g.startTime, tz);
  if (day && time) return `${day}, ${time}`;
  if (day) return day;
  const d = tidyDetail(g.detail);
  return d && /\d/.test(d) ? d : '';
}

/** Relative date ("Today"/"Yesterday"/"Sat, Jun 27") in the user's zone — so a FINAL card
 *  shows WHEN the game was (otherwise a stale result looks current). */
function formatGameDate(startTime: string | undefined, tz?: string): string {
  return relativeDay(startTime, tz);
}

function card(g: Game, state: State, tz?: string): SportsCard {
  const date = formatGameDate(g.startTime, tz);
  // A knockout decided on penalties (level scores + a winner, or ESPN shootout scores)
  // → mark the card "Final (Pens)" so it agrees with the spoken "won on penalties".
  const pens = g.homeShootout != null || g.awayShootout != null ||
    (state === 'post' && !!g.winner && (g.homeScore ?? 0) === (g.awayScore ?? 0));
  const finalLabel = pens ? 'Final (Pens)' : 'Final';
  const detail = state === 'pre' ? (scheduleWhen(g, tz) || tidyDetail(g.detail) || g.startTime)
    : state === 'post' ? (date ? `${finalLabel} · ${date}` : (tidyDetail(g.detail) || finalLabel))
    : (tidyDetail(g.detail) || g.startTime);   // 'in' → keep the live clock
  return {
    type: 'sports',
    league: g.league,
    state,
    detail,
    venue: g.venue,
    // A PRE/future game has NO score — force null even when the provider sends 0 (ESPN returns
    // "0"/"0" for a scheduled game), so the card never shows a misleading "0 – 0". `?? null` alone
    // keeps a numeric 0; the state gate is what suppresses it. (Mirrors the no-R/H/E-lines rule.)
    home: { name: g.home || '', score: state === 'pre' ? null : (g.homeScore ?? null), record: g.homeRecord, logo: g.homeLogo, color: g.homeColor },
    away: { name: g.away || '', score: state === 'pre' ? null : (g.awayScore ?? null), record: g.awayRecord, logo: g.awayLogo, color: g.awayColor },
    winner: g.winner ?? null,
    // Per-sport population of the generic stats. Standout leader lines render for every
    // sport whose provider fills home/awayLeader (baseball batting, basketball PTS,
    // hockey PTS, football YDS); soccer keeps its goal-event highlights; pre-game
    // baseball shows probable pitchers. R/H/E lines REMOVED 2026-07-12 (user: a
    // single-line R/H/E doesn't attribute which team had what).
    lines: [],
    highlights: isBaseball(g)
      ? (state === 'pre' ? pitcherHighlights(g) : leaderHighlights(g))
      : (soccerHighlights(g).length ? soccerHighlights(g) : (state !== 'pre' ? leaderHighlights(g) : [])),
    scorers: groupScorers(g),   // legacy — drop once all renderers read highlights
  };
}

function finalLine(g: Game): string {
  const hs = g.homeScore ?? 0, as = g.awayScore ?? 0;
  if (hs === as) {
    // Level after regulation/ET but a winner is set → decided on penalties (knockout).
    // Don't call it a tie: name the shootout winner (with the pens score when ESPN gave it).
    if (g.winner) {
      const homeWon = g.winner === 'home';
      const w = homeWon ? g.home : g.away;
      const ps = (g.homeShootout != null && g.awayShootout != null)
        ? `, ${homeWon ? g.homeShootout : g.awayShootout} to ${homeWon ? g.awayShootout : g.homeShootout}`
        : '';
      return `${g.home} and ${g.away} drew ${hs} to ${as}, but ${w} won on penalties${ps}.`;
    }
    return `${g.home} and ${g.away} tied ${hs} to ${as}.`;
  }
  const homeWon = g.winner ? g.winner === 'home' : hs > as;
  const [w, ws, l, ls] = homeWon ? [g.home, hs, g.away, as] : [g.away, as, g.home, hs];
  return `${w} beat ${l} ${ws} to ${ls}.`;
}

function liveLine(g: Game): string {
  const hs = g.homeScore ?? 0, as = g.awayScore ?? 0;
  const when = tidyDetail(g.detail) ? `, ${tidyDetail(g.detail)}` : '';
  return `${g.away} ${as}, ${g.home} ${hs}${when}.`;
}

function scheduledLine(g: Game, team: string, tz?: string): string {
  const teamName = team && (g.away || '').toLowerCase().includes(team) ? g.away : g.home;
  const opp = teamName === g.home ? g.away : g.home;
  // SPOKEN, not the card's abbreviation. This line is read aloud verbatim by TTS — field-confirmed
  // 2026-07-16: "Spain play Argentina, Sun, Jul 19." came out as "sun, jul". scheduleWhen stays
  // compact for the CARD; the voice gets the long form.
  const when = scheduleWhenSpoken(g, tz);
  return `${teamName} play ${opp}${when ? `, ${when}` : ''}.`;
}

function noGamesLine(query: Record<string, unknown>): string {
  const team = String(query?.team ?? '').trim();
  return team ? `I couldn't find a game for ${team}.` : `I couldn't find that game.`;
}

function noRecentResultLine(g: Game, query: Record<string, unknown>, tz?: string): string {
  const team = String(query?.team ?? '').trim() || g.home || 'that team';
  const opp = (g.home || '').toLowerCase().includes(team.toLowerCase()) ? g.away : g.home;
  const when = scheduleWhen(g, tz);
  return `I couldn't find a recent ${team} result — their next game is${when ? ` ${when}` : ''} vs ${opp}.`;
}

/**
 * Template a sports answer from the gateway result + the pass-1 query.
 * @param opts.timezone IANA tz to format scheduled kickoff times in the user's zone.
 */
export function templateSports(
  result: SportsResult,
  query: Record<string, unknown>,
  opts?: { timezone?: string },
): SportsSynthesis {
  const tz = opts?.timezone;
  const games = (Array.isArray(result?.games) ? result.games : []) as Game[];
  const team = String(query?.team ?? '').toLowerCase();
  const when = resolveWhen(query);

  // Teamless + NO directed `when` = a list-ish ask → punt to the slate/LLM path
  // (fallback), as always. Teamless WITH a directed when (live/last/next) is a shape
  // only the RELAY produces (the cascade strips `when` from teamless queries upstream,
  // so this doesn't change cascade routing) and it's unambiguous — "the game right
  // now" = the one game pickGame resolves teamlessly. Punting it returned found:false
  // for a live game the data HAD (anon-kiosk Live 2026-07-09:
  // {"when":"live","league":"World Cup"} → no score card while France–Morocco was in).
  // ...EXCEPT when the window resolved to exactly ONE game: that's not a list, it's the
  // game. Card it (the detail card carries venue + records — a slate row can't), so
  // "what time is the World Cup game tomorrow" shows the stadium, not a 1-row slate
  // (2026-07-13). pickGame's when:'' branch smart-picks live → final → upcoming.
  if (!team && !when && games.length !== 1) {
    return { voice: '', text: null, structured_data: null, fallback: true };
  }
  if (games.length === 0) {
    return { voice: noGamesLine(query), text: null, structured_data: null };
  }

  const game = pickGame(games, team, when);
  const state = deriveState(game);

  if (when === 'last' && state === 'pre') {
    return { voice: noRecentResultLine(game, query, tz), text: null, structured_data: card(game, state, tz) };
  }

  const voice = state === 'post' ? finalLine(game)
    : state === 'in' ? liveLine(game)
    : scheduledLine(game, team, tz);
  const text = state === 'pre' ? null : scorersText(game);

  return { voice, text, structured_data: card(game, state, tz) };
}

// ── the tool (registry entry) ────────────────────────────────────────────────

export const sportsTool: ToolDef = {
  name: 'get_sports_scores',
  description:
    'Get sports scores/schedules with a scorecard the screen can show. TWO modes: ' +
    '(1) ONE game for a team — the LIVE score or most RECENT result ("what\'s the score", ' +
    '"did they win", today\'s game); (2) a SLATE of MULTIPLE games — set list:true for ' +
    '"what games are on today/tonight", "show me today\'s World Cup games", or a whole ' +
    'league\'s day. A slate may omit team (all of a league\'s games) or name a team. ' +
    'ALWAYS provide the league/sport — infer it from the team if unsaid (e.g. Yankees → ' +
    'MLB, Eagles → NFL, Lakers → NBA, England/Portugal in a tournament → soccer/World Cup). ' +
    'For a bare "the game"/"the match" with no pro team or league named, prefer the family ' +
    'calendar (get_calendar_events) first; use this tool for named pro teams/leagues or ' +
    'explicit score/result questions.',
  parameters: {
    type: 'object',
    properties: {
      team: { type: 'string', description: 'Team, club, or national side, e.g. "England", "Eagles", "Lakers". Optional for a list:true league slate.' },
      league: {
        type: 'string',
        description: 'REQUIRED. League/sport, e.g. "MLB", "NFL", "NBA", "NHL", "World Cup", ' +
          '"Premier League", "Champions League", "MLS". For any soccer/futbol team use "soccer" ' +
          'or the specific competition — NOT "football" (that means American football/NFL). ' +
          'Infer from the team when unstated; never omit this.',
      },
      when: {
        type: 'string',
        enum: ['recent', 'live', 'upcoming'],
        description:
          'Temporal intent from the user\'s words. "recent" = ONLY an explicitly finished ' +
          'game ("yesterday", "last game", "did they win", "what was the score"). "live" = a ' +
          'game in progress right now. "upcoming" = a current or future game — today\'s game, ' +
          'the next game, lineups, or "who\'s playing / who\'s starting" ("tonight", "today\'s ' +
          'game", "when do they play next"). Do NOT use "recent" just because no tense is ' +
          'stated — a question about who\'s playing or a game today is "upcoming", not ' +
          '"recent". If unsure, prefer "upcoming" or omit. Call this tool EXACTLY ONCE.',
      },
      list: {
        type: 'boolean',
        description:
          'Set true for ANY multi-game (PLURAL) request — "what games are on today/tonight", ' +
          '"today\'s World Cup games", "the NEXT games", "upcoming games this week", "what\'s ' +
          'on the schedule" (omit team for a whole-league slate) OR one team\'s multiple games ' +
          '("list Brazil\'s games", "all the Yankees games"; pass team). The plural "games" is ' +
          'the tell — set list AND the matching `when` (upcoming for "next/upcoming games", ' +
          'recent for "recent results"). Without it you get a single game. Leave false for a ' +
          'singular "the next game" / one team\'s score.',
      },
      date: {
        type: 'string',
        description:
          'Optional day for a list:true slate, as YYYY-MM-DD (the user\'s local date). ' +
          'Omit for today. Use it for "tomorrow\'s games" etc. Ignored when list is false.',
      },
    },
    required: ['league'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const gw = { supabaseUrl: ctx.supabaseUrl, anonKey: ctx.anonKey, jwt: ctx.jwt };
    const team = String(args.team ?? '');

    // ── Slate mode: MULTIPLE games (agenda-style card) ──────────────────────────
    // Send `list:true` (the gateway's finalize keeps the WHOLE window instead of
    // collapsing to one via pickGames) AND the directed `when` so a future slate
    // ("next games") fetches the upcoming window, not just today. Before this the
    // branch dropped `when` and relied on pickGames(null) returning today's games —
    // which is empty for a league with no games today (World Cup, 2026-07-12).
    // The user's zone rides on every gateway query so recency windows anchor "today"
    // on the USER's calendar day (the edge server is UTC — 8 PM Eastern is already
    // tomorrow there, which skipped the rest of tonight's games).
    const tz = ctx.timezone ? { tz: ctx.timezone } : {};

    if (args.list === true) {
      const date = String(args.date ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0];
      // Honor the temporal intent on a SLATE too: "next/upcoming games" must fetch the
      // FUTURE window, not just today (the World Cup has no games today but four this
      // week). Without this the list branch dropped `when` and a future slate came back
      // empty (2026-07-12). An explicit date still wins.
      const SLATE_WHEN: Record<string, string> = { recent: 'last', upcoming: 'next', live: 'live' };
      const gwWhen = date ? 'date' : (SLATE_WHEN[String(args.when ?? '').toLowerCase()] || '');
      const query: Record<string, unknown> = {
        league: args.league,
        ...(team ? { team } : {}),
        list: true,
        ...(date ? { when: 'date', date } : (gwWhen ? { when: gwWhen } : {})),
        ...tz,
      };
      const sports = await runSports(query, gw);
      // A slate that resolved to exactly ONE game renders as the richer detail card
      // (stadium + city/state, records) — a slate row can't carry those (2026-07-13).
      if ((sports?.games?.length ?? 0) === 1) {
        const one = templateSports(sports, query, { timezone: ctx.timezone });
        if (one.structured_data) {
          return { result: { found: true, voice: one.voice, text: one.text }, card: one.structured_data as unknown as ToolCard };
        }
      }
      const synth = templateSlate(sports, query, { timezone: ctx.timezone });
      if (!synth.structured_data) return { result: { found: false }, card: null };
      return {
        result: { found: true, voice: synth.voice, count: synth.structured_data.total },
        card: slateCard(synth),
      };
    }

    // Map the model's temporal intent to the gateway/selector `when`. This is what
    // disambiguates "yesterday" (recent → most-recent final) from "tonight" (upcoming →
    // today's scheduled game) — the live slate alone can't tell them apart. Omitted →
    // no `when` → current slate with a smart pick (live → recent final → upcoming).
    const WHEN_MAP: Record<string, string> = { recent: 'last', live: 'live', upcoming: 'next' };
    const gwWhen = WHEN_MAP[String(args.when ?? '').toLowerCase()] || '';
    const query: Record<string, unknown> = { team, league: args.league, ...(gwWhen ? { when: gwWhen } : {}), ...tz };
    const sports = await runSports(query, gw);
    let synth = templateSports(sports, query, { timezone: ctx.timezone });

    // Robustness fallback when the live slate has no game for the team. Two gaps to
    // cover, both in parallel (only runs on a primary miss):
    //   1. wrong/ambiguous league (e.g. "football" → NFL board for a soccer side)
    //   2. a JUST-finished game that aged off the live slate — `when:'last'` makes the
    //      gateway query a recent DATE WINDOW instead of only the current slate.
    // We retry the model's league AND the major leagues with when='last'.
    if (team && !synth.structured_data && !synth.fallback) {
      const modelLeague = String(args.league ?? '').toLowerCase().replace(/\s+/g, '-')
      const candidates = Array.from(new Set([
        modelLeague,
        'world-cup', 'premier-league', 'champions-league', 'la-liga', 'mls', 'nba', 'mlb', 'nfl', 'nhl',
      ].filter(Boolean)))
      const hits = await Promise.all(candidates.map(async (league) => {
        try {
          const q = { team, league, when: 'last', ...tz }   // date-window query → catches recent finals
          const s = templateSports(await runSports(q, gw), q, { timezone: ctx.timezone });
          return s.structured_data ? s : null;
        } catch { return null; }
      }));
      const hit = hits.find(Boolean);
      if (hit) synth = hit;
    }

    // On a miss, return a SILENT signal (no speakable sentence) so the model doesn't
    // parrot "I couldn't find a game" before falling back to web search — it should
    // just proceed to the fallback and answer once.
    if (!synth.structured_data) {
      return { result: { found: false }, card: null, fallback: synth.fallback };
    }
    return {
      // The model speaks from `voice`; `text` (scorers) is extra context.
      result: { found: true, voice: synth.voice, text: synth.text },
      card: { ...synth.structured_data } as ToolCard,
    };
  },
};
