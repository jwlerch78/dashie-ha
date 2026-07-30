/**
 * dashie_help — product-knowledge retrieval tool (the anti-hallucination guardrail).
 *
 * When a user asks what Dashie is, how to do something, where a setting lives, or how to
 * fix a problem, the model calls this instead of web-searching (a web search on "Dashie"
 * returns other products) or answering from stale training priors. It retrieves curated
 * chunks from the bundled KB (js/ai/knowledge/dashie-kb/*.md → dashie-kb.generated.ts via
 * scripts/bundle-dashie-kb.js) and the model synthesizes the answer from them.
 *
 * Kind A (edge-fetched, stateless, pure) — but with NO network: retrieval is deterministic
 * keyword scoring over the bundled chunks. No card, no billing. Design:
 * .reference/build-plans/20260711_DASHIE_SKILL_DESIGN.md. The retrieval interface (question
 * in, ranked chunks out) is the seam to swap in embeddings later without changing the
 * tool's contract.
 *
 * Miss rule (README rule 3): no match → { result: { found: false } } — never a speakable
 * sentence. Pricing/plan questions intentionally miss (no pricing chunks are authored while
 * the credits model is in flux); the model defers rather than quoting a stale price.
 */

import type { ToolContext, ToolDef, ToolResult } from './types.ts';
import { KB_CHUNKS, type KbChunk } from './dashie-kb.generated.ts';

/** Words too common to carry signal — kept minimal; chunk titles are question-shaped, so
 *  question words ("how", "where") would otherwise match every chunk equally. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'do', 'does', 'for', 'how', 'i', 'in', 'is', 'it', 'my',
  'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where', 'which', 'why', 'with', 'you',
  'about', 'me', 'tell', // conversational filler — "tell me about X" must score only on X
  'dashie', 'dashies', // present in nearly every chunk — zero discrimination
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Naive singular/plural folding so "calendars" matches "calendar". */
function stem(w: string): string {
  return w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w;
}

interface Scored {
  chunk: KbChunk;
  score: number;
}

/** Deterministic keyword scoring: title hits dominate (the titles are the questions users
 *  actually ask), topic/page metadata adds a nudge, body hits accumulate with diminishing
 *  weight. Exported for tests. */
export function rankChunks(question: string, chunks: KbChunk[] = KB_CHUNKS): Scored[] {
  const qTokens = [...new Set(tokenize(question).map(stem))];
  if (!qTokens.length) return [];
  const scored: Scored[] = [];
  for (const chunk of chunks) {
    const titleTokens = new Set(tokenize(chunk.title).map(stem));
    const bodyTokens = new Set(tokenize(chunk.body).map(stem));
    const metaTokens = new Set(tokenize(`${chunk.topic} ${chunk.page ?? ''}`).map(stem));
    let score = 0;
    for (const t of qTokens) {
      if (titleTokens.has(t)) score += 3;
      if (metaTokens.has(t)) score += 2;
      if (bodyTokens.has(t)) score += 1;
    }
    if (score > 0) scored.push({ chunk, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

const MAX_CHUNKS = 3;
/** A single weak hit (e.g. one body-only token) is noise, not an answer. */
const MIN_SCORE = 4;

/** Identity/overview asks — "tell me about yourself", "what is dashie", "what can you do".
 *  These are the skill's PRIMARY use case yet they tokenize to pure stopwords (what/can/you/
 *  tell/about all carry zero signal, and "dashie" is excluded from scoring because it's in
 *  every chunk), so keyword ranking scores them 0 and they fell to found:false → a
 *  defer-to-support answer for the most basic question (field report 2026-07-12). When
 *  ranking finds nothing and the question is identity-shaped, serve the overview chunks. */
const IDENTITY_RE =
  /\b(who are you|what are you|about (you|yourself|dashie)|what('s| is) dashie|what can (you|i|dashie)|what do you do|introduce yourself|tell me about (yourself|dashie|this))\b/i;

/** The chunks an identity ask answers from. IDs are `<file>:<slug(title)>` from the compiler;
 *  the test suite asserts they exist so a KB retitle can't silently break this fallback. */
export const IDENTITY_CHUNK_IDS = [
  'overview:what-is-dashie',
  'overview:what-can-dashie-do-what-are-the-main-features',
  'voice-capabilities:what-can-you-do-what-can-i-ask-you',
];

function identityChunks(chunks: KbChunk[]): KbChunk[] {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const picked = IDENTITY_CHUNK_IDS.map((id) => byId.get(id)).filter((c): c is KbChunk => !!c);
  // Retitled out from under us → still answer from the overview topic rather than miss.
  return picked.length ? picked : chunks.filter((c) => c.topic === 'overview').slice(0, MAX_CHUNKS);
}

export const dashieHelpTool: ToolDef = {
  name: 'dashie_help',
  description:
    'Look up how Dashie itself works — its features, settings and where to find them, how-to ' +
    'steps, and troubleshooting. Call this for ANY question about Dashie the product ("what can ' +
    'you do", "how do I add a calendar", "where do I change the theme", "why is my screen ' +
    'black"). It returns curated product documentation — answer from it and do NOT web-search ' +
    'or guess about Dashie. If it returns found:false, say you are not sure and suggest ' +
    'emailing support@dashieapp.com; never invent settings locations or prices.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: "the user's question about Dashie, e.g. 'how do I add a calendar'",
      },
    },
    required: ['question'],
  },
  // deno-lint-ignore require-await
  async execute(args, _ctx: ToolContext): Promise<ToolResult> {
    const question = String(args?.question ?? '').trim();
    const ranked = rankChunks(question).filter((s) => s.score >= MIN_SCORE).slice(0, MAX_CHUNKS);
    let hits = ranked.map((s) => s.chunk);
    // No keyword hit + identity-shaped ask → the overview chunks ARE the answer.
    if (!hits.length && IDENTITY_RE.test(question)) hits = identityChunks(KB_CHUNKS);
    if (!hits.length) return { result: { found: false } };
    return {
      result: {
        found: true,
        question,
        // Beta chunks carry their caveat inline in the prose (see js/ai/knowledge/README.md),
        // so no extra gating here until dashie_help is tier-aware.
        chunks: hits.map((chunk) => ({
          title: chunk.title,
          topic: chunk.topic,
          status: chunk.status,
          answer: chunk.body,
        })),
      },
    };
  },
};
