const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parses durations like `250ms`, `30s`, `4h`, `7d` or `1h30m` into milliseconds. */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') return input;
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/g;
  let total = 0;
  let matched = '';
  for (const m of input.trim().matchAll(re)) {
    total += Number(m[1]) * UNITS[m[2]!]!;
    matched += m[0];
  }
  if (!matched || matched.replace(/\s/g, '') !== input.replace(/\s/g, '')) {
    throw new Error(`Invalid duration: "${input}"`);
  }
  return total;
}
