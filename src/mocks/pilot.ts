/**
 * Mock `PilotReportAdapter` — the SkyPerson (pilot role) → DZGO seam.
 *
 * SkyPerson's pilot screen is built and reports actions into local state. This
 * generator produces the same reports in the shape DZGO would consume, so the
 * aircraft-economics side (DZGO §11) can be built against realistic Hobbs, fuel
 * and squawk data before any pilot device exists.
 *
 * **The offline gap is fabricated on purpose.** DEC-093 makes the pilot role
 * offline-first, so `recordedAt` and `receivedAt` routinely differ by an hour
 * or more, and reports arrive out of order. A generator that set them equal
 * would let a consumer sort by arrival time and look correct right up until the
 * first real flight.
 */

import type {
  EngineTime,
  FuelEntry,
  ISODate,
  PilotEvent,
  PilotFlightReport,
  PilotReportAdapter,
  Squawk,
  Unsubscribe,
  WindObservation,
} from '../index.js';
import { MockScenario } from './scenario.js';

const TAILS = ['N182TD', 'N206XP', 'N99KA'] as const;

const SQUAWK_TEXT = [
  'Left brake line showing wear near the guide ring.',
  'Nose gear strut looks low; needs servicing before next flight.',
  'Number two radio intermittent on transmit.',
  'Door latch stiff — takes two hands to close.',
  'Oil consumption up, roughly a quart per four hours.',
] as const;

export interface MockPilotDayOptions {
  /** Flights to fabricate. Default 8. */
  flights?: number;
  /** Tail numbers in service today. Defaults to all three mock aircraft. */
  tails?: readonly string[];
  /** Share of flights filed while offline, so they arrive late. Default 0.35. */
  offlineRate?: number;
}

function addMinutes(iso: string, minutes: number): string {
  const t = new Date(iso);
  t.setMinutes(t.getMinutes() + minutes);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

function buildDay(scenario: MockScenario, options: MockPilotDayOptions): PilotFlightReport[] {
  const count = options.flights ?? 8;
  const tails = options.tails ?? TAILS;
  const offlineRate = options.offlineRate ?? 0.35;
  const rng = scenario.streamFor('pilot-flights');
  const out: PilotFlightReport[] = [];

  // Hobbs runs continuously per airframe across the day, so the meter has to be
  // carried between flights rather than randomised per flight.
  const hobbs = new Map<string, number>();
  for (const t of tails) hobbs.set(t, rng.int(1200, 4800) + rng.next());

  for (let i = 0; i < count; i += 1) {
    const tailNumber = rng.pick(tails);
    const start = hobbs.get(tailNumber) ?? 1000;
    // A jump flight to 13,500 ft and back is roughly 20–28 minutes.
    const durationHours = rng.gaussian(40, 6, 28, 55) / 100;
    const end = Math.round((start + durationHours) * 100) / 100;
    hobbs.set(tailNumber, end);

    const hour = 9 + Math.floor((i * 40) / 60);
    const minute = (i * 40) % 60;
    const departedAt = `${scenario.activityDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
    const landedAt = addMinutes(departedAt, Math.round(durationHours * 60));
    const recordedAt = addMinutes(landedAt, rng.int(1, 6));

    // Offline-first: a report filed with no signal lands when the aircraft is
    // back in wifi range, which can be much later and out of order.
    const offline = rng.chance(offlineRate);
    const receivedAt = offline ? addMinutes(recordedAt, rng.int(35, 220)) : addMinutes(recordedAt, rng.int(0, 2));

    const engineTime: EngineTime = { kind: rng.chance(0.7) ? 'hobbs' : 'tach', start, end };
    const fuel: FuelEntry = {
      unit: 'usgal',
      ...(rng.chance(0.4) ? { uplift: rng.int(20, 90) } : {}),
      onBoardAtStart: rng.int(30, 180),
      onBoardAtEnd: rng.int(20, 150),
    };

    out.push({
      ...scenario.provenance(),
      reportId: scenario.id('flight', i + 1),
      loadRef: rng.chance(0.85) ? scenario.id('load', i + 1) : null,
      tailNumber,
      operatingDay: scenario.activityDate,
      recordedAt,
      receivedAt,
      engineTime,
      fuel,
      departedAt,
      landedAt,
      message: rng.chance(0.2) ? 'Winds picking up at altitude, expect a longer spot.' : null,
    });
  }
  // Delivered in arrival order, because that is how a consumer will really
  // receive them — and why it has to sort by `recordedAt` itself.
  return out.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

function buildSquawks(scenario: MockScenario, tails: readonly string[]): Map<string, Squawk[]> {
  const rng = scenario.streamFor('pilot-squawks');
  const map = new Map<string, Squawk[]>();
  for (const tail of tails) {
    const squawks: Squawk[] = [];
    const n = rng.int(0, 2);
    for (let i = 0; i < n; i += 1) {
      const resolved = rng.chance(0.5);
      squawks.push({
        squawkId: scenario.id('squawk', squawks.length + 1),
        recordedAt: `${scenario.activityDate}T${String(rng.int(8, 17)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}:00`,
        description: rng.pick(SQUAWK_TEXT),
        // `grounded` records that a pilot grounded the aircraft. It never causes it.
        disposition: rng.pick<Squawk['disposition']>(['note', 'monitor', 'monitor', 'grounded']),
        ...(resolved
          ? { resolvedAt: new Date().toISOString(), resolvedNote: 'Inspected, within limits.' }
          : {}),
      });
    }
    map.set(tail, squawks);
  }
  return map;
}

function buildWinds(scenario: MockScenario): WindObservation[] {
  const rng = scenario.streamFor('pilot-winds');
  const out: WindObservation[] = [];
  // Surface wind veers and strengthens with altitude — an approximate Ekman
  // spiral. Independent random winds per altitude would give a pilot a picture
  // no real sounding produces.
  const surfaceDir = rng.int(0, 359);
  const surfaceSpd = rng.int(3, 14);
  for (const altitudeFt of [0, 3000, 6000, 9000, 13500]) {
    out.push({
      observedAt: `${scenario.activityDate}T${String(rng.int(8, 16)).padStart(2, '0')}:00:00`,
      altitudeFt,
      directionDeg: (surfaceDir + Math.round(altitudeFt / 450) + rng.int(-8, 8) + 360) % 360,
      speedKt: surfaceSpd + Math.round(altitudeFt / 900) + rng.int(-2, 4),
    });
  }
  return out;
}

/** A fabricated flying day behind the real adapter interface. */
export class MockPilotReports implements PilotReportAdapter {
  readonly source = 'mock' as const;
  readonly descriptor = {
    label: 'Mock pilot reports (SkyPerson stand-in)',
    speaks: 'skyperson' as const,
    isMock: true,
  };

  private reports: PilotFlightReport[];
  private squawks: Map<string, Squawk[]>;
  private winds: WindObservation[];
  private listeners = new Set<(event: PilotEvent) => void>();

  constructor(
    readonly scenario: MockScenario = new MockScenario(),
    options: MockPilotDayOptions = {},
  ) {
    const tails = options.tails ?? TAILS;
    this.reports = buildDay(scenario, options);
    this.squawks = buildSquawks(scenario, tails);
    this.winds = buildWinds(scenario);
  }

  async getFlightReports(day: ISODate): Promise<PilotFlightReport[]> {
    return this.reports.filter((r) => r.operatingDay === day);
  }

  async getSquawks(tailNumber: string): Promise<Squawk[]> {
    return this.squawks.get(tailNumber) ?? [];
  }

  async getWindObservations(_day: ISODate): Promise<WindObservation[]> {
    return [...this.winds];
  }

  subscribe(listener: (event: PilotEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Deliver a report that was filed offline earlier.
   *
   * The one transition worth driving by hand: it is how a consumer discovers
   * whether its ordering survives a late arrival.
   */
  deliverLateReport(recordedMinutesAgo: number): PilotFlightReport {
    const now = new Date().toISOString();
    const report: PilotFlightReport = {
      ...this.scenario.provenance('injector'),
      reportId: this.scenario.id('flight', this.reports.length + 1),
      loadRef: null,
      tailNumber: this.scenario.streamFor('pilot-late').pick(TAILS),
      operatingDay: this.scenario.activityDate,
      recordedAt: addMinutes(now, -recordedMinutesAgo),
      receivedAt: now,
      message: 'Filed offline, delivered on landing.',
    };
    this.reports.push(report);
    const event: PilotEvent = { type: 'pilot.flight_reported', at: now, report };
    for (const l of this.listeners) l(event);
    return report;
  }
}

export function mockPilotReports(scenario?: MockScenario, options?: MockPilotDayOptions): MockPilotReports {
  return new MockPilotReports(scenario, options);
}
