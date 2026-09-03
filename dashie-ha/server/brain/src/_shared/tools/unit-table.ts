/**
 * Unit conversion table — data only, no logic (see convert_units.ts).
 *
 * Split from the tool so neither file fights the size targets: this grows every time someone adds
 * a unit, and the conversion logic does not.
 *
 * SHAPE. Every unit maps to a base unit for its dimension with a multiplicative factor, so a
 * conversion is `value * from.factor / to.factor` — EXCEPT temperature, which has offsets and is
 * handled separately in convert_units.ts. Cross-dimension conversions ("cups to miles") are a MISS
 * by construction: the dimensions simply don't match.
 *
 * Volumes are US customary (the product is a US family dashboard); the imperial pint/gallon differ
 * and are given their own `imperial_*` names rather than silently meaning something else.
 */

export type Dimension =
  | 'length' | 'mass' | 'volume' | 'temperature' | 'time'
  | 'speed' | 'area' | 'energy' | 'power' | 'pressure' | 'data' | 'angle';

export interface UnitDef { dim: Dimension; factor: number; aliases: string[] }

/** factor = how many BASE units one of this unit is.
 *  Bases: metre · gram · litre · second · metre/second · m² · joule · watt · pascal · byte · degree. */
export const UNITS: Record<string, UnitDef> = {
  // ── length (base: metre) ──
  millimetre: { dim: 'length', factor: 0.001, aliases: ['mm', 'millimeter', 'millimetres', 'millimeters'] },
  centimetre: { dim: 'length', factor: 0.01, aliases: ['cm', 'centimeter', 'centimetres', 'centimeters'] },
  metre: { dim: 'length', factor: 1, aliases: ['m', 'meter', 'metres', 'meters'] },
  kilometre: { dim: 'length', factor: 1000, aliases: ['km', 'kilometer', 'kilometres', 'kilometers'] },
  inch: { dim: 'length', factor: 0.0254, aliases: ['in', 'inches', '"'] },
  foot: { dim: 'length', factor: 0.3048, aliases: ['ft', 'feet', "'"] },
  yard: { dim: 'length', factor: 0.9144, aliases: ['yd', 'yards'] },
  mile: { dim: 'length', factor: 1609.344, aliases: ['mi', 'miles'] },
  nautical_mile: { dim: 'length', factor: 1852, aliases: ['nmi', 'nautical miles'] },

  // ── mass (base: gram) ──
  milligram: { dim: 'mass', factor: 0.001, aliases: ['mg', 'milligrams'] },
  gram: { dim: 'mass', factor: 1, aliases: ['g', 'grams', 'gramme', 'grammes'] },
  kilogram: { dim: 'mass', factor: 1000, aliases: ['kg', 'kilo', 'kilos', 'kilograms'] },
  ounce: { dim: 'mass', factor: 28.349523125, aliases: ['oz', 'ounces'] },
  pound: { dim: 'mass', factor: 453.59237, aliases: ['lb', 'lbs', 'pounds'] },
  stone: { dim: 'mass', factor: 6350.29318, aliases: ['st', 'stones'] },
  ton: { dim: 'mass', factor: 907184.74, aliases: ['short ton', 'tons'] },
  tonne: { dim: 'mass', factor: 1_000_000, aliases: ['metric ton', 'tonnes'] },

  // ── volume (base: litre; US customary) ──
  millilitre: { dim: 'volume', factor: 0.001, aliases: ['ml', 'milliliter', 'millilitres', 'milliliters'] },
  litre: { dim: 'volume', factor: 1, aliases: ['l', 'liter', 'litres', 'liters'] },
  teaspoon: { dim: 'volume', factor: 0.00492892159375, aliases: ['tsp', 'teaspoons'] },
  tablespoon: { dim: 'volume', factor: 0.01478676478125, aliases: ['tbsp', 'tbs', 'tablespoons'] },
  fluid_ounce: { dim: 'volume', factor: 0.0295735295625, aliases: ['fl oz', 'floz', 'fluid ounce', 'fluid ounces'] },
  cup: { dim: 'volume', factor: 0.2365882365, aliases: ['cups'] },
  pint: { dim: 'volume', factor: 0.473176473, aliases: ['pt', 'pints'] },
  quart: { dim: 'volume', factor: 0.946352946, aliases: ['qt', 'quarts'] },
  gallon: { dim: 'volume', factor: 3.785411784, aliases: ['gal', 'gallons'] },
  imperial_pint: { dim: 'volume', factor: 0.56826125, aliases: ['uk pint', 'british pint'] },
  imperial_gallon: { dim: 'volume', factor: 4.54609, aliases: ['uk gallon', 'british gallon'] },

  // ── temperature (offsets — handled specially in convert_units.ts) ──
  celsius: { dim: 'temperature', factor: 1, aliases: ['c', '°c', 'centigrade', 'degrees celsius'] },
  fahrenheit: { dim: 'temperature', factor: 1, aliases: ['f', '°f', 'degrees fahrenheit'] },
  kelvin: { dim: 'temperature', factor: 1, aliases: ['k', 'degrees kelvin'] },

  // ── time (base: second) ──
  second: { dim: 'time', factor: 1, aliases: ['s', 'sec', 'secs', 'seconds'] },
  minute: { dim: 'time', factor: 60, aliases: ['min', 'mins', 'minutes'] },
  hour: { dim: 'time', factor: 3600, aliases: ['h', 'hr', 'hrs', 'hours'] },
  day: { dim: 'time', factor: 86400, aliases: ['days'] },
  week: { dim: 'time', factor: 604800, aliases: ['weeks'] },

  // ── speed (base: metre/second) ──
  metres_per_second: { dim: 'speed', factor: 1, aliases: ['m/s', 'mps', 'meters per second'] },
  kilometres_per_hour: { dim: 'speed', factor: 0.277777778, aliases: ['km/h', 'kph', 'kilometers per hour'] },
  miles_per_hour: { dim: 'speed', factor: 0.44704, aliases: ['mph', 'miles per hour'] },
  knot: { dim: 'speed', factor: 0.514444444, aliases: ['kt', 'knots'] },

  // ── area (base: m²) ──
  square_metre: { dim: 'area', factor: 1, aliases: ['m2', 'sq m', 'square meter', 'square metres', 'square meters'] },
  square_foot: { dim: 'area', factor: 0.09290304, aliases: ['sq ft', 'sqft', 'square feet'] },
  square_mile: { dim: 'area', factor: 2_589_988.110336, aliases: ['sq mi', 'square miles'] },
  acre: { dim: 'area', factor: 4046.8564224, aliases: ['acres'] },
  hectare: { dim: 'area', factor: 10000, aliases: ['ha', 'hectares'] },

  // ── energy (base: joule) ──
  joule: { dim: 'energy', factor: 1, aliases: ['j', 'joules'] },
  kilojoule: { dim: 'energy', factor: 1000, aliases: ['kj', 'kilojoules'] },
  calorie: { dim: 'energy', factor: 4.184, aliases: ['cal', 'calories'] },
  kilocalorie: { dim: 'energy', factor: 4184, aliases: ['kcal', 'food calorie', 'food calories', 'kilocalories'] },
  watt_hour: { dim: 'energy', factor: 3600, aliases: ['wh', 'watt hours'] },
  kilowatt_hour: { dim: 'energy', factor: 3_600_000, aliases: ['kwh', 'kilowatt hours'] },

  // ── power (base: watt) ──
  watt: { dim: 'power', factor: 1, aliases: ['w', 'watts'] },
  kilowatt: { dim: 'power', factor: 1000, aliases: ['kw', 'kilowatts'] },
  horsepower: { dim: 'power', factor: 745.699872, aliases: ['hp'] },

  // ── pressure (base: pascal) ──
  pascal: { dim: 'pressure', factor: 1, aliases: ['pa', 'pascals'] },
  kilopascal: { dim: 'pressure', factor: 1000, aliases: ['kpa', 'kilopascals'] },
  bar: { dim: 'pressure', factor: 100000, aliases: ['bars'] },
  psi: { dim: 'pressure', factor: 6894.757293168, aliases: ['pounds per square inch'] },
  atmosphere: { dim: 'pressure', factor: 101325, aliases: ['atm', 'atmospheres'] },

  // ── digital storage (base: byte, decimal SI — what storage is sold in) ──
  byte: { dim: 'data', factor: 1, aliases: ['b', 'bytes'] },
  kilobyte: { dim: 'data', factor: 1000, aliases: ['kb', 'kilobytes'] },
  megabyte: { dim: 'data', factor: 1e6, aliases: ['mb', 'megabytes'] },
  gigabyte: { dim: 'data', factor: 1e9, aliases: ['gb', 'gigabytes'] },
  terabyte: { dim: 'data', factor: 1e12, aliases: ['tb', 'terabytes'] },

  // ── angle (base: degree) ──
  degree: { dim: 'angle', factor: 1, aliases: ['deg', 'degrees'] },
  radian: { dim: 'angle', factor: 57.29577951308232, aliases: ['rad', 'radians'] },
};

/** alias/name (lowercased) → canonical unit key. Built once at module load. */
export const UNIT_LOOKUP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [key, def] of Object.entries(UNITS)) {
    m[key.toLowerCase()] = key;
    m[key.replace(/_/g, ' ').toLowerCase()] = key;
    for (const a of def.aliases) m[a.toLowerCase()] = key;
  }
  return m;
})();
