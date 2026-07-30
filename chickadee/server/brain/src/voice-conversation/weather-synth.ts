// weather-synth.ts — deterministic weather synthesis for the SERVER-fulfilled path.
//
// The headless/anon caller (HA integration gateway) can't run the on-device weather tool,
// so the brain self-fulfills via weather.ts (getWeather → Open-Meteo) and voices the answer
// HERE, with the SAME phrasing the device speaks. This is a Deno port of two JS pieces:
//   - js/core/voice/weather-template.js  → templateWeather (timeframe phrasing)
//   - js/core/voice/weather-tool.js      → wmoToCondition  (WMO code → condition token)
// plus the adapter (weatherResultToReading) that maps getWeather's WMO-coded WeatherResult
// into the normalized reading templateWeather consumes.
//
// ⚠️ PURE module — NO Deno.*/Supabase/https imports (safe to value-import into the
// dual-runtime orchestrator core). Voice phrasing is a hand-mirror of the two JS files
// above; keep them in sync (contract candidate — see .reference/JS_KOTLIN_CONTRACTS.md).
// The shared test vectors (weather-synth.test.ts ⇄ weather-template.test.js) guard drift.

import type { WeatherResult } from './weather.ts';

/** Normalized reading templateWeather consumes (mirrors weather-tool.js output). */
export interface WeatherReading {
  found: boolean;
  source?: string;
  location?: { city?: string; state?: string };
  current?: { temperature?: number; condition?: string; windSpeed?: number };
  daily?: Array<{
    date?: string;
    dayName?: string;
    high?: number;
    low?: number;
    condition?: string;
    precipProbability?: number;
  }>;
  // Next ~18 hours from NOW (index 0 = current hour). `time` is either a spoken label
  // ("3 PM"/"3PM") or a location-local ISO ("…T15:00"); the template reads the hour off
  // either. Absent → the "when will it stop/start" branch falls back to current conditions.
  hourly?: Array<{ time?: string; precipProb?: number; condition?: string }>;
}

export interface WeatherQuery {
  timeframe?: string;
  location?: string;
}

// ── WMO code → HA-style condition token ────────────────────────────────────
// Mirrors wmoToCondition in weather-tool.js (and WeatherDataProvider.wmoCodeToCondition
// on Android) so the CONDITION phrase map below serves every source.
export function wmoToCondition(code: number | undefined): string {
  const c = Number(code);
  if (c === 0) return 'sunny';
  if (c === 1 || c === 2) return 'partlycloudy';
  if (c === 3) return 'cloudy';
  if (c === 45 || c === 48) return 'fog';
  if (c === 65 || c === 82) return 'pouring';
  if (c === 66 || c === 67) return 'snowy-rainy';
  if ((c >= 51 && c <= 57) || (c >= 61 && c <= 63) || c === 80 || c === 81) return 'rainy';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snowy';
  if (c === 95) return 'lightning-rainy';
  if (c === 96 || c === 99) return 'hail';
  return 'cloudy';
}

/** getWeather's WMO-coded result → the normalized reading templateWeather consumes. */
export function weatherResultToReading(w: WeatherResult): WeatherReading {
  return {
    found: true,
    source: w.provider,
    location: { city: w.location?.city || '', state: w.location?.state || '' },
    current: {
      temperature: w.current?.temperature,
      condition: wmoToCondition(w.current?.weatherCode),
      windSpeed: w.current?.windSpeed,
    },
    daily: (w.daily || []).map((d) => ({
      date: d.date,
      dayName: d.dayName,
      high: d.high,
      low: d.low,
      condition: wmoToCondition(d.weatherCode),
      precipProbability: d.precipProbability,
    })),
    hourly: (w.hourly || []).map((h) => ({
      time: h.time,
      precipProb: h.precipProb,
      condition: wmoToCondition(h.weatherCode),
    })),
  };
}

// ── Phrasing (ported verbatim from weather-template.js) ─────────────────────
const CONDITION: Record<string, { adj: string; precip: string }> = {
  sunny: { adj: 'sunny', precip: 'rain' },
  clear: { adj: 'clear', precip: 'rain' },
  'clear-night': { adj: 'clear', precip: 'rain' },
  partlycloudy: { adj: 'partly cloudy', precip: 'rain' },
  cloudy: { adj: 'cloudy', precip: 'rain' },
  fog: { adj: 'foggy', precip: 'rain' },
  rainy: { adj: 'rainy', precip: 'rain' },
  pouring: { adj: 'heavy rain', precip: 'rain' },
  'snowy-rainy': { adj: 'a wintry mix', precip: 'wintry mix' },
  snowy: { adj: 'snowy', precip: 'snow' },
  'lightning-rainy': { adj: 'thunderstorms', precip: 'storms' },
  hail: { adj: 'thunderstorms with hail', precip: 'storms' },
};
function cond(token: string | undefined): { adj: string; precip: string } {
  return CONDITION[String(token || '').toLowerCase()] || { adj: 'mixed conditions', precip: 'rain' };
}

type Day = NonNullable<WeatherReading['daily']>[number];

/** "40% chance of rain" — only when it's worth saying (≥20%). */
function precipPhrase(day: Day | undefined): string {
  const p = Math.round(Number(day?.precipProbability) || 0);
  if (p < 20) return '';
  return `${p}% chance of ${cond(day?.condition).precip}`;
}

/** One day → "sunny, high 78, low 55[, 40% chance of rain]". */
function dayLine(day: Day | undefined, { withLow = true }: { withLow?: boolean } = {}): string {
  const { adj } = cond(day?.condition);
  const bits = [adj];
  if (Number.isFinite(day?.high)) bits.push(`high ${Math.round(day!.high as number)}`);
  if (withLow && Number.isFinite(day?.low)) bits.push(`low ${Math.round(day!.low as number)}`);
  const precip = precipPhrase(day);
  const line = bits.join(', ');
  return precip ? `${line}, ${precip}` : line;
}

const WEEKEND = new Set(['saturday', 'sunday']);

function findDay(daily: Day[], name: string): Day | null {
  const want = String(name || '').toLowerCase();
  return daily.find((d) => String(d.dayName || '').toLowerCase() === want) || null;
}

function weekendDays(daily: Day[]): Day[] {
  return daily.filter((d) => WEEKEND.has(String(d.dayName || '').toLowerCase())).slice(0, 2);
}

// ── precip timing ("when will the rain stop/start") ─────────────────────────
type Hour = NonNullable<WeatherReading['hourly']>[number];
const WET_CONDITIONS = new Set(['rainy', 'pouring', 'snowy', 'snowy-rainy', 'lightning-rainy', 'hail']);
/** An hour counts as "wet" at ≥50% precip chance OR an outright precip condition code. */
function hourIsWet(h: Hour | undefined): boolean {
  const prob = Number(h?.precipProb) || 0;
  return prob >= 50 || WET_CONDITIONS.has(String(h?.condition || '').toLowerCase());
}
/** Spoken hour label from a "3 PM"/"3PM" label OR a "…T15:00" ISO — else ''. */
function hourLabel(t: string | undefined): string {
  const s = String(t || '').trim();
  const lbl = /^(\d{1,2})\s*(AM|PM)$/i.exec(s);
  if (lbl) return `${parseInt(lbl[1], 10)} ${lbl[2].toUpperCase()}`;
  const iso = /T(\d{2})/.exec(s);
  if (iso) {
    let h = parseInt(iso[1], 10);
    const ap = h < 12 ? 'AM' : 'PM';
    h %= 12; if (h === 0) h = 12;
    return `${h} ${ap}`;
  }
  return '';
}
/** "rain" or "snow" from the first wet hour's condition (defaults to rain). */
function precipWord(hours: Hour[]): string {
  const w = hours.find(hourIsWet);
  return String(w?.condition || '').toLowerCase().startsWith('snow') ? 'snow' : 'rain';
}
/** "When will it stop/start" from the hourly window. Falls back to current conditions
 *  when no hourly data is present (e.g. a device path that doesn't fetch hourly yet). */
function precipTimingLine(data: WeatherReading): string {
  const hrs = (Array.isArray(data.hourly) ? data.hourly : []).slice(0, 18);
  if (hrs.length === 0) return currentLine(data);
  const word = precipWord(hrs);
  if (hourIsWet(hrs[0])) {
    const stop = hrs.findIndex((h, i) => i > 0 && !hourIsWet(h));
    if (stop === -1) return `The ${word} should stick around for the next several hours.`;
    const when = hourLabel(hrs[stop].time);
    return when ? `The ${word} should let up around ${when}.` : `The ${word} should let up soon.`;
  }
  const start = hrs.findIndex(hourIsWet);
  if (start === -1) return `No ${word} in the forecast for the next several hours.`;
  const when = hourLabel(hrs[start].time);
  const Cap = word.charAt(0).toUpperCase() + word.slice(1);
  return when ? `${Cap} looks likely around ${when}.` : `${Cap} is possible later.`;
}

function currentLine(data: WeatherReading): string {
  const c = data.current || {};
  const place = data.location?.city ? ` in ${data.location.city}` : '';
  const temp = Number.isFinite(c.temperature) ? `${Math.round(c.temperature as number)} degrees` : 'out';
  const head = `It's ${temp} and ${cond(c.condition).adj}${place}.`;
  const today = (data.daily || [])[0];
  const precip = today ? precipPhrase(today) : '';
  return precip ? `${head} ${precip[0].toUpperCase()}${precip.slice(1)} today.` : head;
}

/**
 * Synthesize a weather answer from a normalized reading + the extracted query.
 * Voice-only (card:null) — matches the device path, whose weather card renderer
 * isn't built yet. @returns {{ voice, text, card }}
 */
export function templateWeather(
  data: WeatherReading | null | undefined,
  query: WeatherQuery = {},
): { voice: string; text: string | null; card: null } {
  if (!data || data.found === false) {
    return { voice: "I couldn't get the weather right now.", text: null, card: null };
  }
  const daily = Array.isArray(data.daily) ? data.daily : [];
  const tf = String(query?.timeframe || '').toLowerCase().trim();

  let voice: string;
  if (tf === 'weekend') {
    const wknd = weekendDays(daily);
    if (wknd.length === 0) {
      voice = currentLine(data);
    } else {
      const parts = wknd.map((d) => `${d.dayName} ${dayLine(d, { withLow: false })}`);
      voice = `This weekend: ${parts.join('; ')}.`;
    }
  } else if (tf === 'tonight') {
    const today = daily[0];
    voice = today && Number.isFinite(today.low)
      ? `Tonight: ${cond(today.condition).adj}, low ${Math.round(today.low as number)}.`
      : currentLine(data);
  } else if (tf === 'today') {
    const today = daily[0];
    voice = today ? `Today: ${dayLine(today)}.` : currentLine(data);
  } else if (tf === 'tomorrow') {
    // daily[0] is today, so tomorrow is daily[1]. Without this branch "tomorrow" fell through
    // to the weekday matcher (findDay), missed, and defaulted to currentLine → "…today" (the
    // 2026-07 field bug: "weather tomorrow" answered with today's conditions).
    const t = daily[1];
    voice = t ? `Tomorrow: ${dayLine(t)}.` : currentLine(data);
  } else if (tf === 'precip_timing') {
    // "When will the rain stop/start" — scan the hourly window (2026-07 field bug: this
    // answered with a generic current snapshot because no hourly data was fetched).
    voice = precipTimingLine(data);
  } else if (tf && tf !== 'current' && tf !== 'this_week') {
    const d = findDay(daily, tf);
    voice = d ? `${d.dayName}: ${dayLine(d)}.` : currentLine(data);
  } else {
    voice = currentLine(data);
  }

  return { voice, text: null, card: null };
}
