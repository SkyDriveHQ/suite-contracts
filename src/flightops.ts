/**
 * MORAD — A dropzone's flight operations — every load, turn time and cost per load — rebuilt from public flight-tracking data.
 *
 * ## ⚠️ PROPOSED. Not agreed.
 *
 * Planted from `SkyDriveHQ/engine-seed` on 2026-10-02 under DEC-166. Safe to build a mock against; unsafe to
 * build a production dependency against until this header is removed.
 *
 * ## Rule 13
 *
 * Every boundary here is optional. A host app keeps its own native path, copies what it needs offline
 * into its own tables (the mirror rule), and degrades to "flightops unavailable" when MORAD can't be
 * reached. MORAD works for an operator with no host app at all.
 *
 * ## Vocabulary
 *
 * The contract uses MORAD's generic nouns so no sport's words reach it: a **sortie** is one climb from a
 * field and the return to it (a skydiving pack calls it a load); a **site** is the operator's field;
 * an **aircraft** is whatever flies the sorties. Every figure is an estimate rebuilt from public
 * flight-tracking data (adsb.lol, Open Database Licence) by MORAD's engine, never a manifest record.
 *
 * ## What goes here
 *
 * Only types that cross a product boundary (scope rule, `common.ts`). No I/O, no imports beyond
 * `./common.js`. Vertical-specific shapes (anything one sport needs) stay in MORAD's packs.
 */

import type { ISODate, ISODateTime, SuiteProvenance } from './common.js';

/** MORAD's own site id. A host stores it when the owner presses Connect; there is no shared tenant id. */
export type FlightopsSiteId = string;

/** The connection a host app holds to one MORAD site. */
export interface FlightopsConnection {
  readonly siteId: FlightopsSiteId;
  /** Which vertical pack shapes this site's records, e.g. `skydiving`. */
  readonly packId: string;
  readonly connectedAt: ISODateTime;
}

/** Every event MORAD sends a host carries this envelope, so the host can mirror it idempotently. */
export type FlightopsEventEnvelope<TType extends string, TData> = SuiteProvenance & {
  /** Unique per event; a host that has seen it ignores it. */
  readonly eventId: string;
  readonly type: TType;
  readonly siteId: FlightopsSiteId;
  readonly occurredAt: ISODateTime;
  readonly data: TData;
};

/**
 * One aircraft's tracked operations for one local day at one site: what a host mirrors into its own
 * tables (the mirror rule). Figures are what the tracking data shows; a host shows them beside its own
 * records, never in place of them.
 */
export interface FlightopsDailySummary {
  readonly siteId: FlightopsSiteId;
  /** Local calendar day at the site. */
  readonly date: ISODate;
  /** Registration as tracked, e.g. `N123AB`. */
  readonly aircraftRegistration: string;
  /** Sorties detected in the tracking data. */
  readonly sortieCount: number;
  /** Airborne hours, estimated from tracked take-off and landing. */
  readonly flightHours: number;
  /** Engine starts, estimated from stops long enough to be engine-off. */
  readonly engineStarts: number;
  /** Median ground time between sorties, minutes; `null` with fewer than two sorties. */
  readonly medianTurnMinutes: number | null;
  readonly fuelStops: number;
  /** Share of the day's flying hours with tracking data, 0..1. Missing data is never reported as zero sorties. */
  readonly coverage: number;
  /** The engine version that produced these figures, so a number can be reproduced. */
  readonly engineVersion: string;
}

/** Sent when a day's figures are first produced or recomputed. A host replaces its mirrored row. */
export type FlightopsDailySummaryEvent = FlightopsEventEnvelope<'flightops.daily_summary', FlightopsDailySummary>;
