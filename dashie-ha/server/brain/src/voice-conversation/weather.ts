// weather.ts — self-fulfilled weather gather (Open-Meteo + geocode, all public/no-key).
//
// Ported from the browser weather widget (js/data/services/weather-service.js +
// js/utils/geocoding-helper.js) to Deno: zip/city → coordinates → current + daily forecast.
// Weather is folded into the brain rather than fetched by the caller: it is
// self-fulfillable from public, key-free APIs, so no surface needs its own copy.
//
// ⚠️ PURE module — NO Deno.*/Supabase/https-import coupling (Open-Meteo, Zippopotam, and
// Nominatim are public). The L3 add-on (node-io.js) ports this same logic in plain Node.
// The brain re-exports getWeather/WeatherResult via gather.ts (mirrors the sports re-export).

/** Where to fetch weather for. Resolution priority is the orchestrator's; this just fetches. */
export interface WeatherLocation {
  zip?: string;
  lat?: number;
  lon?: number;
  locationName?: string;   // free-text "Boston", "Paris, France" (Nominatim search)
}

/** Normalized result — mirrors SportsResult; shaped to what INQUIRY_WEATHER renders
 *  (`location.city/state` + the WEATHER_DATA blob). Daily gives the weekend lookahead. */
export interface WeatherResult {
  provider: string;        // 'open-meteo'
  location: { city: string; state: string; latitude: number; longitude: number };
  current: { temperature: number; weatherCode: number; description: string; windSpeed: number };
  daily: Array<{
    date: string;          // YYYY-MM-DD
    dayName: string;       // 'Saturday'
    high: number;
    low: number;
    weatherCode: number;
    description: string;
    precipProbability: number;
  }>;
  // Next ~18 hours from the CURRENT hour (index 0 = now) — powers "when will the rain
  // stop/start". `time` is the location-local ISO ("…T16:00"); the template reads the hour.
  // Optional: older callers / the L3 node-io port may not populate it (→ graceful fallback).
  hourly?: Array<{ time: string; precipProb: number; weatherCode: number }>;
  latency: number;
}

const WMO_DESCRIPTIONS: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Depositing rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle',
  55: 'Dense drizzle', 56: 'Light freezing drizzle', 57: 'Dense freezing drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain', 66: 'Light freezing rain',
  67: 'Heavy freezing rain', 71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow',
  77: 'Snow grains', 80: 'Slight rain showers', 81: 'Moderate rain showers',
  82: 'Violent rain showers', 85: 'Slight snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
};
const describe = (code: number | undefined): string => WMO_DESCRIPTIONS[code ?? -1] || 'Unknown';

interface Coords { latitude: number; longitude: number; city: string; state: string }

/** US zip → coords + city/state via Zippopotam (public, CORS-friendly), Nominatim fallback. */
async function zipToCoords(zip: string): Promise<Coords> {
  const zip5 = zip.trim().replace(/[\s-]/g, '').slice(0, 5);
  // Zippopotam — gives city + state abbreviation for free.
  try {
    const r = await fetch(`https://api.zippopotam.us/us/${zip5}`);
    if (r.ok) {
      const d = await r.json();
      const p = d?.places?.[0];
      if (p) {
        return {
          latitude: parseFloat(p.latitude),
          longitude: parseFloat(p.longitude),
          city: p['place name'] || '',
          state: p['state abbreviation'] || '',
        };
      }
    }
  } catch { /* fall through to Nominatim */ }
  // Nominatim fallback (requires a User-Agent).
  const r = await fetch(
    `https://nominatim.openstreetmap.org/search?postalcode=${zip5}&country=us&format=json&limit=1`,
    { headers: { 'User-Agent': 'Dashie/1.0 (Family Dashboard)' } },
  );
  if (!r.ok) throw new Error(`Geocode failed: HTTP ${r.status}`);
  const d = await r.json();
  if (!Array.isArray(d) || d.length === 0) throw new Error(`No coordinates for zip ${zip5}`);
  return { latitude: parseFloat(d[0].lat), longitude: parseFloat(d[0].lon), city: '', state: '' };
}

/** Free-text place ("Boston", "Paris, France") → coords via Nominatim search. */
async function nameToCoords(name: string): Promise<Coords> {
  const r = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=1&addressdetails=1`,
    { headers: { 'User-Agent': 'Dashie/1.0 (Family Dashboard)' } },
  );
  if (!r.ok) throw new Error(`Geocode failed: HTTP ${r.status}`);
  const d = await r.json();
  if (!Array.isArray(d) || d.length === 0) throw new Error(`No coordinates for "${name}"`);
  const a = d[0].address || {};
  const city = a.city || a.town || a.village || a.hamlet || name;
  return { latitude: parseFloat(d[0].lat), longitude: parseFloat(d[0].lon), city, state: a.state || '' };
}

async function resolveCoords(loc: WeatherLocation): Promise<Coords> {
  if (typeof loc.lat === 'number' && typeof loc.lon === 'number') {
    return { latitude: loc.lat, longitude: loc.lon, city: '', state: '' };
  }
  if (loc.zip) return zipToCoords(loc.zip);
  if (loc.locationName) return nameToCoords(loc.locationName);
  throw new Error('No location provided (zip, lat/lon, or locationName required)');
}

/** Weekday name from a YYYY-MM-DD daily entry (noon-anchored, locale en-US). */
function dayNameFor(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(d);
}

/**
 * Self-fulfill a weather lookup: resolve a location to coordinates, then fetch the
 * current conditions + a 7-day daily forecast from Open-Meteo. Public APIs, no key.
 */
export async function getWeather(loc: WeatherLocation): Promise<WeatherResult> {
  const t0 = Date.now();
  const coords = await resolveCoords(loc);

  const url = `https://api.open-meteo.com/v1/forecast?` +
    `latitude=${coords.latitude}&longitude=${coords.longitude}` +
    `&current_weather=true` +
    `&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max` +
    `&hourly=precipitation_probability,weathercode` +
    `&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=auto&forecast_days=7`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Weather API returned ${resp.status}`);
  const data = await resp.json();

  const cw = data.current_weather || {};
  const dy = data.daily || {};
  const daily = Array.isArray(dy.time)
    ? dy.time.map((date: string, i: number) => ({
      date,
      dayName: dayNameFor(date),
      high: Math.round(dy.temperature_2m_max?.[i]),
      low: Math.round(dy.temperature_2m_min?.[i]),
      weatherCode: dy.weathercode?.[i],
      description: describe(dy.weathercode?.[i]),
      precipProbability: Math.round((dy.precipitation_probability_max?.[i] || 0) / 5) * 5,
    }))
    : [];

  // Hourly, trimmed to start at the CURRENT hour so hourly[0] = now. Open-Meteo returns
  // location-local ISO times (timezone=auto); anchor "now" via the response's utc_offset so
  // the trim doesn't depend on the (UTC) edge runtime's clock.
  const hy = data.hourly || {};
  const offMs = Number(data.utc_offset_seconds ?? 0) * 1000;
  const nowKey = new Date(Date.now() + offMs).toISOString().slice(0, 13); // "YYYY-MM-DDTHH" (local wall clock)
  const allHours: Array<{ time: string; precipProb: number; weatherCode: number }> = Array.isArray(hy.time)
    ? hy.time.map((time: string, i: number) => ({
      time,
      precipProb: Math.round((hy.precipitation_probability?.[i] || 0) / 5) * 5,
      weatherCode: hy.weathercode?.[i],
    }))
    : [];
  const startIdx = allHours.findIndex((h) => h.time.slice(0, 13) >= nowKey);
  const hourly = (startIdx >= 0 ? allHours.slice(startIdx) : allHours).slice(0, 18);

  return {
    provider: 'open-meteo',
    location: { city: coords.city, state: coords.state, latitude: coords.latitude, longitude: coords.longitude },
    current: {
      temperature: Math.round(cw.temperature),
      weatherCode: cw.weathercode,
      description: describe(cw.weathercode),
      windSpeed: Math.round(cw.windspeed || 0),
    },
    daily,
    hourly,
    latency: Date.now() - t0,
  };
}
