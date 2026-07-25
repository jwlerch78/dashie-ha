/**
 * Sports SLATE synthesis — the multi-game ("agenda") path for get_sports_scores.
 *
 * Where sports.ts picks ONE game and builds one rich card, this takes the gateway's
 * full slate and produces a COMPACT list: a `games[]` card (rendered as inline cards or
 * an agenda popup, tiered by count like the calendar agenda) plus a brief spoken line
 * (count + 1–2 highlights — never read every game aloud). Zero LLM.
 *
 * Mirrors the calendar agenda idiom (js/core/voice/calendar-template.js listLine): the
 * card carries the full day; the voice names only a couple. Shares the per-state helpers
 * (deriveState/scheduleWhen/…) with sports.ts so single + slate phrase times identically.
 *
 * @see .reference/build-plans/20260630_SPORTS_MULTI_GAME_SLATE.md
 */

import type { ToolCard } from './types.ts';
import {
  clockTime, deriveState, type Game, relativeDay, scheduleWhen, type SportsResult,
  type State, tidyDetail,
} from './sports.ts';

/** Compact per-game entry for the slate card. Lighter than the rich SportsCard — no
 *  R/H/E lines or scorer highlights; a slate row shows score-or-time + the matchup. */
export interface SportsSlateEntry {
  state: State;
  detail?: string;        // "Today, 5:45 PM" (pre) · live clock (in) · "Final · Sat, Jun 27" (post)
  startTime?: string;     // ISO — the renderer day-groups/sorts on this
  home: { name: string; score: number | null; logo?: string; short?: string; abbr?: string };
  away: { name: string; score: number | null; logo?: string; short?: string; abbr?: string };
  winner?: 'home' | 'away' | null;
}

export interface SportsSlateCard {
  type: 'sports';
  league?: string;
  games: SportsSlateEntry[];
  total: number;
}

export interface SportsSlateSynthesis {
  voice: string;
  structured_data: SportsSlateCard | null;
}

/** Cap the carded slate (the spoken line still reports the true total) — keeps a wide
 *  query from building a giant popup, mirroring calendar's buildCard slice(0,60). */
const MAX_SLATE = 60;

const STATE_RANK: Record<State, number> = { in: 0, pre: 1, post: 2 };

/** Live first, then upcoming soonest-first, then finals most-recent-first. */
function compareGames(a: Game, b: Game): number {
  const sa = deriveState(a), sb = deriveState(b);
  if (STATE_RANK[sa] !== STATE_RANK[sb]) return STATE_RANK[sa] - STATE_RANK[sb];
  const ta = Date.parse(a.startTime || '') || 0;
  const tb = Date.parse(b.startTime || '') || 0;
  return sa === 'post' ? tb - ta : ta - tb;   // finals newest-first; pre/in oldest-first
}

function entryFor(g: Game, tz?: string): SportsSlateEntry {
  const state = deriveState(g);
  const date = relativeDay(g.startTime, tz);
  const detail = state === 'pre' ? (scheduleWhen(g, tz) || tidyDetail(g.detail))
    : state === 'post' ? (date ? `Final · ${date}` : (tidyDetail(g.detail) || 'Final'))
    : (tidyDetail(g.detail) || '');   // 'in' → live clock
  return {
    state,
    detail,
    startTime: g.startTime,
    // A PRE/future game has no score — force null even when the provider sends 0 (ESPN → "0"),
    // so a slate row shows the kickoff time, not a misleading "0". Mirrors the single-card rule.
    // short/abbr = compact display forms for the stacked slate rows ("Diamondbacks"/"ARI").
    home: { name: g.home || '', score: state === 'pre' ? null : (g.homeScore ?? null), logo: g.homeLogo, short: g.homeShort, abbr: g.homeAbbr },
    away: { name: g.away || '', score: state === 'pre' ? null : (g.awayScore ?? null), logo: g.awayLogo, short: g.awayShort, abbr: g.awayAbbr },
    winner: g.winner ?? null,
  };
}

// Pretty league/competition label for the spoken line ("world-cup" → "World Cup").
const LEAGUE_LABELS: Record<string, string> = {
  mlb: 'MLB', nba: 'NBA', nfl: 'NFL', nhl: 'NHL', wnba: 'WNBA', mls: 'MLS',
  'world-cup': 'World Cup', 'premier-league': 'Premier League', epl: 'Premier League',
  'champions-league': 'Champions League', ucl: 'Champions League', 'la-liga': 'La Liga',
};
function leagueLabel(league?: string): string {
  const key = String(league || '').toLowerCase().trim().replace(/\s+/g, '-');
  if (LEAGUE_LABELS[key]) return LEAGUE_LABELS[key];
  if (!key) return '';
  return key.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** A shared day label when every game falls on the same day ("today" / "tomorrow" /
 *  "on Saturday"), else '' — so a one-day slate reads "3 games today" not a bare count. */
function sharedDayLabel(games: Game[], tz?: string): string {
  const days = new Set(games.map((g) => relativeDay(g.startTime, tz)).filter(Boolean));
  if (days.size !== 1) return '';
  const d = [...days][0];
  if (d === 'Today') return 'today';
  if (d === 'Tomorrow') return 'tomorrow';
  if (d === 'Yesterday') return 'yesterday';
  return `on ${d.replace(/^\w{3}, /, '')}`;   // "Sat, Jun 27" → "on Jun 27"
}

/** One game → a short spoken clause for the highlight names. */
function clause(g: Game, tz?: string): string {
  const state = deriveState(g);
  const away = g.away || 'TBD', home = g.home || 'TBD';
  if (state === 'in') return `${away} ${g.awayScore ?? 0}, ${home} ${g.homeScore ?? 0}`;
  if (state === 'post') {
    const hs = g.homeScore ?? 0, as = g.awayScore ?? 0;
    if (hs === as && !g.winner) return `${away} and ${home} tied ${as}–${hs}`;
    const homeWon = g.winner ? g.winner === 'home' : hs > as;
    const [w, ws, l, ls] = homeWon ? [home, hs, away, as] : [away, as, home, hs];
    return `${w} beat ${l} ${ws}–${ls}`;
  }
  const t = clockTime(g.startTime, tz);
  return `${away} vs ${home}${t ? ` at ${t}` : ''}`;
}

function slateVoice(games: Game[], query: Record<string, unknown>, tz?: string): string {
  const total = games.length;
  const team = String(query?.team ?? '').trim();
  const label = leagueLabel(query?.league as string | undefined);
  const day = sharedDayLabel(games, tz);
  const noun = `game${total === 1 ? '' : 's'}`;
  const head = team
    ? `${team} have ${total} ${day ? '' : 'upcoming '}${noun}${day ? ` ${day}` : ''}`.replace(/\s+/g, ' ')
    : `There ${total === 1 ? 'is' : 'are'} ${total} ${label ? `${label} ` : ''}${noun}${day ? ` ${day}` : ''}`;
  const picks = games.slice(0, 2).map((g) => clause(g, tz)).filter(Boolean);
  if (picks.length === 0) return `${head}.`;
  const list = picks.length >= 2 ? `${picks[0]}, and ${picks[1]}` : picks[0];
  return `${head}: ${list}.`;
}

/**
 * Template a slate answer from the gateway result + the query.
 * @param opts.timezone IANA tz for kickoff times in the user's zone.
 */
export function templateSlate(
  result: SportsResult,
  query: Record<string, unknown>,
  opts?: { timezone?: string },
): SportsSlateSynthesis {
  const tz = opts?.timezone;
  const all = (Array.isArray(result?.games) ? result.games : []) as Game[];
  if (all.length === 0) return { voice: '', structured_data: null };

  const sorted = all.slice().sort(compareGames);
  const card: SportsSlateCard = {
    type: 'sports',
    league: String(query?.league ?? '') || undefined,
    games: sorted.slice(0, MAX_SLATE).map((g) => entryFor(g, tz)),
    total: sorted.length,
  };
  return { voice: slateVoice(sorted, query, tz), structured_data: card };
}

/** Convenience: the slate card as a plain ToolCard (the dispatch reads `card.type`). */
export function slateCard(synth: SportsSlateSynthesis): ToolCard | null {
  return synth.structured_data ? ({ ...synth.structured_data } as ToolCard) : null;
}
