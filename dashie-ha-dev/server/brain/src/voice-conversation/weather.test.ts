// weather.test.ts — getWeather: geocode + Open-Meteo shaping, with a mocked fetch so the
// test is deterministic + offline. Run: deno test supabase/functions/voice-conversation/weather.test.ts
//
// (A live smoke against the real public APIs is a separate manual check — this pins the
// SHAPING logic: rounding, WMO→description, weekday derivation, city/state passthrough.)

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { getWeather } from './weather.ts';

const OPEN_METEO = {
  current_weather: { temperature: 72.4, weathercode: 2, windspeed: 6.7 },
  daily: {
    time: ['2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'],
    temperature_2m_max: [84.1, 82.3, 78.0, 71.4],
    temperature_2m_min: [66.2, 64.0, 60.5, 58.1],
    weathercode: [0, 2, 0, 61],
    precipitation_probability_max: [3, 12, 6, 58],
  },
};
const ZIPPOPOTAM = {
  places: [{ latitude: '41.75', longitude: '-88.15', 'place name': 'Naperville', 'state abbreviation': 'IL' }],
};

/** Swap globalThis.fetch for a canned router; returns a restore fn. */
function mockFetch(routes: Array<[RegExp, unknown]>) {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    const hit = routes.find(([re]) => re.test(url));
    const body = hit ? hit[1] : {};
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    // deno-lint-ignore no-explicit-any
  }) as any;
  return () => { globalThis.fetch = orig; };
}

Deno.test('getWeather({lat,lon}) → shapes current + daily, rounds, maps WMO, derives weekday', async () => {
  const restore = mockFetch([[/open-meteo\.com/, OPEN_METEO]]);
  try {
    const w = await getWeather({ lat: 41.75, lon: -88.15 });
    assertEquals(w.provider, 'open-meteo');
    assertEquals(w.current.temperature, 72);              // rounded from 72.4
    assertEquals(w.current.description, 'Partly cloudy'); // WMO 2
    assertEquals(w.current.windSpeed, 7);                 // rounded
    assertEquals(w.daily.length, 4);
    assertEquals(w.daily[0].high, 84);                    // rounded from 84.1
    assertEquals(w.daily[0].low, 66);
    assertEquals(w.daily[0].dayName, 'Thursday');         // 2026-07-02 is a Thursday
    assertEquals(w.daily[0].description, 'Clear sky');    // WMO 0
    assertEquals(w.daily[3].description, 'Slight rain');  // WMO 61
    assertEquals(w.daily[3].precipProbability, 60);       // 58 → rounded to nearest 5
  } finally { restore(); }
});

Deno.test('getWeather({zip}) → geocodes via Zippopotam, fills city/state', async () => {
  const restore = mockFetch([
    [/zippopotam\.us/, ZIPPOPOTAM],
    [/open-meteo\.com/, OPEN_METEO],
  ]);
  try {
    const w = await getWeather({ zip: '60540' });
    assertEquals(w.location.city, 'Naperville');
    assertEquals(w.location.state, 'IL');
    assertEquals(w.location.latitude, 41.75);
    assert(w.daily.length > 0);
  } finally { restore(); }
});

Deno.test('getWeather with no location → throws', async () => {
  let threw = false;
  try { await getWeather({}); } catch { threw = true; }
  assert(threw, 'expected getWeather({}) to reject');
});
