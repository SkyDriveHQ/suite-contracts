/**
 * Seeded fabrication primitives shared by every mock generator in this package.
 *
 * `Rng` is mulberry32, carried over unchanged from
 * `dzgo-test-harness/src/scenarios/rng.ts` so that a seed means the same thing
 * on both sides of every boundary. A scenario reproduced in DZGO's Test Control
 * Panel and the same scenario replayed in SkyPerson must produce the same
 * people, or the mocks are not testing the boundary — they are testing two
 * unrelated fabrications that happen to share a name.
 */

/**
 * The string every fabricated record in this package is tagged with.
 *
 * DZGO's post-build isolation check (`dzgo/scripts/check-isolation.mjs`) greps
 * production bundles for markers like this one. Adding the sentinel here means
 * a mock generator that leaks into a production build **fails the build**
 * rather than shipping. That is the whole mechanism enforcing suite Rule 10's
 * "a fabricated record and a real customer must never be confusable" — so it
 * must be a literal, and must never be assembled from fragments at runtime.
 */
export const SUITE_MOCK_SENTINEL = 'skydrive-suite-contracts-mock-runtime';

/** Small seeded PRNG so a randomized scenario can be reproduced from its seed. */
export class Rng {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Roughly normal around `mean`, clamped. */
  gaussian(mean: number, spread: number, min: number, max: number): number {
    const u = 1 - this.next();
    const v = this.next();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.min(max, Math.max(min, Math.round(mean + z * spread)));
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

/**
 * Obviously-fake surnames.
 *
 * Chosen to be recognisable as test data at a glance, because the day somebody
 * pastes a mock record into a bug report, the name is the first thing a reader
 * sees. Real-looking names in a screenshot are how fabricated data gets
 * mistaken for a customer.
 */
const LAST_NAMES = [
  'Testerson', 'Mockworth', 'Sampleton', 'Fixtura', 'Placeholder',
  'Stubbings', 'Fakenham', 'Dummett', 'Simulacra', 'Proxyman',
] as const;

const FIRST_NAMES = [
  'Ada', 'Bo', 'Cleo', 'Dev', 'Eli', 'Fern', 'Gus', 'Hana',
  'Ines', 'Jo', 'Kit', 'Lou', 'Mo', 'Nia', 'Ozzy', 'Pia',
] as const;

export function mockName(rng: Rng): { first: string; last: string } {
  return { first: rng.pick(FIRST_NAMES), last: rng.pick(LAST_NAMES) };
}

/** `YYYY-MM-DD` for today in local time. */
export function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local-time ISO instant. Mock days are dropzone-local; UTC would shift a dusk load into tomorrow. */
export function nowIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `date` shifted by whole days, as `YYYY-MM-DD`. */
export function shiftDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
