// weather-synth.test.ts — server-fulfilled weather phrasing + the WMO→condition adapter.
// Voice vectors MIRROR js/core/voice/weather-template.test.js (drift guard). Pure, offline.
// Run: deno test supabase/functions/voice-conversation/weather-synth.test.ts

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { templateWeather, weatherResultToReading, wmoToCondition, type WeatherReading } from './weather-synth.ts';
import type { WeatherResult } from './weather.ts';

/** A normalized reading (mirrors weather-template.test.js). daily[0] = today. */
function reading(overrides: Partial<WeatherReading> = {}): WeatherReading {
  return {
    found: true,
    source: 'open-meteo',
    location: { city: 'Naperville', state: 'IL' },
    current: { temperature: 72, condition: 'partlycloudy', windSpeed: 6 },
    daily: [
      { date: '2026-07-02', dayName: 'Thursday', high: 84, low: 66, condition: 'sunny', precipProbability: 0 },
      { date: '2026-07-03', dayName: 'Friday', high: 82, low: 64, condition: 'partlycloudy', precipProbability: 10 },
      { date: '2026-07-04', dayName: 'Saturday', high: 78, low: 60, condition: 'sunny', precipProbability: 5 },
      { date: '2026-07-05', dayName: 'Sunday', high: 71, low: 58, condition: 'rainy', precipProbability: 60 },
    ],
    ...overrides,
  };
}

// ── phrasing (must match weather-template.test.js) ─────────────────────────
Deno.test('found:false → friendly apology, no card', () => {
  const r = templateWeather({ found: false }, { timeframe: 'today' });
  assertEquals(r.voice, "I couldn't get the weather right now.");
  assertEquals(r.card, null);
});

Deno.test('current → leads with temp + condition + city', () => {
  assertEquals(templateWeather(reading(), { timeframe: 'current' }).voice, "It's 72 degrees and partly cloudy in Naperville.");
});

Deno.test('today → high/low + precip', () => {
  const data = reading();
  data.daily![0].precipProbability = 30;
  data.daily![0].condition = 'rainy';
  assertEquals(templateWeather(data, { timeframe: 'today' }).voice, 'Today: rainy, high 84, low 66, 30% chance of rain.');
});

Deno.test('tonight → condition + low only', () => {
  assertEquals(templateWeather(reading(), { timeframe: 'tonight' }).voice, 'Tonight: sunny, low 66.');
});

Deno.test('tomorrow → daily[1], NOT today (field bug: tomorrow answered with today)', () => {
  // daily[1] = Friday, partlycloudy, high 82, low 64, precip 10% (below the 20% say-threshold).
  assertEquals(templateWeather(reading(), { timeframe: 'tomorrow' }).voice, 'Tomorrow: partly cloudy, high 82, low 64.');
});

// ── precip_timing ("when will the rain stop/start") — hourly[0] = now ─────────
const rainThenClear = [
  { time: '2026-07-27T13:00', precipProb: 80, condition: 'rainy' },
  { time: '2026-07-27T14:00', precipProb: 70, condition: 'rainy' },
  { time: '2026-07-27T15:00', precipProb: 20, condition: 'cloudy' },
  { time: '2026-07-27T16:00', precipProb: 5, condition: 'partlycloudy' },
];
const dryThenRain = [
  { time: '2026-07-27T13:00', precipProb: 10, condition: 'partlycloudy' },
  { time: '2026-07-27T14:00', precipProb: 30, condition: 'cloudy' },
  { time: '2026-07-27T15:00', precipProb: 75, condition: 'rainy' },
];

Deno.test('precip_timing: raining now → when it lets up', () => {
  assertEquals(templateWeather(reading({ hourly: rainThenClear }), { timeframe: 'precip_timing' }).voice,
    'The rain should let up around 3 PM.');
});

Deno.test('precip_timing: dry now → when it starts', () => {
  assertEquals(templateWeather(reading({ hourly: dryThenRain }), { timeframe: 'precip_timing' }).voice,
    'Rain looks likely around 3 PM.');
});

Deno.test('precip_timing: raining with no clear hour in the window → sticks around', () => {
  const allWet = rainThenClear.map((h) => ({ ...h, precipProb: 80, condition: 'rainy' }));
  assertEquals(templateWeather(reading({ hourly: allWet }), { timeframe: 'precip_timing' }).voice,
    'The rain should stick around for the next several hours.');
});

Deno.test('precip_timing: dry window → no rain coming', () => {
  const allDry = [{ time: '2026-07-27T13:00', precipProb: 5, condition: 'sunny' }];
  assertEquals(templateWeather(reading({ hourly: allDry }), { timeframe: 'precip_timing' }).voice,
    'No rain in the forecast for the next several hours.');
});

Deno.test('precip_timing: NO hourly data → graceful fallback to current conditions', () => {
  assertEquals(templateWeather(reading({ hourly: [] }), { timeframe: 'precip_timing' }).voice,
    "It's 72 degrees and partly cloudy in Naperville.");
});

Deno.test('weekend → Saturday + Sunday, compact, precip on Sunday', () => {
  assertEquals(
    templateWeather(reading(), { timeframe: 'weekend' }).voice,
    'This weekend: Saturday sunny, high 78; Sunday rainy, high 71, 60% chance of rain.',
  );
});

Deno.test('named weekday → that day, high/low', () => {
  assertEquals(templateWeather(reading(), { timeframe: 'saturday' }).voice, 'Saturday: sunny, high 78, low 60.');
});

Deno.test('named weekday not in window → falls back to current', () => {
  assertEquals(templateWeather(reading(), { timeframe: 'monday' }).voice, "It's 72 degrees and partly cloudy in Naperville.");
});

Deno.test('missing city → no " in <city>" suffix', () => {
  const r = templateWeather(reading({ location: { city: '', state: '' } }), { timeframe: 'current' });
  assertEquals(r.voice, "It's 72 degrees and partly cloudy.");
});

// ── WMO code → condition token ─────────────────────────────────────────────
Deno.test('wmoToCondition maps the ranges', () => {
  assertEquals(wmoToCondition(0), 'sunny');
  assertEquals(wmoToCondition(2), 'partlycloudy');
  assertEquals(wmoToCondition(3), 'cloudy');
  assertEquals(wmoToCondition(61), 'rainy');
  assertEquals(wmoToCondition(75), 'snowy');
  assertEquals(wmoToCondition(95), 'lightning-rainy');
  assertEquals(wmoToCondition(undefined), 'cloudy');
});

// ── adapter: getWeather WeatherResult → reading → phrasing ──────────────────
Deno.test('weatherResultToReading maps codes, then weekend phrasing works end-to-end', () => {
  const w: WeatherResult = {
    provider: 'open-meteo',
    location: { city: 'Naperville', state: 'IL', latitude: 41.75, longitude: -88.15 },
    current: { temperature: 72, weatherCode: 2, description: 'Partly cloudy', windSpeed: 6 },
    daily: [
      { date: '2026-07-04', dayName: 'Saturday', high: 78, low: 60, weatherCode: 0, description: 'Clear sky', precipProbability: 5 },
      { date: '2026-07-05', dayName: 'Sunday', high: 71, low: 58, weatherCode: 61, description: 'Slight rain', precipProbability: 60 },
    ],
    latency: 12,
  };
  const data = weatherResultToReading(w);
  assertEquals(data.current!.condition, 'partlycloudy');
  assertEquals(data.daily![1].condition, 'rainy');
  assertEquals(
    templateWeather(data, { timeframe: 'weekend' }).voice,
    'This weekend: Saturday sunny, high 78; Sunday rainy, high 71, 60% chance of rain.',
  );
  assert(templateWeather(data, {}).voice.startsWith("It's 72 degrees"));
});
