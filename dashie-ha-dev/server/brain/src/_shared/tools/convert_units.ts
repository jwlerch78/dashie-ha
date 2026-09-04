/**
 * Unit converter — "how many tablespoons in two thirds of a cup", in a kitchen, out loud.
 *
 * WHY A TOOL. NickM's stack carries a Kitchen Unit Converter and it is the single best-matched
 * capability in his catalogue to a wall-mounted family dashboard: no API, no key, no latency, and
 * the questions are asked mid-recipe with hands full. Measured baseline (V s9, 2026-09-03):
 * gemini-2.5-flash already answers the common conversions correctly, so this is parity + a
 * precision floor, NOT a score lift on the cloud lane — it earns far more on the local/BYOK lane.
 *
 * Conversion is `value * from.factor / to.factor` against a per-dimension base (see unit-table.ts).
 * Temperature is the exception — it has OFFSETS, not just scale — and is handled explicitly below.
 * A cross-dimension ask ("cups to miles") returns { found: false } rather than a number: silently
 * producing one would be the fabrication failure this whole tool exists to reduce.
 */

import type { ToolDef, ToolResult } from './types.ts';
import { UNIT_LOOKUP, UNITS } from './unit-table.ts';

/** Resolve a user/model-supplied unit word to a canonical key. Null when unknown. */
export function resolveUnit(raw: string): string | null {
  const k = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '');
  return UNIT_LOOKUP[k] ?? UNIT_LOOKUP[k.replace(/s$/, '')] ?? null;
}

/** Temperature needs offsets, so it cannot ride the factor path. Base: celsius. */
const toCelsius: Record<string, (v: number) => number> = {
  celsius: (v) => v,
  fahrenheit: (v) => (v - 32) * 5 / 9,
  kelvin: (v) => v - 273.15,
};
const fromCelsius: Record<string, (v: number) => number> = {
  celsius: (v) => v,
  fahrenheit: (v) => v * 9 / 5 + 32,
  kelvin: (v) => v + 273.15,
};

export interface Conversion { value: number; from: string; to: string; dimension: string }

/** Convert, or null when the units are unknown or belong to different dimensions. */
export function convert(value: number, fromRaw: string, toRaw: string): Conversion | null {
  if (!Number.isFinite(value)) return null;
  const from = resolveUnit(fromRaw);
  const to = resolveUnit(toRaw);
  if (!from || !to) return null;
  const a = UNITS[from], b = UNITS[to];
  if (a.dim !== b.dim) return null;
  const out = a.dim === 'temperature'
    ? fromCelsius[to](toCelsius[from](value))
    : value * a.factor / b.factor;
  if (!Number.isFinite(out)) return null;
  return { value: out, from, to, dimension: a.dim };
}

/** Round for speech. Keeps small values meaningful (0.000123) without reading float noise aloud. */
export function forSpeech(n: number): number {
  const abs = Math.abs(n);
  const dp = abs === 0 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : Math.min(6, 3 - Math.floor(Math.log10(abs)));
  const r = Number(n.toFixed(dp));
  return Object.is(r, -0) ? 0 : r;
}

const readable = (key: string) => key.replace(/_/g, ' ');

/** A ready-to-read phrase. Naive pluralisation says "176.67 celsiuss" and "30 psis", so
 *  temperature gets the "degrees X" idiom and the unpluralisable units are named. */
const NO_PLURAL = new Set(['psi', 'kelvin', 'celsius', 'fahrenheit']);
export function spokenPhrase(value: number, unitKey: string, dim: string): string {
  const name = readable(unitKey);
  if (dim === 'temperature') return `${value} degrees ${name}`;
  if (NO_PLURAL.has(unitKey) || name.endsWith('s')) return `${value} ${name}`;
  return `${value} ${name}${Math.abs(value) === 1 ? '' : 's'}`;
}

export const convertUnitsTool: ToolDef = {
  name: 'convert_units',
  description:
    'Convert a value between units — cooking measures (teaspoons, tablespoons, cups, pints, ' +
    'quarts, gallons, millilitres, litres), weight (ounces, pounds, grams, kilograms, stone), ' +
    'length, temperature (Fahrenheit, Celsius, Kelvin), time, speed, area, energy, power, ' +
    'pressure, digital storage and angles. Use this for ANY "how many X in a Y" or "what is N X ' +
    'in Y" question instead of converting yourself. For a fraction, pass it as a decimal ' +
    '(two thirds of a cup → value 0.667, from "cup"). Returns { found: false } if a unit is ' +
    'unknown or the two units measure different things (cups to miles) — say you could not ' +
    'convert it rather than inventing a number.',
  parameters: {
    type: 'object',
    properties: {
      value: { type: 'number', description: 'The quantity to convert, e.g. 350 or 0.667.' },
      from: { type: 'string', description: 'The unit to convert FROM, e.g. "fahrenheit", "cup", "pounds".' },
      to: { type: 'string', description: 'The unit to convert TO, e.g. "celsius", "tablespoons", "kilograms".' },
    },
    required: ['value', 'from', 'to'],
  },
  // deno-lint-ignore require-await
  async execute(args): Promise<ToolResult> {
    const value = Number(args?.value);
    const c = convert(value, String(args?.from ?? ''), String(args?.to ?? ''));
    if (!c) return { result: { found: false } };
    const result = forSpeech(c.value);
    return {
      result: {
        found: true,
        value: result,
        unit: readable(c.to),
        dimension: c.dimension,
        spoken: spokenPhrase(result, c.to, c.dimension),
      },
    };
  },
};
