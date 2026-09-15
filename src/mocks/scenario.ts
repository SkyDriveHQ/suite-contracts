/**
 * The fabricated day every mock generator in this package shares.
 *
 * A "scenario" is one reproducible day: a seed, a date, and an id that tags
 * every record produced under it. Tagging matters for two reasons — a day can
 * be wiped cleanly without touching anything real, and a record that escapes
 * into a screenshot or a shared database says plainly where it came from.
 */

import type { MockGenerator, MockProvenance, SuiteProvenance } from '../common.js';
import { Rng, SUITE_MOCK_SENTINEL, randomSeed, todayIso } from './rng.js';

export interface MockScenarioOptions {
  /** Defaults to a random seed. Pass one to reproduce a day exactly. */
  seed?: number;
  /** The operating day being fabricated. Defaults to today, local. */
  activityDate?: string;
  /** Shown in test panels. Defaults to a name derived from the seed. */
  name?: string;
  generator?: MockGenerator;
}

/**
 * A fabricated day, and the provenance stamp for every record in it.
 *
 * Deliberately holds no records of its own. Each generator produces its own
 * records from the shared `rng`, so adding a seam never touches this class and
 * two generators sharing a scenario stay consistent with each other.
 */
export class MockScenario {
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly seed: number;
  readonly activityDate: string;
  readonly generator: MockGenerator;
  readonly rng: Rng;
  /** Present so a bundled mock trips DZGO's isolation check. See `rng.ts`. */
  readonly sentinel = SUITE_MOCK_SENTINEL;

  constructor(options: MockScenarioOptions = {}) {
    this.seed = options.seed ?? randomSeed();
    this.activityDate = options.activityDate ?? todayIso();
    this.generator = options.generator ?? 'random';
    this.scenarioId = `mock-scn-${this.seed.toString(16).padStart(8, '0')}`;
    this.scenarioName = options.name ?? `Fabricated day ${this.activityDate} (seed ${this.seed})`;
    this.rng = new Rng(this.seed);
  }

  /**
   * The provenance stamp for one record.
   *
   * Returns the `mock` branch of `SuiteProvenance`, so the type system will not
   * let a caller build a fabricated record without it.
   */
  provenance(generator: MockGenerator = this.generator): SuiteProvenance {
    const mock: MockProvenance = {
      scenarioId: this.scenarioId,
      scenarioName: this.scenarioName,
      generator,
      seed: this.seed,
      generatedAt: new Date().toISOString(),
    };
    return { source: 'mock', mock };
  }

  /**
   * An independent random stream for one generator.
   *
   * **Every generator must use this rather than the shared `rng`.** Two calls
   * with the same namespace return identical sequences, so fabricating the
   * same day twice produces the same day — and, just as importantly, adding a
   * generator or constructing them in a different order cannot shift any other
   * generator's output. Sharing one cursor made a mock's content depend on
   * what else happened to be built first, which is invisible until a test that
   * should pass stops passing.
   */
  streamFor(namespace: string): Rng {
    // FNV-1a over the namespace, mixed with the seed.
    let h = 0x811c9dc5;
    for (let i = 0; i < namespace.length; i += 1) {
      h ^= namespace.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return new Rng((h ^ this.seed) >>> 0);
  }

  /** A stable, obviously-fake id for a record of `kind` within this scenario. */
  id(kind: string, n: number): string {
    return `mock-${kind}-${this.scenarioId.slice(-8)}-${String(n).padStart(3, '0')}`;
  }
}
