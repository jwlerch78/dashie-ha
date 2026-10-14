/**
 * Free stock photo for a query with no Wikipedia article: generic scenes and modifiers ("foggy forest", "Eiffel Tower
 * at night"). Round 2 measured Commons as weakest exactly there: it matches FILENAMES. Stock search is built for it.
 *
 * Pexels, through the existing `pexels-search` edge function, so the key stays server-side. Free; the API asks for a
 * credit to the photographer and a link to Pexels, both carried on the pick. ⚠️ Default limit 200 requests/hour,
 * 20 000/month (Pexels raises it free on request for attributing apps): a fleet-wide ceiling, not per household.
 */

export interface StockImagePick {
  url: string;
  title: string;            // Pexels' alt text
  route: 'pexels';
  pageUrl: string;          // the photo's page on Pexels
  artist: string | null;    // photographer
  artistUrl: string | null;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface StockCtx { supabaseUrl: string; anonKey: string; jwt?: string }

/** The top landscape Pexels result, or null. Throws on a transport/HTTP failure (the caller logs and falls through). */
export async function pexelsImage(query: string, ctx: StockCtx, fetchFn: Fetch = fetch): Promise<StockImagePick | null> {
  const resp = await fetchFn(`${ctx.supabaseUrl}/functions/v1/pexels-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ctx.anonKey, Authorization: `Bearer ${ctx.jwt || ctx.anonKey}` },
    body: JSON.stringify({ query, orientation: 'landscape', perPage: 5 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`pexels-search HTTP ${resp.status}`);
  const body = await resp.json();
  // deno-lint-ignore no-explicit-any
  const p = (Array.isArray(body?.photos) ? body.photos : []).find((x: any) => x?.src?.large2x || x?.src?.large);
  if (!p) return null;
  return {
    url: p.src.large2x ?? p.src.large, title: String(p.alt ?? ''), route: 'pexels',
    pageUrl: String(p.url ?? 'https://www.pexels.com'), artist: p.photographer ?? null, artistUrl: p.photographer_url ?? null,
  };
}
