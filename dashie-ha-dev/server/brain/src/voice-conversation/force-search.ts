// force-search.ts — deterministic "mutable-entity" detector (build-plan §23.5).
//
// AUTHORITATIVE copy. Fact queries about entities whose answer changes over time
// — current officeholders (president/PM/mayor/pope…), executives (CEO/chairman…),
// and sports champions — are answered from a model's stale training memory unless
// forced to search: the routing/hallucination probe (tools/voice-bench/probe.ts)
// found gemini-flash AND nova-2-lite NEVER search officeholder queries (0%) and
// are 50–78% stale (e.g. "Joe Biden" as US president in 2026), and that explicit
// recency markers ("current", "right now") do NOT trigger a search. The reliable
// signal is the entity CLASS, so the brain runs this deterministic gate BEFORE
// pass-1 and force-routes a match to web_search — covering every surface (console,
// cloud, HA-via-brain) from one place rather than per-client copies that drift.
//
// Surface-agnostic on purpose: the detector decides "force web_search"; WHERE the
// search resolves (cloud Tavily today, HA-hosted SearXNG in a future fully-local
// stack) stays behind the web-search-gateway provider abstraction. Crossing that
// bridge is a provider swap, not a routing change.
//
// Ported from js/core/intent-classifier/classifiers/websearch-intents.js — once
// this brain gate ships and is validated, the client copy is retired (one source
// of truth). Precision over recall for v1: anchored on "who…" phrasings.

// Mutable positions whose holder changes over time. Longer phrases must win over
// shorter substrings ("prime minister" before "minister") — alt() sorts by length.
const ROLE_WORDS = [
  'president', 'vice president', 'prime minister', 'pm', 'chancellor', 'premier',
  'chief minister', 'mayor', 'governor', 'senator',
  'ceo', 'chief executive', 'cfo', 'coo', 'chairman', 'chairwoman', 'chairperson',
  'pope', 'king', 'queen', 'monarch', 'emperor',
  'leader', 'secretary general', 'secretary-general', 'director general',
  'head coach', 'manager', 'commissioner',
];

const TITLE_WORDS = [
  'champion', 'champions', 'world champion', 'reigning champion', 'defending champion',
  'title holder', 'world number one', 'number one', 'mvp',
];
const EVENT_WORDS = [
  'super bowl', 'world series', 'world cup', 'nba finals', 'nba championship',
  'stanley cup', 'champions league', 'masters', 'wimbledon', 'us open',
  'election', 'grand prix', 'f1 championship',
];

// "who runs/leads/heads/owns X" — an exec query with no role noun ("who runs twitter").
const LEAD_VERBS = ['runs', 'leads', 'heads', 'owns', 'founded', 'controls'];

/** Regex-safe alternation, longest-first so multi-word phrases match before substrings. */
function alt(words: string[]): string {
  return words
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

// (a) role + (optional) modifier:  "who is the [current] {role} …"
const ROLE_RE = new RegExp(
  `\\bwho(?:'s| is| are| was| were)?\\s+(?:the\\s+)?(?:current|sitting|reigning|new|incoming|present)?\\s*(?:${alt(ROLE_WORDS)})\\b`,
  'i',
);
// (b) "who runs/leads/heads/owns {thing}"
const LEAD_RE = new RegExp(`\\bwho\\s+(?:${alt(LEAD_VERBS)})\\s+\\w+`, 'i');
// (c) reigning title:  "who is the current/reigning/defending [nba] {title}"
const TITLE_RE = new RegExp(
  `\\bwho(?:'s| is| are)?\\s+(?:the\\s+)?(?:current|reigning|defending)\\s+(?:[\\w-]+\\s+){0,2}(?:${alt(TITLE_WORDS)})\\b`,
  'i',
);
// (d) recent result:  "who won the [most recent/last] {event|title}"
const WON_RE = new RegExp(
  `\\bwho\\s+won\\s+(?:the\\s+)?(?:(?:most recent|last|latest|current)\\s+)?(?:${alt([...EVENT_WORDS, ...TITLE_WORDS])})\\b`,
  'i',
);

// A specific past year ⇒ historical/evergreen fact (the model knows it) — don't force.
const EXPLICIT_YEAR_RE = /\b(?:18|19|20)\d\d\b/;
// Personal/family subjects belong to the family tools, never web_search.
const FAMILY_RE =
  /\b(?:my|our|your|his|her|their)\s+(?:family|mom|mother|dad|father|sister|brother|son|daughter|kids?|child|children|wife|husband|grandma|grandpa|aunt|uncle|cousin|parents?)\b/i;

export type MutableEntityKind = 'role' | 'lead' | 'title' | 'won';

/**
 * Detect a mutable-entity fact query that must be force-routed to web_search.
 * @returns the match kind, or null if the text should route normally.
 */
export function detectMutableEntity(text: string): MutableEntityKind | null {
  const normalized = (text || '').toLowerCase().trim().replace(/[.,!?;:]+$/g, '');
  if (!normalized) return null;

  // Guards: personal/family subjects and year-qualified historical facts opt out.
  if (FAMILY_RE.test(normalized)) return null;
  if (EXPLICIT_YEAR_RE.test(normalized)) return null;

  if (ROLE_RE.test(normalized)) return 'role';
  if (LEAD_RE.test(normalized)) return 'lead';
  if (TITLE_RE.test(normalized)) return 'title';
  if (WON_RE.test(normalized)) return 'won';
  return null;
}
