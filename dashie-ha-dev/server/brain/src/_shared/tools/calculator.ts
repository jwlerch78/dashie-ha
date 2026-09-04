/**
 * Calculator — arithmetic the model should never do in its head.
 *
 * WHY A TOOL. Measured on 2026-09-03 (V s9, `suite/compute.json`, gemini-2.5-flash on the
 * deployed cascade): the model answers 12 of 13 arithmetic/conversion questions correctly with no
 * tool at all — but it answered "seven times twenty three" as **162**. A family dashboard that
 * splits a restaurant bill wrong is worse than one that declines, and the failure is silent: a
 * confidently-wrong number is indistinguishable from a right one at the speaker.
 *
 * So this is NOT here to lift a bad score. It is here to remove a small, high-embarrassment tail —
 * and it matters far more on the LOCAL/BYOK lane, where a 4–26B model does arithmetic much worse
 * than gemini-2.5-flash does. NickM's stack carries a calculator for exactly that reason.
 *
 * NO NETWORK, NO KEY, NO CARD, NO STATE. Pure Kind A.
 *
 * ⚠️ NO `eval`. This receives a model-authored string; `eval`/`Function` on that is arbitrary code
 * execution inside the edge function. The parser below accepts ONLY numbers, the six operators and
 * parentheses — anything else is a rejection, not a best-effort parse.
 */

import type { ToolDef, ToolResult } from './types.ts';

/** Tokens the grammar admits. Everything else fails closed. */
const TOKEN = /\s*(\d+\.?\d*|[-+*/^%()])/y;

function tokenize(src: string): string[] | null {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  let i = 0;
  while (i < src.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(src);
    if (!m) {
      // Allow only trailing whitespace past the last token; any other residue is a rejection.
      if (src.slice(i).trim() === '') break;
      return null;
    }
    out.push(m[1]);
    i = TOKEN.lastIndex;
  }
  return out.length ? out : null;
}

/** Recursive descent: expr → term (('+'|'-') term)* ; term → pow (('*'|'/'|'%') pow)* ;
 *  pow → unary ('^' pow)? ; unary → '-'? atom ; atom → number | '(' expr ')'. */
function parse(tokens: string[]): number | null {
  let p = 0;
  const peek = () => tokens[p];
  const eat = (t: string) => (tokens[p] === t ? (p++, true) : false);

  function atom(): number | null {
    if (eat('(')) {
      const v = expr();
      if (v === null || !eat(')')) return null;
      return v;
    }
    const t = peek();
    if (t === undefined || !/^\d/.test(t)) return null;
    p++;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  function unary(): number | null {
    if (eat('-')) { const v = unary(); return v === null ? null : -v; }
    if (eat('+')) return unary();
    return atom();
  }
  function pow(): number | null {
    const base = unary();
    if (base === null) return null;
    if (eat('^')) { const e = pow(); return e === null ? null : base ** e; }
    return base;
  }
  function term(): number | null {
    let v = pow();
    if (v === null) return null;
    for (;;) {
      if (eat('*')) { const r = pow(); if (r === null) return null; v *= r; }
      else if (eat('/')) { const r = pow(); if (r === null || r === 0) return null; v /= r; }
      else if (eat('%')) { const r = pow(); if (r === null || r === 0) return null; v %= r; }
      else return v;
    }
  }
  function expr(): number | null {
    let v = term();
    if (v === null) return null;
    for (;;) {
      if (eat('+')) { const r = term(); if (r === null) return null; v += r; }
      else if (eat('-')) { const r = term(); if (r === null) return null; v -= r; }
      else return v;
    }
  }
  const v = expr();
  return v !== null && p === tokens.length && Number.isFinite(v) ? v : null;
}

/** Evaluate an arithmetic expression. Returns null for anything unparseable or non-finite —
 *  including division by zero, which must be a MISS rather than `Infinity` spoken aloud. */
export function evaluateExpression(src: string): number | null {
  if (typeof src !== 'string' || src.length > 200) return null;
  const tokens = tokenize(src);
  return tokens ? parse(tokens) : null;
}

/** Round for speech: keep real precision, drop float noise (0.1+0.2 → 0.3, not 0.30000000000000004). */
export function forSpeech(n: number): number {
  const r = Number(n.toPrecision(12));
  return Object.is(r, -0) ? 0 : r;
}

export const calculatorTool: ToolDef = {
  name: 'calculator',
  description:
    'Evaluate an arithmetic expression exactly. Use this for ANY arithmetic the user asks for — ' +
    'sums, products, division, percentages, splitting a bill, scaling a recipe — instead of ' +
    'computing it yourself, which is unreliable. Write the question as a plain expression: ' +
    '"15% of 80" → "0.15*80"; "split 87 three ways" → "87/3"; "45 plus 67 minus 12" → "45+67-12". ' +
    'Supports + - * / %, ^ for powers, and parentheses. Returns { found: false } if the ' +
    'expression cannot be evaluated (including division by zero) — say you could not work it out ' +
    'rather than guessing a number.',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'The arithmetic expression, digits and operators only, e.g. "0.15*80" or "(45+67)/2".',
      },
    },
    required: ['expression'],
  },
  // deno-lint-ignore require-await
  async execute(args): Promise<ToolResult> {
    const expression = String(args?.expression ?? '');
    const value = evaluateExpression(expression);
    if (value === null) return { result: { found: false } };
    const result = forSpeech(value);
    return { result: { found: true, expression, result, spoken: String(result) } };
  },
};
