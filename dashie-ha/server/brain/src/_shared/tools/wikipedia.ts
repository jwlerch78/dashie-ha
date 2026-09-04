/**
 * Wikipedia — factual lookup for the "who/what is X" questions that are NOT time-sensitive.
 *
 * WHY A TOOL rather than letting the model answer. Two reasons, and the second is the product one:
 *   1. It is the anti-fabrication lane for STABLE facts. Web search is our lane for things that
 *      change; a model answering "who was Ada Lovelace" from memory is usually right and
 *      occasionally, confidently, wrong — and the failure is silent at a speaker.
 *   2. COST. A Wikipedia lookup is free and one call. Routing these to `web_search` spends a
 *      metered search-provider call on a question whose answer has not changed in a decade.
 *
 * NO KEY, NO BILLING. The MediaWiki API is public and unauthenticated, so — unlike place_search
 * and directions — this tool needs no metering gateway and costs the user nothing.
 *
 * ⚠️ NOT for anything current. "Who is the CEO of X", "who won last night" and any price or score
 * belong on `web_search`: Wikipedia lags live events by hours to days, and its lag is invisible in
 * the response. The description below says so, because the routing decision is the model's.
 */

import type { ToolContext, ToolDef, ToolResult } from './types.ts';

const API = 'https://en.wikipedia.org/w/api.php';
// A descriptive UA is required by the Wikimedia API policy; anonymous scripted traffic gets
// throttled or blocked outright, which would surface here as an unexplained found:false.
const UA = 'DashieVoiceAssistant/1.0 (https://dashieapp.com; support@dashieapp.com)';

/** First N sentences — a voice answer, not an encyclopaedia paragraph. */
export function trimForSpeech(extract: string, maxSentences = 2, maxChars = 400): string {
  const clean = extract.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const sentences = clean.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [clean];
  let out = '';
  for (const s of sentences.slice(0, maxSentences)) {
    if (out.length + s.length > maxChars) break;
    out += s;
  }
  return (out || clean.slice(0, maxChars)).trim();
}

export const wikipediaTool: ToolDef = {
  name: 'wikipedia',
  description:
    'Look up a STABLE encyclopaedic fact — a person, place, organisation, historical event, ' +
    'species, work of art. Use this for "who is/was X", "what is X", "tell me about X" when the ' +
    'answer does not change day to day, instead of answering from memory. ' +
    'Do NOT use it for anything current or time-sensitive — news, prices, scores, who currently ' +
    'holds a job or office, this week\'s anything — use web_search for those, because Wikipedia ' +
    'lags live events. Returns { found: false } when there is no clear article; say you could not ' +
    'find it rather than filling the gap yourself.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The subject to look up, e.g. "Ada Lovelace" or "Mount Rainier".' },
    },
    required: ['query'],
  },
  async execute(args, _ctx: ToolContext): Promise<ToolResult> {
    const query = String(args?.query ?? '').trim();
    if (!query) return { result: { found: false } };

    // One call: search for the best-matching page AND pull its intro extract.
    const url = `${API}?action=query&format=json&origin=*&redirects=1` +
      `&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=1` +
      `&prop=extracts&exintro=1&explaintext=1`;

    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    }).catch((e) => ({ ok: false, status: 0, _e: String(e) } as unknown as Response));

    if (!resp.ok) {
      // Standing rule 2: a fetch failure is LOUD in the log and a MISS to the model — never a
      // silent empty answer the model then papers over with its own recollection.
      await (resp as Response).text?.().catch(() => '');
      console.warn(`DROP: wikipedia HTTP ${resp.status} for "${query.slice(0, 60)}"`);
      return { result: { found: false } };
    }

    const body = await resp.json().catch(() => null);
    const pages = body?.query?.pages;
    if (!pages) return { result: { found: false } };
    // `generator=search` keys pages by pageid; take the first (gsrlimit=1).
    const page = Object.values(pages)[0] as { title?: string; extract?: string } | undefined;
    const summary = trimForSpeech(String(page?.extract ?? ''));
    if (!page?.title || !summary) return { result: { found: false } };

    return {
      result: {
        found: true,
        title: page.title,
        summary,
        source: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
      },
    };
  },
};
