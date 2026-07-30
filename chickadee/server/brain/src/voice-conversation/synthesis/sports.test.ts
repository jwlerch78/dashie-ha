// sports.test.ts — unit tests for the Tier-1 sports template (no LLM).
// Run: deno test synthesis/sports.test.ts

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { templateSports } from './sports.ts';

const res = (games: unknown[]) => ({ provider: 'espn', query: {}, games, latency: 0 } as never);

Deno.test('final game → "beat" with score + scorer + post card', () => {
  const s = templateSports(res([{
    league: 'nfl', status: 'Final', home: 'Eagles', away: 'Cowboys',
    homeScore: 24, awayScore: 17, winner: 'home',
    events: [{ player: 'Saquon Barkley', side: 'home', scoreValue: 6 }],
    homeRecord: '2-0', awayRecord: '1-1',
  }]), { team: 'eagles', when: 'last' });
  assertEquals(s.voice, 'Eagles beat Cowboys 24 to 17.'); // scorers NOT in the spoken line
  assertEquals(s.text, 'Scorers: Saquon Barkley');         // …they go in the subtext
  assertEquals(s.structured_data?.state, 'post');
  assertEquals(s.structured_data?.winner, 'home');
  assertEquals(s.structured_data?.home.record, '2-0');
});

Deno.test('multi-goal scorer grouped in subtext + card', () => {
  const s = templateSports(res([{
    league: 'fifa.world', status: 'Final', home: 'Portugal', away: 'Uzbekistan',
    homeScore: 5, awayScore: 0, winner: 'home',
    events: [
      { player: 'Cristiano Ronaldo', side: 'home', scoreValue: 1, clock: "12'" },
      { player: 'Cristiano Ronaldo', side: 'home', scoreValue: 1, clock: "34'" },
      { player: 'Bruno Fernandes', side: 'home', scoreValue: 1, clock: "56'" },
    ],
  }]), { team: 'portugal', when: 'last' });
  assertEquals(s.voice, 'Portugal beat Uzbekistan 5 to 0.');
  assertEquals(s.text, "Scorers: Cristiano Ronaldo (12', 34'), Bruno Fernandes (56')");
  assertEquals(s.structured_data?.scorers?.length, 2); // grouped: 2 players, not 3 goals
  assertEquals(s.structured_data?.scorers?.[0].clocks, ["12'", "34'"]);
});

Deno.test('no team AND no directed when → fallback to slate/2-pass LLM', () => {
  // NOTE: type:'schedule' resolves to when='next' (a directed when), so a teamless
  // query only punts when neither team nor when/type points at one game. The
  // teamless+directed shape (relay-only) is covered in _shared/tools/sports.test.ts.
  const s = templateSports(res([
    { league: 'fifa.world', status: 'Scheduled', home: 'Bosnia', away: 'Qatar', homeScore: null, awayScore: null },
    { league: 'fifa.world', status: 'Scheduled', home: 'Brazil', away: 'Japan', homeScore: null, awayScore: null },
  ]), { league: 'world-cup' });
  assertEquals(s.fallback, true);
  assertEquals(s.structured_data, null);
});

Deno.test('scheduled with bare "Scheduled" detail → no bogus time appended', () => {
  const s = templateSports(res([{
    league: 'mlb', status: 'Scheduled', detail: 'Scheduled',
    home: 'Athletics', away: 'San Francisco Giants', homeScore: null, awayScore: null,
  }]), { team: 'giants', when: 'next' });
  assertEquals(s.voice, 'San Francisco Giants play Athletics.'); // not "…Athletics Scheduled."
});

Deno.test('live game → live score line + in card', () => {
  const s = templateSports(res([{
    league: 'mlb', status: 'In Progress', detail: 'Top 7th',
    home: 'Dodgers', away: 'Giants', homeScore: 3, awayScore: 2,
  }]), { team: 'dodgers', when: 'live' });
  assertEquals(s.voice, 'Giants 2, Dodgers 3, Top 7th.');
  assertEquals(s.structured_data?.state, 'in');
});

Deno.test('scheduled game → "play the" + pre card', () => {
  const s = templateSports(res([{
    league: 'mlb', status: 'Scheduled', detail: 'Sun 1:10 PM',
    home: 'Red Sox', away: 'Yankees', homeScore: null, awayScore: null,
  }]), { team: 'yankees', when: 'next' });
  // tidyDetail expands the weekday and keeps AM/PM (it strips only a trailing tz abbr);
  // scheduledLine adds the comma pause.
  assertEquals(s.voice, 'Yankees play Red Sox, Sunday 1:10 PM.');
  assertEquals(s.structured_data?.state, 'pre');
});

Deno.test('tense guard: when=last but only a scheduled game → graceful, not a future result', () => {
  const s = templateSports(res([{
    league: 'nfl', status: 'Scheduled', detail: 'Sun 1:00 PM',
    home: 'Jets', away: 'Bills', homeScore: null, awayScore: null,
  }]), { team: 'jets', when: 'last' });
  assert(s.voice.includes("couldn't find a recent"));
  assert(s.voice.includes('next game'));
  assertEquals(s.structured_data?.state, 'pre');
});

Deno.test('no games → graceful, no card', () => {
  const s = templateSports(res([]), { team: 'Eagles', when: 'last' });
  assert(s.voice.includes("couldn't find"));
  assertEquals(s.structured_data, null);
});

Deno.test('tie game → "tied"', () => {
  const s = templateSports(res([{
    league: 'epl', status: 'Final', home: 'Arsenal', away: 'Chelsea',
    homeScore: 1, awayScore: 1, winner: null,
  }]), { team: 'arsenal', when: 'last' });
  assertEquals(s.voice, 'Arsenal and Chelsea tied 1 to 1.');
});

Deno.test('picks the asked team among multiple games', () => {
  const s = templateSports(res([
    { league: 'nba', status: 'Final', home: 'Celtics', away: 'Knicks', homeScore: 100, awayScore: 90, winner: 'home' },
    { league: 'nba', status: 'Final', home: 'Lakers', away: 'Suns', homeScore: 110, awayScore: 108, winner: 'home' },
  ]), { team: 'lakers', when: 'last' });
  assertEquals(s.voice, 'Lakers beat Suns 110 to 108.');
});

Deno.test('older `type:score` (no `when`) still resolves to last', () => {
  const s = templateSports(res([{
    league: 'nfl', status: 'Final', home: 'Eagles', away: 'Cowboys',
    homeScore: 24, awayScore: 17, winner: 'home',
  }]), { team: 'eagles', type: 'score' });
  assertEquals(s.voice, 'Eagles beat Cowboys 24 to 17.');
});
