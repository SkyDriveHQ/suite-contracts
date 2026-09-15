/**
 * Pilot reports — SkyPerson (pilot role) → DZGO.
 *
 * ## ⚠️ PROPOSED. Not agreed.
 *
 * DEC-079 describes this boundary in one line: *"Manifest and load state out;
 * hours, fuel, maintenance items and pilot messages in. Feeds DZGO §11 aircraft
 * economics."* Everything below is this session's proposal from that sentence
 * plus SkyPerson's already-built `Pilot.tsx`, and needs Kyle's sign-off.
 *
 * ## Two constraints from the pilot screen that this contract must not dilute
 *
 * **1. Offline-first (DEC-093).** A pilot in the air has no signal. Every
 * report here is something the pilot's device accepted locally and is now
 * relaying; `recordedAt` is when the pilot did it, `receivedAt` is when DZGO
 * heard about it, and they can be hours apart. A consumer that sorts by
 * arrival time will show a day's flying in the wrong order. Sort by
 * `recordedAt`.
 *
 * **2. The load sheet is a data sheet (DEC-091).** It is not a weight-and-
 * balance authorisation, the pilot does not sign it, and nothing crossing this
 * boundary may imply either. There is no `approved` field and there must never
 * be one.
 *
 * **And the spot is displayed, never computed (DEC-094).** Observed winds may
 * cross this boundary. A computed spot suggestion may not — DEC-094 permitted
 * testing one internally, with pilot and S&TA review, and explicitly did not
 * approve it for production.
 *
 * ## Rule 13
 *
 * DZGO has its own aircraft records (`domain/aircraft-reference.ts`,
 * `ui/AircraftPanel.tsx`) and a manifestor can type every one of these numbers
 * in. This overlay means the pilot does not have to walk to the desk to report
 * them — convenience, never requirement.
 */

import type {
  ISODate,
  ISODateTime,
  SuiteAdapterDescriptor,
  SuiteProvenance,
  SuiteSource,
  Unsubscribe,
} from './common.js';

/** Hobbs or tach reading. Which one is stated, because dropzones bill on both and they differ. */
export interface EngineTime {
  readonly kind: 'hobbs' | 'tach';
  /** Reading at the start of the flight. */
  readonly start: number;
  /** Reading at the end. Absent on a report filed before shutdown. */
  readonly end?: number;
}

/** Fuel as the pilot actually recorded it. No unit conversion happens in transit. */
export interface FuelEntry {
  readonly uplift?: number;
  readonly onBoardAtStart?: number;
  readonly onBoardAtEnd?: number;
  /** US gallons or litres. Stated, never assumed — the aircraft's own gauge decides. */
  readonly unit: 'usgal' | 'litre';
}

/**
 * Something the pilot noticed about the aircraft.
 *
 * **`grounded` here means the pilot has grounded the aircraft**, which is a
 * decision a pilot is entitled to make and software is not. It reports that a
 * person did it. It never causes it.
 */
export interface Squawk {
  readonly squawkId: string;
  readonly recordedAt: ISODateTime;
  /** Free text, shown verbatim. Never parsed, never categorised automatically. */
  readonly description: string;
  /** What the pilot said about dispatch. `grounded` = the pilot grounded it. */
  readonly disposition: 'note' | 'monitor' | 'grounded';
  readonly resolvedAt?: ISODateTime;
  readonly resolvedNote?: string;
}

/** One flight, as the pilot reported it. */
export type PilotFlightReport = SuiteProvenance & {
  reportId: string;
  /** The dropzone's own load identifier, where the pilot's device knew one. */
  loadRef?: string | null;
  /** Aircraft tail number. The join key — both products already know it. */
  tailNumber: string;
  operatingDay: ISODate;
  /** When the pilot recorded this. **Sort by this, not by arrival.** */
  recordedAt: ISODateTime;
  /** When the consuming product received it. Later than `recordedAt` after an offline stretch. */
  receivedAt: ISODateTime;
  engineTime?: EngineTime;
  fuel?: FuelEntry;
  /** Takeoff and shutdown, where recorded. */
  departedAt?: ISODateTime | null;
  landedAt?: ISODateTime | null;
  /** Free text from the pilot to manifest. Shown verbatim. */
  message?: string | null;
};

/**
 * Winds the pilot observed aloft.
 *
 * Observations only. **No spot suggestion crosses this boundary** — see
 * DEC-094 in the header.
 */
export interface WindObservation {
  readonly observedAt: ISODateTime;
  readonly altitudeFt: number;
  readonly directionDeg: number;
  readonly speedKt: number;
}

export type PilotEventType = 'pilot.flight_reported' | 'pilot.squawk_raised' | 'pilot.squawk_resolved' | 'pilot.wind_observed';

export interface PilotEvent {
  type: PilotEventType;
  at: ISODateTime;
  report?: PilotFlightReport;
  squawk?: Squawk;
  wind?: WindObservation;
}

export interface PilotReportAdapter {
  readonly source: SuiteSource;
  readonly descriptor: SuiteAdapterDescriptor;
  getFlightReports(day: ISODate): Promise<PilotFlightReport[]>;
  getSquawks(tailNumber: string): Promise<Squawk[]>;
  getWindObservations(day: ISODate): Promise<WindObservation[]>;
  subscribe(listener: (event: PilotEvent) => void): Unsubscribe;
}

/**
 * Flight time from an engine-time pair, or undefined while the flight is open.
 *
 * Returns hours to two decimals because that is how a Hobbs meter reads and how
 * the aircraft economics in DZGO §11 bill. Rounding here rather than at each
 * call site keeps every screen showing the same number.
 */
export function flightHours(engineTime: EngineTime | undefined): number | undefined {
  if (!engineTime || engineTime.end === undefined) return undefined;
  return Math.round((engineTime.end - engineTime.start) * 100) / 100;
}
