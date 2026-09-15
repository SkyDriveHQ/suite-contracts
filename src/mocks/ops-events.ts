/**
 * Mock `OpsEventSink` — the every-product → SkyDrive Ops seam.
 *
 * Two implementations, and the difference between them is the point:
 *
 * - `RecordingOpsEventSink` keeps what it was given, so a product can assert in
 *   a test that it emitted what it meant to.
 * - `mockOpsEventStream` fabricates a plausible day of events, so Ops can build
 *   a dashboard before a single product has an emitter.
 *
 * **Both refuse to carry identifying data**, and `assertNonIdentifying` is
 * exported so a consuming test can make that a hard assertion rather than a
 * hope. The contract already forbids free text by having no field for it; this
 * catches the case where somebody adds one.
 */

import type { ISODateTime, OpsEvent, OpsEventKind, OpsEventOutcome, OpsEventSink, SuiteSource } from '../index.js';
import { MockScenario } from './scenario.js';

/**
 * Collects events instead of sending them.
 *
 * `emit` swallows everything and never throws — the same guarantee the real
 * sink makes, because a product that could be made to fail by an Ops problem
 * would have made Ops a required dependency.
 */
export class RecordingOpsEventSink implements OpsEventSink {
  readonly events: OpsEvent[] = [];

  constructor(readonly product: SuiteSource = 'dzgo') {}

  emit(event: OpsEvent): void {
    this.events.push(event);
  }

  async flush(): Promise<void> {}

  /** Events of one kind, for a test that cares about a single signal. */
  ofKind(kind: OpsEventKind): OpsEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }

  clear(): void {
    this.events.length = 0;
  }
}

/**
 * Fails if an event carries anything that could identify a person.
 *
 * Checks the shape, not a blocklist of names: any string-valued field beyond
 * the known-safe set is a finding, because the way customer data gets into an
 * operations log is somebody adding a convenient `detail` string, not somebody
 * deciding to log a name.
 */
const ALLOWED_STRING_FIELDS = new Set(['eventId', 'kind', 'outcome', 'product', 'release', 'at', 'tenantKey']);

export function assertNonIdentifying(event: OpsEvent): void {
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === 'string' && !ALLOWED_STRING_FIELDS.has(key)) {
      throw new Error(
        `OpsEvent carries an unexpected string field "${key}". ` +
          `Ops events must not carry free text or person references — add a new OpsEventKind instead.`,
      );
    }
    if (key === 'measures' && value && typeof value === 'object') {
      for (const [m, n] of Object.entries(value as Record<string, unknown>)) {
        if (typeof n !== 'number') {
          throw new Error(`OpsEvent measure "${m}" is not a number. Measures are bounded numeric detail only.`);
        }
      }
    }
  }
}

const KINDS: OpsEventKind[] = [
  'product.started',
  'product.deployed',
  'sync.succeeded',
  'sync.failed',
  'sibling.unreachable',
  'adapter.configured',
  'migration.applied',
  'error.unhandled',
];

const PRODUCTS: SuiteSource[] = ['dzgo', 'skyperson', 'skyvideo', 'rigging'];

export interface MockOpsStreamOptions {
  /** Events to fabricate. Default 40. */
  count?: number;
  /** Products emitting. Defaults to all four. */
  products?: readonly SuiteSource[];
}

/**
 * A fabricated day of operations events across the suite.
 *
 * Outcomes are correlated with kind rather than random: `sync.failed` is always
 * a failure and `product.started` is always fine. Random outcomes would produce
 * a dashboard that cannot be sanity-checked by eye, which is the only way
 * anyone reviews one.
 */
export function mockOpsEventStream(
  scenario: MockScenario = new MockScenario(),
  options: MockOpsStreamOptions = {},
): OpsEvent[] {
  const count = options.count ?? 40;
  const products = options.products ?? PRODUCTS;
  const rng = scenario.streamFor('ops-events');
  const out: OpsEvent[] = [];

  // A stable, non-identifying tenant key per fabricated dropzone. Ops can see
  // "one tenant is failing" without ever learning which.
  const tenants = Array.from({ length: 3 }, (_, i) => `mock-tenant-${(i + 1).toString(16).padStart(4, '0')}`);

  for (let i = 0; i < count; i += 1) {
    const kind = rng.pick(KINDS);
    const outcome: OpsEventOutcome =
      kind === 'sync.failed' || kind === 'error.unhandled'
        ? 'failed'
        : kind === 'sibling.unreachable'
          ? 'degraded'
          : 'ok';

    const hour = Math.floor((i / count) * 12) + 7;
    const at: ISODateTime = `${scenario.activityDate}T${String(hour).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}:00`;

    const measures: Record<string, number> = { durationMs: rng.int(8, 4200) };
    if (outcome !== 'ok') measures['retries'] = rng.int(1, 4);
    if (kind === 'sync.succeeded') measures['records'] = rng.int(1, 320);

    const event: OpsEvent = {
      eventId: scenario.id('opsev', i + 1),
      kind,
      outcome,
      product: rng.pick(products),
      release: `mock-0.${rng.int(1, 9)}.${rng.int(0, 9)}`,
      at,
      tenantKey: rng.pick(tenants),
      measures,
    };
    // Every fabricated event passes the same check a consumer should apply.
    assertNonIdentifying(event);
    out.push(event);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** A sink pre-loaded with a fabricated day, for a dashboard with nothing real to show yet. */
export function mockOpsEventSink(
  product: SuiteSource = 'dzgo',
  scenario?: MockScenario,
  options?: MockOpsStreamOptions,
): RecordingOpsEventSink {
  const sink = new RecordingOpsEventSink(product);
  for (const e of mockOpsEventStream(scenario, options)) sink.emit(e);
  return sink;
}
