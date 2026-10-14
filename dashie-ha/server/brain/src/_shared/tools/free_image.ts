/**
 * The FREE picture source for `show_image` when the household has no credits (John 10-13: "I need a good image search
 * source when the user doesn't have credits (which no one will be using for MVP)"). NOT WIRED yet: the bench decides.
 *
 * Routing, one decision per query:
 *  1. The query names a Wikipedia article (exact title, after redirects) → Wikidata's curated photo of the subject,
 *     else the article's lead image unless it is a logo or diagram. (wiki_image.ts)
 *  2. Otherwise (a scene, or a thing plus a modifier: "at night", "aerial view of") → a Pexels stock photo. Commons
 *     matches filenames and was weakest exactly here in round 2. (stock_image.ts)
 *  3. Commons full-text search, as the last resort for both: a named thing with no free image, or a stock miss.
 * Never guesses an article from a phrase: that route was the worst in round 1 (the Six Flags Eiffel Tower).
 */

import { articleImage, commonsSearchImage, type WikiImagePick } from './wiki_image.ts';
import { pexelsImage, type StockCtx, type StockImagePick } from './stock_image.ts';

export type FreeImagePick = WikiImagePick | (StockImagePick & { artistUrl?: string | null });

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A capitalised word after the first ("Eiffel Tower at night", "a photo of Paris"). The first word is skipped because
 *  a sentence-cased query capitalises it anyway. */
export function hasProperNoun(q: string): boolean {
  return q.trim().split(/\s+/).slice(1).some((w) => /^[A-Z][a-z]/.test(w)) || /^[A-Z][a-z]+\s+[A-Z]/.test(q.trim());
}

function drop(step: string, q: string, e: unknown) {
  console.warn(`DROP: free_image ${step} FAILED for "${q.slice(0, 60)}" (${(e as Error)?.message ?? e}) → next source`);
}

export async function resolveFreeImage(query: string, ctx: StockCtx, fetchFn: Fetch = fetch): Promise<FreeImagePick | null> {
  const q = query.trim();
  if (!q) return null;
  let named = false;
  try {
    const hit = await articleImage(q, fetchFn);
    if (hit.image) return hit.image;
    named = hit.exists;
  } catch (e) { drop('article lookup', q, e); }

  // A named thing (an article with no free image, or a phrase carrying a proper noun: "Eiffel Tower at night") stays
  // on Wikimedia first: stock search for a proper noun returns lookalikes (Pexels answered "Eiffel Tower at night" with
  // the replica in Macao), while Commons filenames carry real place names. A generic phrase goes to stock first.
  const order: Array<() => Promise<FreeImagePick | null>> = named || hasProperNoun(q)
    ? [() => commonsSearchImage(q, fetchFn), () => pexelsImage(q, ctx, fetchFn)]
    : [() => pexelsImage(q, ctx, fetchFn), () => commonsSearchImage(q, fetchFn)];
  for (const step of order) {
    try {
      const pick = await step();
      if (pick) return pick;
    } catch (e) { drop('search', q, e); }
  }
  return null;
}
