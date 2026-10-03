/**
 * MORAD — A dropzone's flight operations — every load, turn time and cost per load — rebuilt from public flight-tracking data.
 *
 * ## ⚠️ PROPOSED. Not agreed.
 *
 * Planted from `SkyDriveHQ/engine-seed` on 2026-10-02 under DEC-166. Safe to build a mock against; unsafe to
 * build a production dependency against until this header is removed.
 *
 * **Revised 2026-10-03 to match MORAD's results spec** (`SkyDriveHQ/morad` `docs/MORAD-RESULTS-SPEC.md`), which
 * settles seven places where the first draft disagreed with what the engine actually writes. In short: a host
 * receives one record per site per day carrying every aircraft's day (so "no data" and "withdrawn for
 * privacy" can be said); aircraft are keyed by ICAO hex, with the registration as a dated display field; what
 * the tracking data saw is kept apart from what was estimated, in separate groups; "turn" is two named
 * figures, not one ambiguous one; coverage is split into the archive's coverage and the take-offs and landings
 * seen; every record names the engine run that made it. All of these are Claude's defaults, not yet agreed.
 * The headline meaning of "turn" is an open question for Kyle (MORAD MRD-Q-001); the fields below carry both
 * measures, so the answer changes a label, not this file.
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
 * an **aircraft** is whatever flies the sorties; a **stop** is the time between two sorties of one aircraft
 * on one day; the **top** is the top of a sortie's climb. Every figure is rebuilt from public flight-tracking
 * data (adsb.lol, Open Database Licence) by MORAD's engine, never a manifest record.
 *
 * ## Privacy
 *
 * No record here ever names an aircraft whose owner asked the FAA to limit tracking. The one exception MORAD
 * allows (the site's own aircraft, to that site's members only) is not served until there is a way to prove
 * an aircraft is the site's (MORAD MRD-Q-003). No record carries a count of such aircraft per day.
 *
 * ## What goes here
 *
 * Only types that cross a product boundary (scope rule, `common.ts`). No I/O, no imports beyond
 * `./common.js`. Vertical-specific shapes (anything one sport needs, such as a "high" altitude share) stay
 * in MORAD's packs. No cost figure crosses this boundary.
 */

import type { ISODate, ISODateTime, SuiteProvenance } from './common.js';

/** MORAD's own site id. A host stores it when the owner presses Connect; there is no shared tenant id. */
export type FlightopsSiteId = string;

/**
 * The aircraft's 24-bit ICAO address, lower-case hex, e.g. `a1b2c3`: what the tracking data actually carries,
 * so it is the key. A registration can be unknown, and two unknown registrations would collide.
 */
export type FlightopsAircraftHex = string;

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
 * The engine run that produced a record. The engine's estimates (which stops were engine-off, routine or fuel
 * stops) come from models fitted over the whole window, so the same day can read differently after a rerun
 * over a different window; this says which run a host is looking at.
 */
export interface FlightopsRunInfo {
  readonly runId: string;
  /** Engine version and commit, e.g. `0.1.0+c44e5a5`, so a number can be reproduced. */
  readonly engineVersion: string;
  /** Local dates the run covered, inclusive. */
  readonly windowStart: ISODate;
  readonly windowEnd: ISODate;
  readonly computedAt: ISODateTime;
}

/**
 * Whether the archive had the data for a day. Only `complete` with no aircraft means "nothing flew that the
 * tracking data could see". Missing data is never reported as zero sorties.
 * - `complete`: every slice of tracking data the engine needed was read.
 * - `partial`: some slices were gaps in the archive; sorties may be missing.
 * - `not_yet_published`: some slices are not in the archive yet (it publishes a day a few hours after it
 *   ends); the day will be rerun.
 * - `missing`: none could be read.
 */
export type FlightopsDayStatus = 'complete' | 'partial' | 'not_yet_published' | 'missing';

/** What the tracking data saw for one aircraft on one day. No model or profile is involved. */
export interface FlightopsObservedDay {
  /** Sorties detected; the top of each one's climb was in the tracking data. */
  readonly sortieCount: number;
  /** Sorties whose take-off was seen (low near the field), and whose landing was. The rest were estimated. */
  readonly takeoffsSeen: number;
  readonly landingsSeen: number;
}

/** What the engine estimated for one aircraft on one day, from climb and descent profiles and fitted models. */
export interface FlightopsEstimatedDay {
  /** Airborne hours: the sum of each sortie's estimated take-off to estimated landing. */
  readonly flightHours: number;
  /** Sorties that followed an engine start: the first of the day, or the first after an engine-off stop. */
  readonly engineStarts: number;
  /** Stops long enough that the engine was judged shut down. */
  readonly engineOffStops: number;
  /** Stops the fuel model labelled a fuel stop. Fuel taken during an engine-off stop is not counted. */
  readonly fuelStops: number;
  /** Stops with the engine running in the dominant ("routine") regime: the stops both medians below use. */
  readonly routineTurns: number;
  /** Median minutes from one sortie's top to the next one's, over the routine turns; `null` if none. */
  readonly medianTopToTopMinutes: number | null;
  /** Median estimated minutes on the ground, landing to next take-off, over the same turns; `null` if none. */
  readonly medianGroundMinutes: number | null;
}

/**
 * One aircraft's tracked operations for one local day at one site: what a host mirrors into its own
 * tables (the mirror rule). A host shows these beside its own records, never in place of them.
 */
export interface FlightopsAircraftDay {
  readonly aircraftHex: FlightopsAircraftHex;
  /** Registration as looked up, e.g. `N123AB`, for display; `null` when unknown. */
  readonly aircraftRegistration: string | null;
  /** The date the registration was looked up or last seen in the tracking data's own record. */
  readonly registrationAsOf: ISODate | null;
  readonly observed: FlightopsObservedDay;
  readonly estimated: FlightopsEstimatedDay;
}

/**
 * One site's day: the unit a host mirrors. A host replaces everything it holds for (siteId, date) with this
 * record, so an aircraft withdrawn for privacy, or a day that turns out to be missing, disappears too.
 */
export interface FlightopsSiteDay {
  readonly siteId: FlightopsSiteId;
  /** Local calendar day at the site. */
  readonly date: ISODate;
  readonly status: FlightopsDayStatus;
  /** Share of the slices of tracking data the engine needed that day that the archive had, 0..1. */
  readonly archiveCoverage: number;
  /**
   * True when the day's few screening slices showed no climb-out, so the rest of the day was not read. A
   * `complete` day with no aircraft and this flag means "no flying found in screening", which a host shows as
   * such rather than as a flat zero.
   */
  readonly screenedOnly: boolean;
  /** One entry per aircraft that flew at least one sortie; empty is meaningful only when `status` is `complete`. */
  readonly aircraft: readonly FlightopsAircraftDay[];
  readonly run: FlightopsRunInfo;
}

/** Sent when a site's day is first produced, recomputed or withdrawn from. A host replaces its mirrored day. */
export type FlightopsSiteDayEvent = FlightopsEventEnvelope<'flightops.site_day', FlightopsSiteDay>;
