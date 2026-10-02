/**
 * Weather — SkyWeather → any app (DZGO, SkyPerson, a dropzone's website, a third party).
 *
 * ## ⚠️ PROPOSED. Not agreed.
 *
 * **What is specified.** DEC-164 (skyapp `docs/history/DECISION-LOG.md`, 2026-10-01) makes weather a
 * standalone SkyDrive product that any app plugs into. Kyle's own words fix four things this file must
 * not dilute: owners enter their own limits and nothing is pre-filled; the product notifies on
 * approaching, past and back within, and when a source stops reporting; sources are never blended; and
 * every display of conditions sits under the header "Weather observations (source)". SkyWeather's
 * specs (`skyweather/docs/for-humans/specs/`: observation format, API v1, webhooks) define the shapes
 * below, and `WeatherObservation` is copied field for field from SkyWeather's own `Observation`
 * (`skyweather/packages/weather-core/src/types.ts`).
 *
 * The limit vocabulary (`WeatherLimitState` with its starting `'unknown'`, `WeatherSourceHealth`,
 * `WeatherLimitMetric`, `WeatherLimitDirection`, `WeatherLimitValue`) mirrors SkyWeather's built limits
 * engine (`packages/weather-core/src/limits/types.ts`, spec `docs/for-humans/specs/limits-engine.md`).
 *
 * **What is inferred.** The adapter surface (`WeatherAdapter`), the envelope types around an
 * observation (`WeatherSourceReading`, `WeatherLimitStatus`) and the event payload's exact field list
 * are this session's proposal from those specs.
 *
 * **What it waits on.** SkyWeather build slice W6 (the integration kit, Ops `39fc0695`), which makes this
 * the agreed contract and retags the package. Until then: **safe to build a mock against, unsafe to build
 * a real feed against.** The test asserting that `WeatherObservation` and SkyWeather's `Observation` are
 * the same shape lives in SkyWeather's `packages/contracts` (W6). It must exist before this file loses
 * its PROPOSED header: "compatible, claimed in a comment" is exactly the failure this package was founded
 * to remove (see README).
 *
 * ## Why times here are numbers, not the suite's ISO strings
 *
 * Every other boundary in this package uses `ISODateTime` strings, and mock days are dropzone-local.
 * Weather cannot: airport reports are issued in UTC ("Zulu"), and a site-local naive time would make
 * "observed 14 minutes ago" wrong by the UTC offset. So every time on this boundary is **UTC epoch
 * milliseconds** (`UtcMs`), as in SkyWeather's own types and its API. Convert to site-local only to show.
 *
 * ## Three rules every consumer must keep
 *
 * 1. **`null` means "not measured".** Not zero, not calm, not clear. A hangar anemometer has no ceiling;
 *    an airport report has no lull. Never render `null` as `0` or "clear".
 * 2. **A silent source never clears an alert.** Limit state (`WeatherLimitState`) and source health
 *    (`WeatherSourceHealth`) are separate fields on purpose. "Past, and not heard from since" is a real
 *    combination; show both, never collapse them.
 * 3. **Sources are never blended.** Each reading belongs to one source and is shown under its own
 *    `weatherPanelHeader(label)`. Nothing here averages across sources, and no consumer may.
 *
 * ## Rule 13
 *
 * No SkyDrive app may need SkyWeather. DZGO already calls holds by hand; SkyPerson's pilot screen works
 * without a reading. Every `WeatherAdapter` implementation throws `SiblingUnreachableError('weather')`
 * when SkyWeather cannot be reached, and the consumer shows **"Weather unavailable"** and carries on.
 * **A consumer never invents a reading**, and never shows an old one as current: an old reading may be
 * shown only with its age, under its source header.
 *
 * Nothing on this boundary is a command. No event holds the day or tells anyone what to do; it reports
 * that a reading crossed a number the owner typed. Holding stays a human press (DEC-164).
 */

import type { SuiteAdapterDescriptor, SuiteProvenance, SuiteSource, Unsubscribe } from './common.js';

/** Milliseconds since the Unix epoch, UTC. See the header for why this boundary does not use `ISODateTime`. */
export type UtcMs = number;

/** Mirrors SkyWeather's `SourceKind` exactly. Consumers must tolerate a kind they do not know (show its label). */
export type WeatherSourceKind =
  | 'noaa-metar' // airport report (METAR/SPECI) from NOAA's Aviation Weather Center
  | 'noaa-taf' // airport forecast; produces forecasts, not observations
  | 'noaa-windtemp' // winds aloft; produces aloft forecasts, not surface observations
  | 'nws-forecast' // US National Weather Service hourly gridpoint forecast
  | 'awos-bridge' // an AWOS data port read on site by the bridge (report text)
  | 'davis-cloud' // Davis WeatherLink v2 cloud API
  | 'davis-local' // Davis WeatherLink Live on the local network, via the bridge
  | 'tempest' // WeatherFlow Tempest: the owner's own station only
  | 'ambient' // Ambient Weather REST / realtime
  | 'push-ecowitt' // a station's custom-server upload, Ecowitt format
  | 'push-wunderground' // a station's custom-server upload, Wunderground format
  | 'manual'; // typed in by a person; carries who entered it

/** Mirrors SkyWeather's `SourceDescriptor` exactly. */
export interface WeatherSourceDescriptor {
  id: string;
  siteId: string;
  kind: WeatherSourceKind;
  /** What the owner calls it. Shown in "Weather observations (<label>)". */
  label: string;
  /** Height of the wind sensor above ground, metres, when known. Shown, never corrected for. */
  sensorHeightM?: number;
  /** How often this source is expected to report, in seconds. Past this it becomes "late", then "not reporting". */
  expectedIntervalS: number;
}

/** Mirrors SkyWeather's `CloudCover`. */
export type WeatherCloudCover = 'FEW' | 'SCT' | 'BKN' | 'OVC' | 'VV';

/** Mirrors SkyWeather's `CloudLayer`. */
export interface WeatherCloudLayer {
  cover: WeatherCloudCover;
  /** Base above ground level, feet. */
  baseFtAgl: number;
  /** e.g. 'CB' or 'TCU' when reported. */
  type?: 'CB' | 'TCU';
}

/**
 * One reading from one source. **Mirrors SkyWeather's `Observation` field for field.**
 *
 * Deliberately carries no provenance block, so the two declarations stay identical; provenance rides on
 * the envelopes (`WeatherSourceReading`, `WeatherLimitStatus`, `WeatherAlertEvent`) instead.
 */
export interface WeatherObservation {
  sourceId: string;
  observedAt: UtcMs;
  /**
   * When the reading summarises a window (the bridge sends one summary per minute), its length in
   * seconds. `windKt` is then the window average, `gustKt` the window maximum and `lullKt` the window
   * minimum, so the number limits care about (the gust) is never lost.
   */
  windowS?: number;

  /** Direction the wind is FROM, degrees true. `null` when calm, variable or not measured. */
  windDirDeg: number | null;
  /** Reported as variable (METAR `VRB`). */
  windVariable: boolean;
  /** METAR variable-direction range, e.g. `250V310`. */
  windVarFromDeg: number | null;
  windVarToDeg: number | null;
  /** Sustained / average wind, knots. `0` is a real calm reading; `null` is "not measured". */
  windKt: number | null;
  gustKt: number | null;
  lullKt: number | null;

  /** Statute miles. METAR `10SM` and `P6SM` are recorded as their stated value. */
  visibilitySm: number | null;
  /**
   * Lowest broken, overcast or vertical-visibility layer, feet above ground.
   * `'none'` = the source reported the sky and there is no ceiling; `null` = not measured.
   */
  ceilingFtAgl: number | 'none' | null;
  clouds: WeatherCloudLayer[] | null;

  tempC: number | null;
  dewpointC: number | null;
  altimeterInHg: number | null;
  /** Any precipitation reported. `null` = not measured. */
  precipitation: boolean | null;

  /** The source's own text when it has one (the METAR), for "raw on tap". */
  raw: string | null;
  /** For `manual` sources: who typed it. */
  enteredBy?: string;
}

/**
 * Where one rule × one source stands. Mirrors SkyWeather's `LimitState`
 * (`skyweather/packages/weather-core/src/limits/types.ts`).
 *
 * `'unknown'` is where every pair starts: no reading yet. It is **not** "within": showing a limit as
 * fine with no evidence would be silence passing for calm. Nothing ever returns to `'unknown'`. Says
 * nothing about whether the source is reporting; that is `WeatherSourceHealth`.
 */
export type WeatherLimitState = 'unknown' | 'within' | 'approaching' | 'past';

/** Whether a source is reporting on time. Mirrors SkyWeather's `SourceHealthState`. Says nothing about any limit. */
export type WeatherSourceHealth = 'reporting' | 'late' | 'not_reporting';

/** What a limit rule measures. Mirrors SkyWeather's `LimitMetric`, whose spec (`limits-engine.md`) owns the list. */
export type WeatherLimitMetric =
  | 'windKt'
  | 'gustKt'
  | 'gustSpreadKt'
  | 'ceilingFtAgl'
  | 'visibilitySm'
  | 'tempC'
  | 'precipitation';

/**
 * Which side of the limit is the bad side. Mirrors SkyWeather's `LimitDirection`: wind, gust and gust
 * spread are `above`; ceiling and visibility `below`; temperature either. Precipitation ignores it.
 */
export type WeatherLimitDirection = 'above' | 'below';

/** A metric's value as the engine saw it. Mirrors SkyWeather's `LimitValue`: `'none'` = no ceiling; booleans for precipitation. */
export type WeatherLimitValue = number | boolean | 'none';

/**
 * One limit rule as the owner entered it, frozen at the moment it is reported. Field names follow
 * SkyWeather's `LimitRule` where they overlap.
 *
 * **Every number here was typed by the owner.** SkyWeather never pre-fills a limit (DEC-164), and a
 * consumer must never supply a default either.
 */
export interface WeatherLimitRuleSnapshot {
  ruleId: string;
  setId: string;
  /** The owner's name for the set: "Students", "Tandems". */
  setName: string;
  metric: WeatherLimitMetric;
  /** `null` for precipitation, which has no direction. */
  direction: WeatherLimitDirection | null;
  /** The owner's number in the metric's canonical unit (kt, ft AGL, statute miles, °C). `null` for precipitation. */
  limit: number | null;
  /** The canonical unit of `limit`: 'kt' | 'ft' | 'sm' | 'C', or `null` for precipitation. */
  unit: string | null;
  /** Exactly what the owner typed, for wording ("your limit of 20 mph"). */
  enteredValue: number | null;
  enteredUnit: string | null;
  approachMargin: number;
  backWithinMargin: number;
  minDurationS: number;
}

/** The newest reading from one source, with its health. One per source; never merged. */
export type WeatherSourceReading = SuiteProvenance & {
  siteId: string;
  descriptor: WeatherSourceDescriptor;
  /** The exact header to show above this reading: "Weather observations (<label>)". */
  header: string;
  health: WeatherSourceHealth;
  healthSince: UtcMs;
  /** `null` when the source has never reported within SkyWeather's hot window. Never a fabricated reading. */
  observation: WeatherObservation | null;
};

/** One rule × one source, right now. The limit state and the source's health sit side by side, never merged. */
export type WeatherLimitStatus = SuiteProvenance & {
  siteId: string;
  rule: WeatherLimitRuleSnapshot;
  sourceId: string;
  sourceLabel: string;
  state: WeatherLimitState;
  /** When `state` was entered; `null` while still `unknown`. */
  since: UtcMs | null;
  /** `past` with `not_reporting` means "past when last heard from, and not heard from since". */
  sourceHealth: WeatherSourceHealth;
  /** The metric's value at the last evidence, canonical units. */
  lastValue: WeatherLimitValue | null;
  lastEvidenceAt: UtcMs | null;
  /** Per rule × source, up by exactly 1 on every change. Discard anything not higher than what you hold. */
  sequence: number;
};

export type WeatherLimitEventType = 'limit.approaching' | 'limit.past' | 'limit.back_within';
export type WeatherSourceEventType = 'source.not_reporting' | 'source.reporting';
export type WeatherAlertEventType = WeatherLimitEventType | WeatherSourceEventType;

/** Fields every weather alert event carries. */
export interface WeatherAlertEventBase {
  /** Unique per event, and the same on every webhook retry: the idempotency key. */
  eventId: string;
  siteId: string;
  sourceId: string;
  sourceLabel: string;
  sourceKind: WeatherSourceKind;
  /** "Weather observations (<label>)". */
  header: string;
  /** `rule:<ruleId>:source:<sourceId>` or `source:<sourceId>`. Ordering holds only within one stream. */
  streamKey: string;
  /** Up by exactly 1 on every change in this stream. */
  sequence: number;
  occurredAt: UtcMs;
  /** The source's newest reading time at the moment of the event; for `source.not_reporting`, when it was last heard from. */
  lastObservedAt: UtcMs | null;
  /**
   * Whether people were told. Mirrors the engine's `notify`. `false`: recorded (and still sent to
   * webhooks), but outside operating hours, or not news (a limit's first state being `within`).
   */
  notify: boolean;
  /** The sentence SkyWeather showed and emailed. Names the source, the value and the owner's limit. */
  text: string;
}

/**
 * A rule × source arrived at a new limit state. **The type names the state arrived at**:
 * `limit.approaching` includes past → approaching ("back within your limit, still approaching it");
 * `limit.back_within` with `fromState: 'unknown'` is a pair's first state being within (recorded,
 * `notify: false`, and its text says "within", not "back within").
 */
export interface WeatherLimitAlertEvent extends WeatherAlertEventBase {
  type: WeatherLimitEventType;
  rule: WeatherLimitRuleSnapshot;
  fromState: WeatherLimitState;
  /** Never `unknown`: nothing moves back to it. */
  toState: Exclude<WeatherLimitState, 'unknown'>;
  value: WeatherLimitValue;
  /** The reading that caused the change, frozen in. */
  observation: WeatherObservation;
}

/**
 * A source went silent, or came back.
 *
 * **`source.not_reporting` changes no limit state.** A rule that was `past` stays `past` until a fresh
 * reading brings it back within. A source going `late` is shown on screens but is not an event.
 */
export interface WeatherSourceAlertEvent extends WeatherAlertEventBase {
  type: WeatherSourceEventType;
  rule: null;
  /** The limit sets with a rule watching this source; their recipients are the people told. */
  setIds: string[];
  fromState: WeatherSourceHealth;
  toState: WeatherSourceHealth;
  value: null;
  /** `null` for `source.not_reporting` (there is no reading; that is the point); the fresh reading for `source.reporting`. */
  observation: WeatherObservation | null;
}

/**
 * A limit or source change. **This is the webhook payload**, and what SkyWeather's
 * `GET /v1/sites/{siteId}/alert-events` returns. `source` (provenance) is `'weather'` for a real event and
 * `'mock'` for a fabricated one; never act on a mock event as if it were real.
 */
export type WeatherAlertEvent = SuiteProvenance & (WeatherLimitAlertEvent | WeatherSourceAlertEvent);

/** What a `WeatherAdapter` subscription delivers. */
export type WeatherAdapterEvent =
  | { kind: 'reading'; reading: WeatherSourceReading }
  | { kind: 'limit_state'; status: WeatherLimitStatus }
  | { kind: 'alert'; alert: WeatherAlertEvent }
  /** The live connection to SkyWeather dropped: show "Weather unavailable", not the last reading as current. */
  | { kind: 'unreachable'; at: UtcMs }
  /** The connection is back: re-read `getLatest` and `getLimitStates` (live updates have no replay). */
  | { kind: 'reachable'; at: UtcMs };

/**
 * What a consuming app (DZGO, SkyPerson, a website) holds to read weather for one SkyWeather site.
 *
 * `getLatest` and `getLimitStates` **throw `SiblingUnreachableError('weather')`** when SkyWeather cannot be
 * reached, and the consumer falls back to its native path. `subscribe` never throws; it emits
 * `unreachable` instead.
 */
export interface WeatherAdapter {
  readonly source: SuiteSource;
  readonly descriptor: SuiteAdapterDescriptor;
  /** The newest reading from each source on the site the caller may see, one item per source. */
  getLatest(siteId: string): Promise<WeatherSourceReading[]>;
  /** Every rule × source state on the site, each with its source's health beside it. */
  getLimitStates(siteId: string): Promise<WeatherLimitStatus[]>;
  subscribe(listener: (event: WeatherAdapterEvent) => void): Unsubscribe;
}

/**
 * The header every display of conditions sits under (DEC-164): `Weather observations (<label>)`.
 *
 * One function so every app words it identically. There is no disclaimer line (Kyle, 2026-10-01).
 */
export function weatherPanelHeader(sourceLabel: string): string {
  return `Weather observations (${sourceLabel})`;
}
