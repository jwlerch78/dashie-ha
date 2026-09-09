/**
 * place_search + directions — the two Google Maps tools, both routed through `maps-gateway`.
 *
 * NO KEY HERE, BY DESIGN. Google Maps calls are billable, so per the tools README a paid API is
 * reached through a metering gateway with the user's JWT forwarded — never with a key held in the
 * tool. That is also what puts these on the SAME credit balance as every other tool.
 *
 * `place_search` answers "where's the nearest…", "what's the address of…", "is X open".
 * `directions`   answers "how far is…", "how long to drive to…".
 *
 * ⚠️ Neither invents on a miss. Google signals ZERO_RESULTS inside a 200, and the gateway passes
 * that through as an empty result rather than an error — so both tools return { found: false }
 * and the prompt tells the model to say so rather than reach for its own recollection.
 */

import type { ToolContext, ToolDef, ToolResult } from './types.ts';

async function callGateway(op: string, payload: Record<string, unknown>, ctx: ToolContext) {
  const url = `${ctx.supabaseUrl}/functions/v1/maps-gateway`;
  // Forward the USER JWT so the gateway can attribute, gate and debit the paid call; fall back to
  // the anon key for anonymous callers, which the gateway's auth gate then rejects if enforcing.
  const auth = ctx.jwt ? `Bearer ${ctx.jwt}` : `Bearer ${ctx.anonKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ctx.anonKey ?? '', Authorization: auth },
    body: JSON.stringify({ op, sessionId: ctx.sessionId ?? null, ...payload }),
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => ({ ok: false, status: 0, _e: String(e) } as unknown as Response));
  if (!resp.ok) {
    await (resp as Response).text?.().catch(() => '');
    console.warn(`DROP: maps tool '${op}' gateway HTTP ${resp.status}`);
    return null;
  }
  return await resp.json().catch(() => null);
}

/** Metres → a distance a person would say out loud. */
export function spokenDistance(meters: number): string {
  const miles = meters / 1609.344;
  if (miles < 0.2) return `${Math.round(meters / 0.3048 / 10) * 10} feet`;
  if (miles < 10) return `${miles.toFixed(1)} miles`;
  return `${Math.round(miles)} miles`;
}

/** Seconds → a duration a person would say out loud. */
export function spokenDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} minute${m === 1 ? '' : 's'}` : ''}`;
}

/** Words that mean the model has ALREADY put a place in the query. */
const EXPLICIT_PLACE = /\b(near|around|close to|in|at|on)\b/i;

/**
 * Self-referential "where I am" phrasings, which name NO place and must not suppress the bias.
 *
 * 🔴 THIS EXISTS BECAUSE THE FIRST VERSION SHIPPED WITHOUT IT AND DID NOTHING (staging v185,
 * 2026-09-09, caught by running the feature instead of trusting its unit tests). `EXPLICIT_PLACE`
 * included `nearby` and matched the bare word `near`, so the model's own phrasings —
 * `"hardware store near me"`, `"coffee shop nearby"` — tripped the "the user named a place" guard
 * and the household location was never appended. Those are precisely the queries that need it: a
 * bare `"hardware store"` got biased correctly, while the far more common `"… near me"` did not.
 * Measured on the deployed function: 3 of 3 place_search turns came back with the same
 * out-of-state businesses as before the fix.
 *
 * 📌 The unit tests did not catch it because I chose the examples. Every "must not re-bias" case I
 * wrote named a REAL place (`"coffee shop near Tampa"`, `"pizza in Orlando"`) — the guard's happy
 * path. I never wrote `"near me"`, so the suite proved the guard fires and never asked whether it
 * fires too often. A test written by the same person who wrote the guard inherits its blind spot;
 * only the live run had a different opinion.
 */
const SELF_REFERENTIAL = /\b(?:near|around|close to|next to)\s+(?:me|us|here|my\s+(?:home|house|place)|our\s+(?:home|house))\b|\bnearby\b|\baround here\b|\bin\s+my\s+area\b/gi;

/**
 * Bias a place query toward where the household actually is (need ⑧).
 *
 * The maps gateway biases on `location`+`radius` — i.e. lat/lng — and NOTHING in this system
 * produces coordinates (see `ToolContext.location`). Google's Places **textsearch** endpoint,
 * which is what the gateway calls, resolves a place named in the query text, so appending the
 * household's own location is a real bias with no geocoder, no new gateway op, and no deploy of
 * another function. That trade was John's call, 2026-09-09.
 *
 * 🔴 THE GUARD IS THE LOAD-BEARING PART, not the append. If the user says "coffee shop near Tampa"
 * and the household is in Clearwater, appending gives "coffee shop near Tampa near Clearwater, FL"
 * — which FIGHTS an explicit request the user made out loud. Silently overriding what someone
 * asked for is a worse failure than the unbiased search this replaces, because it is invisible:
 * they get a confident answer about the wrong city. So the household location is added ONLY when
 * the query names no place of its own. When in doubt, do nothing — an unbiased search is the
 * status quo, and the status quo is not a regression.
 *
 * The reverse case is deliberately NOT guarded: if the user names their OWN town the append is
 * skipped anyway (the query names a place), and if the guard is too eager we lose a bias we never
 * had. Both failure directions cost at most today's behaviour.
 */
export function biasQuery(query: string, location: ToolContext['location']): string {
  const where = typeof location === 'string' ? location.trim() : '';
  if (!where) return query;
  // Strip "near me"/"nearby"/"around here" FIRST — they are the user saying "where I am", which is
  // a request for the bias, not a place that competes with it. Only then ask whether what remains
  // names somewhere. Order matters: testing the raw query is what made the first version inert.
  const stripped = query.replace(SELF_REFERENTIAL, ' ').replace(/\s+/g, ' ').trim();
  if (EXPLICIT_PLACE.test(stripped)) return query;
  if (query.toLowerCase().includes(where.toLowerCase())) return query;
  // Bias the STRIPPED text, so "coffee shop nearby" becomes "coffee shop near 33756" rather than
  // "coffee shop nearby near 33756". Falls back to the original if stripping emptied it.
  return `${stripped || query} near ${where}`;
}

export const placeSearchTool: ToolDef = {
  name: 'place_search',
  description:
    'Find a real-world place — a business, restaurant, shop, park, landmark — and get its name, ' +
    'address, rating and whether it is open now. Use for "where is the nearest X", "what\'s the ' +
    'address of X", "find a coffee shop nearby", "is X open". Pass the user\'s own words as the ' +
    'query. Returns { found: false } when there is no match — say so rather than guessing an ' +
    'address, which is never safe to invent.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look for, e.g. "coffee shop near Clearwater" or "Publix on Gulf to Bay".' },
    },
    required: ['query'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args?.query ?? '').trim();
    if (!query) return { result: { found: false } };
    const near = typeof ctx.location === 'object' && ctx.location ? ctx.location : undefined;
    const body = await callGateway('places', {
      query: biasQuery(query, ctx.location),
      near: (typeof near?.lat === 'number' && typeof near?.lng === 'number') ? near : undefined,
    }, ctx);
    const list = (body?.results ?? []) as Array<Record<string, unknown>>;
    if (!list.length) return { result: { found: false } };
    const places = list.slice(0, 3).map((p) => ({
      name: p.name,
      address: p.formatted_address,
      rating: p.rating ?? null,
      open_now: (p.opening_hours as { open_now?: boolean } | undefined)?.open_now ?? null,
    }));
    return { result: { found: true, places, count: places.length } };
  },
};

export const directionsTool: ToolDef = {
  name: 'directions',
  description:
    'How far away somewhere is and how long it takes to get there, in current traffic. Use for ' +
    '"how far is X", "how long to drive to X", "how long to walk to X". Give origin and ' +
    'destination as plain place names or addresses. Returns { found: false } when the route ' +
    'cannot be worked out — say so rather than estimating a drive time yourself.',
  parameters: {
    type: 'object',
    properties: {
      origin: { type: 'string', description: 'Starting point — an address or place name. Use "home" only if the user said it.' },
      destination: { type: 'string', description: 'Where they are going — an address or place name.' },
      mode: { type: 'string', description: 'driving | walking | bicycling | transit. Defaults to driving.' },
    },
    required: ['origin', 'destination'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const origin = String(args?.origin ?? '').trim();
    const destination = String(args?.destination ?? '').trim();
    if (!origin || !destination) return { result: { found: false } };
    const body = await callGateway('distance', { origin, destination, mode: args?.mode }, ctx);
    const el = (body?.results?.[0] as { elements?: Array<Record<string, unknown>> } | undefined)?.elements?.[0];
    if (!el || el.status !== 'OK') return { result: { found: false } };
    const meters = Number((el.distance as { value?: number } | undefined)?.value ?? NaN);
    // Prefer duration_in_traffic when Google returns it — that is the number a person wants.
    const seconds = Number(
      (el.duration_in_traffic as { value?: number } | undefined)?.value ??
      (el.duration as { value?: number } | undefined)?.value ?? NaN);
    if (!Number.isFinite(meters) || !Number.isFinite(seconds)) return { result: { found: false } };
    return {
      result: {
        found: true,
        distance: spokenDistance(meters),
        duration: spokenDuration(seconds),
        destination_address: body?.destination_addresses?.[0] ?? destination,
        in_traffic: el.duration_in_traffic !== undefined,
      },
    };
  },
};
