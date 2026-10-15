/**
 * Wikipedia-then-Commons image resolver: a free, licence-clean candidate to replace Serper on the
 * voice `show_image` path. NOT WIRED into image_search.ts: switching voice off Serper is John's
 * decision, taken on the benchmark (tools/image-bench, EXPECTATIONS-2.md).
 *
 * Why this shape (X's bench, .reference/20261009_IMAGE_PROVIDER_BENCH.md):
 *  1. The Wikipedia article's lead image for the EXACT title (`titles=`, `redirects=1`). When the
 *     query names a thing, this is the canonical picture of it.
 *  2. Otherwise Commons full-text search, keeping Commons' own ranking.
 *  🔴 There is deliberately NO "search for an article" step. Guessing an article from a phrase was
 *  the worst route in the bench (mean 0.40/2): "Eiffel Tower at night" resolved to the Six Flags
 *  replica, "snowy mountain cabin" to Snowy Mountain (New York). That is also why this does not
 *  reuse wikipedia.ts's lookup: its `generator=search` IS that step.
 *
 * Fixes over the shipped webapp provider (wikimedia-search + wikimedia-provider.js):
 *  - Commons results are ordered by search rank (`index`), not by object-key order.
 *  - logo / icon / map / diagram / flag / coat-of-arms titles, SVG and small images are a ranking
 *    PENALTY, never an eliminator: a crest-only result set still answers (BACKLOG 219 threw).
 *  - A disambiguation page is never used.
 *  - No `origin=*` (a browser CORS parameter; this runs server-side).
 */

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'DashieVoiceAssistant/1.0 (https://dashieapp.com; support@dashieapp.com)';
const THUMB_PX = 1280;
const MIN_SIDE_PX = 400;
const PENALISED_TITLE = /\b(logo|icon|map|diagram|flag|coat of arms|crest|seal|emblem|chart|graph|signature)\b/i;

export interface WikiImagePick {
  url: string;              // a THUMB_PX-wide rendition (Wikimedia's own thumbnailer)
  original?: string;
  title: string;            // article title (routes 'wikidata'/'article') or File: title (route 'commons')
  route: 'wikidata' | 'article' | 'commons';
  pageUrl: string;          // where the image is credited
  artist?: string | null;   // Commons only; an article lead image needs a second call for this
  license?: string | null;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson(fetchFn: Fetch, url: string): Promise<any> {
  const resp = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

function qs(params: Record<string, string>): string {
  return new URLSearchParams({ format: 'json', ...params }).toString();
}

/** What the exact-title lookup found. `exists` = there IS a (non-disambiguation) article, even when it has no usable
 *  image: the caller treats a named thing differently from a phrase with no article. */
export interface ArticleLookup { exists: boolean; title?: string; image: WikiImagePick | null }

/** A lead image that illustrates the TOPIC rather than showing the THING: an SVG (logos, diagrams), or a filename that
 *  says logo/diagram/map. Round 2: Tour de France (its logo), sailboat (a sloop diagram). */
export function isTopicIllustration(file: string | undefined): boolean {
  return !!file && (/\.svg$/i.test(file) || PENALISED_TITLE.test(file.replace(/_/g, ' ')));
}

/** One Commons file → a pick with its credit (artist + licence), which CC-BY needs on screen. */
async function commonsFile(file: string, title: string, route: WikiImagePick['route'], fetchFn: Fetch): Promise<WikiImagePick | null> {
  const body = await getJson(fetchFn, `${COMMONS_API}?${qs({
    action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: String(THUMB_PX), iiextmetadatafilter: 'Artist|LicenseShortName',
  })}`);
  const page = Object.values(body?.query?.pages ?? {})[0] as any;
  const ii = page?.imageinfo?.[0];
  if (!ii?.url) return null;
  const meta = ii.extmetadata ?? {};
  return {
    url: ii.thumburl ?? ii.url, original: ii.url, title, route,
    pageUrl: ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`,
    artist: stripHtml(meta.Artist?.value), license: stripHtml(meta.LicenseShortName?.value),
  };
}

/** From the Wikidata item: its curated "image of this subject" (P18, first value) and whether it is a taxon (it has a
 *  taxon rank, P105: only species, genera, families… do). One call: wbgetentities, claims only. */
async function wikidataFacts(qid: string, fetchFn: Fetch): Promise<{ p18: string | null; taxon: boolean }> {
  const body = await getJson(fetchFn, `${WIKIDATA_API}?${qs({ action: 'wbgetentities', ids: qid, props: 'claims' })}`);
  const claims = body?.entities?.[qid]?.claims ?? {};
  const v = claims.P18?.[0]?.mainsnak?.datavalue?.value;
  return { p18: typeof v === 'string' && v ? v : null, taxon: Array.isArray(claims.P105) && claims.P105.length > 0 };
}

/** Step 1: the article whose title IS the query (after redirects, never a disambiguation page). Its image is
 *  Wikidata's P18 first (a photo of the subject, curated), else the article's lead image unless that is a logo or
 *  diagram. pageimages returns FREE images only, so a non-free subject has none. */
export async function articleImage(query: string, fetchFn: Fetch = fetch): Promise<ArticleLookup> {
  const body = await getJson(fetchFn, `${WIKI_API}?${qs({
    action: 'query', titles: query, redirects: '1', prop: 'pageimages|pageprops',
    piprop: 'name', ppprop: 'disambiguation|wikibase_item',
  })}`);
  const page = Object.values(body?.query?.pages ?? {})[0] as any;
  if (!page || 'missing' in page || 'invalid' in page) return { exists: false, image: null };
  if (page.pageprops && 'disambiguation' in page.pageprops) return { exists: false, image: null };
  const title = String(page.title);
  const qid = page.pageprops?.wikibase_item;
  const lead = page.pageimage as string | undefined;
  const facts = qid ? await wikidataFacts(qid, fetchFn).catch(() => ({ p18: null, taxon: false })) : { p18: null, taxon: false };
  const p18 = facts.p18;
  // For a species, P18 is often a museum specimen (the monarch butterfly came back as two pinned specimens), while the
  // article's lead image is a field photo. For everything else P18 is the better photo of the THING (a sewing machine
  // where the article leads with a labelled drawing).
  const leadFirst = facts.taxon;
  const candidates: Array<[string | null | undefined, WikiImagePick['route']]> = leadFirst
    ? [[lead, 'article'], [p18, 'wikidata']]
    : [[p18, 'wikidata'], [lead, 'article']];
  for (const [file, route] of candidates) {
    if (!file || isTopicIllustration(file)) continue;
    const pick = await commonsFile(file, title, route, fetchFn);
    if (pick) return { exists: true, title, image: pick };
  }
  return { exists: true, title, image: null };
}

/** Lower is better. Commons' rank first; a penalised title or a small image sinks below every clean one. */
export function commonsRankScore(p: { index?: number; title?: string; width?: number; height?: number; mime?: string }): number {
  let s = p.index ?? 99;
  if (PENALISED_TITLE.test(p.title ?? '')) s += 100;
  if (p.mime === 'image/svg+xml' || /\.svg$/i.test(p.title ?? '')) s += 100;
  if ((p.width ?? 0) < MIN_SIDE_PX || (p.height ?? 0) < MIN_SIDE_PX) s += 50;
  return s;
}

function stripHtml(s: unknown): string | null {
  const t = typeof s === 'string' ? s.replace(/<[^>]*>/g, '').trim() : '';
  return t || null;
}

/** Step 2: Commons full-text search over files, best by [commonsRankScore]. Null only when Commons has nothing. */
export async function commonsSearchImage(query: string, fetchFn: Fetch = fetch): Promise<WikiImagePick | null> {
  const body = await getJson(fetchFn, `${COMMONS_API}?${qs({
    action: 'query', generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '10',
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: String(THUMB_PX),
    iiextmetadatafilter: 'Artist|LicenseShortName',
  })}`);
  const pages = Object.values(body?.query?.pages ?? {}) as any[];
  const ranked = pages
    .filter((p) => p?.imageinfo?.[0]?.url)
    .map((p) => {
      const ii = p.imageinfo[0];
      return { p, ii, score: commonsRankScore({ index: p.index, title: p.title, width: ii.width, height: ii.height, mime: ii.mime }) };
    })
    .sort((a, b) => a.score - b.score);
  const best = ranked[0];
  if (!best) return null;
  const meta = best.ii.extmetadata ?? {};
  return {
    url: best.ii.thumburl ?? best.ii.url, original: best.ii.url, title: best.p.title, route: 'commons',
    pageUrl: best.ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(best.p.title)}`,
    artist: stripHtml(meta.Artist?.value), license: stripHtml(meta.LicenseShortName?.value),
  };
}

/** Article lead image for the exact title, else Commons. Never guesses an article. A failed call is LOUD and
 *  falls through (step 1) or answers null (step 2); it never throws to the caller. */
export async function resolveWikiImage(query: string, fetchFn: Fetch = fetch): Promise<WikiImagePick | null> {
  const q = query.trim();
  if (!q) return null;
  try {
    const hit = await articleImage(q, fetchFn);
    if (hit.image) return hit.image;
  } catch (e) {
    console.warn(`DROP: wiki_image article lookup FAILED for "${q.slice(0, 60)}" (${(e as Error).message}) → Commons`);
  }
  try {
    return await commonsSearchImage(q, fetchFn);
  } catch (e) {
    console.warn(`DROP: wiki_image Commons search FAILED for "${q.slice(0, 60)}" (${(e as Error).message})`);
    return null;
  }
}
