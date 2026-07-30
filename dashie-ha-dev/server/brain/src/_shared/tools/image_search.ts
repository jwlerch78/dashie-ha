/**
 * Image-search tool — the single image resolver shared by every consumer
 * (cascade brain via the `image` hint, Gemini Live relay via a function call,
 * HTTP gateway). Mirrors sports.ts.
 *
 * Pipeline: serper-image-search edge fn (Google Images via Serper, keeps the API
 * key server-side AND meters the call into the credit ledger) → pick the best
 * result → an {type:'image'} card the channel renders. Zero LLM.
 *
 * Two triggers, one resolver (build plan 20260627_IMAGE_RESPONSE_CARD §3.5):
 *   • Cascade: the brain emits an `image:{searchTerms,criteria,fallback}` hint in
 *     its one-pass turn → the brain calls runImageSearch() + buildImageCard().
 *   • Live: Gemini calls show_image() → the relay runs imageSearchTool.execute().
 * Both emit the identical ImageCard.
 */

import type { ToolCard, ToolContext, ToolDef, ToolResult } from './types.ts';

// deno-lint-ignore no-explicit-any
type SerperImage = Record<string, any>;

export interface ImageCard {
  type: 'image';
  url: string;             // full-res (hotlinked) image; renderer loads this
  thumbnail?: string;      // reliable Google-CDN fallback
  description?: string;    // result title / caption
  source?: string;         // 'serper'
  attribution?: { photographer?: string | null; photographerUrl?: string | null };
}

export interface ImageSynthesis {
  /** What the model speaks/answers from. `source` lets it attribute accurately
   *  (the site Serper found it on) instead of guessing "Wikipedia". */
  result: { found: boolean; description?: string; source?: string | null };
  card: ImageCard | null;
}

// ── gateway fetch ────────────────────────────────────────────────────────────

/** Runtime-agnostic env read: this module runs in the cloud (Deno) AND inside the
 *  add-on's Node brain bundle, where a bare `Deno.env.get` is a ReferenceError.
 *  Callers on Node should pass ctx.supabaseUrl/anonKey (io.toolConn) — this is the
 *  fallback, not the contract. */
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

/** Resolve images via the serper-image-search edge fn. Forwards the USER JWT (so
 *  the edge fn meters + bills the call to the right user); falls back to the anon
 *  key when anonymous (no metering). `sessionId` groups the usage row with its
 *  turn in the console. */
export async function runImageSearch(
  query: string,
  ctx?: { supabaseUrl?: string; anonKey?: string; jwt?: string; sessionId?: string | null },
): Promise<{ images: SerperImage[] }> {
  const url = ctx?.supabaseUrl || envVar('SUPABASE_URL');
  const anon = ctx?.anonKey || envVar('SUPABASE_ANON_KEY');
  const auth = ctx?.jwt ? `Bearer ${ctx.jwt}` : `Bearer ${anon}`;
  const resp = await fetch(`${url}/functions/v1/serper-image-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: auth },
    body: JSON.stringify({ query, perPage: 10, sessionId: ctx?.sessionId ?? null }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.error || body.message || `HTTP ${resp.status}`);
  return { images: Array.isArray(body?.images) ? body.images : [] };
}

// ── official brand assets (short-circuit — no search, no billing) ────────────

/** "Show me the Dashie logo" on open Google Images returns DashieGames (the
 *  YouTuber) — field report 2026-07-12. Brand asks about OUR product must never
 *  go to web search: serve the official asset from the marketing site directly.
 *  Deterministic and pure (no serper call, no metering). */
const OFFICIAL_LOGO_URL = 'https://dashieapp.com/artwork/Dashie_Full_Logo_Orange_Transparent.png';

/** The official card for a Dashie-brand image ask, or null if the query isn't one.
 *  Requires the word "dashie" + a brand term; explicitly NOT DashieGames/DashieXP
 *  (someone genuinely asking about the YouTuber should still get web results). */
export function officialImage(query: string): ImageCard | null {
  const q = query.toLowerCase();
  if (/dashie\s*(games|xp)/.test(q)) return null;
  if (!/\bdashie('s)?\b/.test(q) || !/\b(logo|icon|brand|branding)\b/.test(q)) return null;
  return {
    type: 'image',
    url: OFFICIAL_LOGO_URL,
    thumbnail: OFFICIAL_LOGO_URL,
    description: 'The Dashie logo',
    source: 'dashie-official',
    attribution: { photographer: 'Dashie', photographerUrl: 'https://dashieapp.com' },
  };
}

// ── synthesis (template, no LLM) ─────────────────────────────────────────────

/** Pick the best image: criteria-keyword match against title/source, else the top
 *  Google result. Mirrors serper-provider.js _selectBestImage. */
function selectImage(images: SerperImage[], criteria?: string): SerperImage | null {
  const valid = images.filter((i) => i && i.imageUrl);
  if (valid.length === 0) return null;
  if (!criteria || valid.length === 1) return valid[0];

  const keywords = criteria.toLowerCase().split(/\s+/).filter(Boolean);
  let best = valid[0];
  let bestScore = -Infinity;
  valid.forEach((img, index) => {
    const text = [img.title, img.source, img.domain].filter(Boolean).join(' ').toLowerCase();
    let score = 0;
    for (const k of keywords) if (text.includes(k)) score += 1;
    if (img.title && String(img.title).length > 10) score += 0.5;
    score += Math.max(0, 10 - index) * 0.01; // tie-break toward Google's ranking
    if (score > bestScore) { bestScore = score; best = img; }
  });
  return best;
}

/** Normalize a Serper image → the standard ImageCard. */
export function buildImageCard(img: SerperImage): ImageCard {
  return {
    type: 'image',
    url: img.imageUrl,
    thumbnail: img.thumbnailUrl || img.imageUrl,
    description: img.title || '',
    source: 'serper',
    attribution: {
      photographer: img.source || img.domain || 'Google Images',
      photographerUrl: img.link || null,
    },
  };
}

/** Full resolve → synthesis: fetch, select, build the card. */
export async function synthesizeImage(
  query: string,
  criteria: string | undefined,
  ctx?: { supabaseUrl?: string; anonKey?: string; jwt?: string; sessionId?: string | null },
): Promise<ImageSynthesis> {
  // Official brand asset? Serve it directly — never web-search our own logo.
  const official = officialImage(query);
  if (official) {
    return {
      result: { found: true, description: official.description, source: 'Dashie' },
      card: official,
    };
  }
  const { images } = await runImageSearch(query, ctx);
  const picked = selectImage(images, criteria);
  if (!picked) return { result: { found: false }, card: null };
  const card = buildImageCard(picked);
  return {
    result: { found: true, description: card.description, source: card.attribution?.photographer ?? null },
    card,
  };
}

// ── tool def (function-calling path: Live relay / HTTP gateway) ───────────────

export const imageSearchTool: ToolDef = {
  name: 'show_image',
  description:
    'Display a photo to the user on their screen. Call this for VISUAL topics — a ' +
    'place, landmark, animal, sports team, object, food, person, artwork, etc. — ' +
    'BOTH when the user explicitly asks to see something ("show me a photo of…") ' +
    'AND proactively when a picture would enrich your answer (e.g. naming a famous ' +
    'place or creature). Do NOT call it for non-visual topics (weather, time, math, ' +
    'definitions). Speak a short caption alongside; the picture renders on screen.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to show — concise search terms, e.g. "Eiffel Tower at night".' },
      criteria: { type: 'string', description: 'Optional visual preference to pick the best match, e.g. "wide landscape, daytime".' },
    },
    required: ['query'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args?.query ?? '').trim();
    if (!query) return { result: { found: false }, card: null };
    const criteria = typeof args?.criteria === 'string' ? args.criteria : undefined;
    try {
      const synth = await synthesizeImage(query, criteria, {
        supabaseUrl: ctx.supabaseUrl,
        anonKey: ctx.anonKey,
        jwt: ctx.jwt,
        sessionId: ctx.sessionId ?? null,
      });
      return { result: synth.result, card: synth.card as ToolCard | null };
    } catch (_e) {
      return { result: { found: false }, card: null };
    }
  },
};
