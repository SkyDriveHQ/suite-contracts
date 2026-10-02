/**
 * Mock `WeatherAdapter` — the SkyWeather → any app seam.
 *
 * SkyWeather is planned, not built. This generator lets DZGO's weather strip and alert banner, and
 * SkyPerson's pilot screen, be built against realistic readings, limit states and alert events before
 * any station is connected.
 *
 * **Trouble is fabricated on purpose**, because the branches that break in production are the null and
 * silent ones:
 * - the hangar anemometer measures no ceiling, visibility or clouds (`null`, not "clear");
 * - the airport report never has a lull, and drops its gust group in some hours (`null`, not `0`);
 * - the runway station **goes silent while it is past a limit**, and stays `past`: a silent source never
 *   clears an alert;
 * - some events happen outside operating hours (recorded, not notified);
 * - `setReachable(false)` makes the adapter throw `SiblingUnreachableError('weather')`, so a consumer can
 *   prove it shows "Weather unavailable" and invents nothing (Rule 13).
 *
 * **The limit numbers here are test data, not defaults.** SkyWeather never pre-fills a limit (DEC-164);
 * these stand in for numbers an owner typed, and are randomised per seed so no consumer can come to
 * depend on one.
 *
 * **The state machine here is a simplification for fabrication only.** It borrows the real engine's
 * lines (past above the limit, approaching from the limit minus the margin, the back-within margin
 * both ways), its starting `unknown` state and its rule that an airport report with no gust group
 * means gust = wind, but its minimum-duration handling is crude. The real rules are SkyWeather's
 * `limits-engine.md`; do not copy this one.
 *
 * All times are UTC epoch milliseconds, derived from the scenario's date, never from the clock, so a
 * seed reproduces a day exactly.
 */

import { SiblingUnreachableError, type MockGenerator } from '../common.js';
import type {
  Unsubscribe,
  UtcMs,
  WeatherAdapter,
  WeatherAdapterEvent,
  WeatherAlertEvent,
  WeatherLimitRuleSnapshot,
  WeatherLimitState,
  WeatherLimitStatus,
  WeatherLimitValue,
  WeatherObservation,
  WeatherSourceDescriptor,
  WeatherSourceHealth,
  WeatherSourceReading,
} from '../index.js';
import { weatherPanelHeader } from '../weather.js';
import type { Rng } from './rng.js';
import { MockScenario } from './scenario.js';

const MINUTE = 60_000;

export interface MockWeatherOptions {
  /** Minutes of history to fabricate, ending at `endHourUtc` on the scenario's date. Default 300. */
  minutes?: number;
  /** UTC hour the fabricated window ends. Default 18 (around midday across the continental US). */
  endHourUtc?: number;
  /** Operating hours, UTC hours [open, close). Events outside are recorded but not notified. Default [14, 26]. */
  operatingHoursUtc?: readonly [number, number];
}

type Metric = 'gustKt' | 'windKt';

interface RuleDef extends WeatherLimitRuleSnapshot {
  metric: Metric;
}

interface StreamState {
  state: WeatherLimitState;
  since: UtcMs | null;
  sequence: number;
  lastValue: WeatherLimitValue | null;
  lastEvidenceAt: UtcMs | null;
  /** A different state the readings point to, and since when; it takes over once it has held long enough. */
  pending: { state: WeatherLimitState; since: UtcMs } | null;
}

interface SourceState {
  descriptor: WeatherSourceDescriptor;
  health: WeatherSourceHealth;
  healthSince: UtcMs;
  healthSequence: number;
  observations: WeatherObservation[];
}

function utcDayStart(isoDate: string): UtcMs {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/** As the engine's default formatter: "14:05 UTC". */
function hhmmUtc(t: UtcMs): string {
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Wind direction 1–360, as airport reports write it: north is 360, never 0. */
function dir(deg: number): number {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return d === 0 ? 360 : d;
}

function emptyObs(sourceId: string, observedAt: UtcMs): WeatherObservation {
  return {
    sourceId,
    observedAt,
    windDirDeg: null,
    windVariable: false,
    windVarFromDeg: null,
    windVarToDeg: null,
    windKt: null,
    gustKt: null,
    lullKt: null,
    visibilitySm: null,
    ceilingFtAgl: null,
    clouds: null,
    tempC: null,
    dewpointC: null,
    altimeterInHg: null,
    precipitation: null,
    raw: null,
  };
}

/** One per-minute bridge summary: average wind, the minute's highest gust and lowest lull. */
function stationMinute(rng: Rng, sourceId: string, observedAt: UtcMs, meanKt: number, tempC: number): WeatherObservation {
  const windKt = rng.gaussian(meanKt, 2, 0, 40);
  return {
    ...emptyObs(sourceId, observedAt),
    windowS: 60,
    windDirDeg: windKt === 0 ? null : dir(270 + rng.int(-25, 25)),
    windKt,
    gustKt: windKt + rng.int(2, 9),
    lullKt: Math.max(0, windKt - rng.int(2, 6)),
    tempC: round1(tempC),
    dewpointC: 4.9,
    altimeterInHg: 30.02,
    precipitation: false,
  };
}

/** An hourly airport report for the placeholder airport KXYZ. Never a lull; the gust group comes and goes. */
function airportReport(rng: Rng, sourceId: string, observedAt: UtcMs): WeatherObservation {
  const windKt = rng.int(6, 16);
  const gustKt = rng.chance(0.5) ? windKt + rng.int(10, 14) : null;
  const windDirDeg = dir(Math.round((270 + rng.int(-30, 30)) / 10) * 10);
  const broken = rng.chance(0.6);
  const clouds = broken
    ? [
        { cover: 'FEW' as const, baseFtAgl: 4500 },
        { cover: 'BKN' as const, baseFtAgl: rng.pick([6000, 8000, 10000]) },
      ]
    : [{ cover: 'SCT' as const, baseFtAgl: 5000 }];
  const ceiling = clouds.find((c) => c.cover === 'BKN');
  const tempC = rng.int(14, 24);
  const d = new Date(observedAt);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const sky = clouds.map((c) => `${c.cover}${p(c.baseFtAgl / 100, 3)}`).join(' ');
  const raw =
    `KXYZ ${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z ` +
    `${p(windDirDeg, 3)}${p(windKt)}${gustKt === null ? '' : `G${p(gustKt)}`}KT 10SM ${sky} ${p(tempC)}/05 A3002 RMK MOCK`;
  return {
    ...emptyObs(sourceId, observedAt),
    windDirDeg,
    windKt,
    gustKt,
    visibilitySm: 10,
    ceilingFtAgl: ceiling ? ceiling.baseFtAgl : 'none',
    clouds,
    tempC,
    dewpointC: 5,
    altimeterInHg: 30.02,
    precipitation: false,
    raw,
  };
}

/** A fabricated SkyWeather site behind the real adapter interface. */
export class MockWeather implements WeatherAdapter {
  readonly source = 'mock' as const;
  readonly descriptor = {
    label: 'Mock weather (SkyWeather stand-in)',
    speaks: 'weather' as const,
    isMock: true,
  };

  readonly siteId: string;
  private readonly sources = new Map<string, SourceState>();
  private readonly rules: RuleDef[] = [];
  private readonly streams = new Map<string, StreamState>();
  private readonly events: WeatherAlertEvent[] = [];
  private readonly listeners = new Set<(event: WeatherAdapterEvent) => void>();
  private readonly operatingHours: readonly [number, number];
  private reachable = true;
  private eventCount = 0;

  constructor(
    readonly scenario: MockScenario = new MockScenario(),
    options: MockWeatherOptions = {},
  ) {
    const minutes = options.minutes ?? 300;
    const endAt = utcDayStart(scenario.activityDate) + (options.endHourUtc ?? 18) * 60 * MINUTE;
    const startAt = endAt - minutes * MINUTE;
    this.operatingHours = options.operatingHoursUtc ?? [14, 26];
    this.siteId = scenario.id('wx-site', 1);

    const airport = this.addSource(1, { kind: 'noaa-metar', label: 'KXYZ airport report', expectedIntervalS: 3600 }, startAt);
    const anemometer = this.addSource(
      2,
      { kind: 'davis-local', label: 'Hangar anemometer (mock)', sensorHeightM: 10, expectedIntervalS: 60 },
      startAt,
    );
    const runway = this.addSource(3, { kind: 'push-ecowitt', label: 'Runway station (mock)', expectedIntervalS: 60 }, startAt);

    // Stand-ins for numbers an owner typed. Never defaults; see the header.
    const lr = scenario.streamFor('weather-limits');
    this.addRule(lr, 1, 'Students', 'gustKt', lr.int(18, 22), 3, 2);
    this.addRule(lr, 2, 'Students', 'windKt', lr.int(12, 15), 2, 2);
    this.addRule(lr, 3, 'Licensed', 'gustKt', lr.int(25, 28), 3, 2);

    // Fabricate the readings, then feed them through in observed order, as SkyWeather would.
    const all: WeatherObservation[] = [];

    const ar = scenario.streamFor('weather-airport');
    for (let t = startAt - (startAt % (60 * MINUTE)) + 53 * MINUTE; t <= endAt; t += 60 * MINUTE) {
      if (t >= startAt) all.push(airportReport(ar, airport, t));
    }

    // The anemometer: a calm morning, a gusty spell in the middle third, easing after.
    const an = scenario.streamFor('weather-anemometer');
    for (let i = 1; i <= minutes; i += 1) {
      const f = i / minutes;
      const mean = f > 0.35 && f < 0.65 ? 17 : 8;
      all.push(stationMinute(an, anemometer, startAt + i * MINUTE, mean, 16 + 6 * f));
    }

    // The runway station: gusts climbing past every limit, then silence 45 minutes before the end.
    const rw = scenario.streamFor('weather-runway');
    const silentFrom = endAt - 45 * MINUTE;
    for (let i = 1; startAt + i * MINUTE < silentFrom; i += 1) {
      const t = startAt + i * MINUTE;
      const obs = stationMinute(rw, runway, t, 10, 17);
      if (silentFrom - t <= 15 * MINUTE) obs.gustKt = 30 + rw.int(0, 4);
      all.push(obs);
    }

    all.sort((a, b) => a.observedAt - b.observedAt);
    for (const obs of all) this.process(obs, false);

    // Silence is "not reporting" at three expected intervals (the engine's default); it changes no limit state.
    this.declareNotReporting(runway, this.silentAt(runway, startAt), false);
  }

  // ── WeatherAdapter ────────────────────────────────────────────────────────

  async getLatest(siteId: string): Promise<WeatherSourceReading[]> {
    this.assertReachable();
    if (siteId !== this.siteId) return [];
    return [...this.sources.values()].map((s) => ({
      ...this.scenario.provenance(),
      siteId: this.siteId,
      descriptor: { ...s.descriptor },
      header: weatherPanelHeader(s.descriptor.label),
      health: s.health,
      healthSince: s.healthSince,
      observation: s.observations.at(-1) ?? null,
    }));
  }

  async getLimitStates(siteId: string): Promise<WeatherLimitStatus[]> {
    this.assertReachable();
    if (siteId !== this.siteId) return [];
    return this.statuses(this.scenario.generator).map((s) => s.status);
  }

  subscribe(listener: (event: WeatherAdapterEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Read-outs for tests and test panels (not on the adapter interface) ───

  /** Every fabricated reading from one source, oldest first. */
  observations(sourceId: string): WeatherObservation[] {
    return [...(this.sources.get(sourceId)?.observations ?? [])];
  }

  /** Every alert event, in the order it happened. */
  alertEvents(): WeatherAlertEvent[] {
    return [...this.events];
  }

  sourceIds(): string[] {
    return [...this.sources.keys()];
  }

  // ── Injectors ─────────────────────────────────────────────────────────────

  /**
   * Simulate SkyWeather being down or back. While down, `getLatest` and `getLimitStates` throw
   * `SiblingUnreachableError('weather')` and subscribers get `unreachable`.
   */
  setReachable(reachable: boolean): void {
    if (this.reachable === reachable) return;
    this.reachable = reachable;
    const at = this.latestTime();
    this.emit(reachable ? { kind: 'reachable', at } : { kind: 'unreachable', at });
  }

  /**
   * Deliver a new reading from a source, one minute after its last, with the given values.
   * A silent source that reports again emits `source.reporting`; limits move only on the evidence.
   */
  deliverReading(sourceId: string, values: Partial<Omit<WeatherObservation, 'sourceId' | 'observedAt'>> = {}): WeatherObservation {
    const src = this.sources.get(sourceId);
    if (!src) throw new Error(`no mock source ${sourceId}`);
    const last = src.observations.at(-1)?.observedAt ?? this.latestTime();
    const obs: WeatherObservation = { ...emptyObs(sourceId, last + MINUTE), ...values };
    this.process(obs, true);
    return obs;
  }

  /** Make a source go silent now. Emits `source.not_reporting`; changes no limit state. */
  goSilent(sourceId: string): void {
    this.declareNotReporting(sourceId, this.silentAt(sourceId, this.latestTime()), true);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private addSource(n: number, d: Omit<WeatherSourceDescriptor, 'id' | 'siteId'>, startAt: UtcMs): string {
    const id = this.scenario.id('wx-source', n);
    this.sources.set(id, {
      descriptor: { id, siteId: this.siteId, ...d },
      health: 'reporting',
      healthSince: startAt,
      healthSequence: 0,
      observations: [],
    });
    return id;
  }

  private addRule(rng: Rng, n: number, setName: string, metric: Metric, limit: number, approach: number, backWithin: number): void {
    const setN = setName === 'Students' ? 1 : 2;
    this.rules.push({
      ruleId: this.scenario.id('wx-rule', n),
      setId: this.scenario.id('wx-limitset', setN),
      setName,
      metric,
      direction: 'above',
      limit,
      unit: 'kt',
      enteredValue: limit,
      enteredUnit: 'kt',
      approachMargin: approach,
      backWithinMargin: backWithin,
      minDurationS: rng.pick([120, 180, 300]),
    });
  }

  private snapshot(rule: RuleDef): WeatherLimitRuleSnapshot {
    return { ...rule };
  }

  /** When a source counts as not reporting: three expected intervals after it was last heard from. */
  private silentAt(sourceId: string, fallback: UtcMs): UtcMs {
    const src = this.sources.get(sourceId)!;
    return (src.observations.at(-1)?.observedAt ?? fallback) + 3 * src.descriptor.expectedIntervalS * 1000;
  }

  private streamKey(ruleId: string, sourceId: string): string {
    return `rule:${ruleId}:source:${sourceId}`;
  }

  private latestTime(): UtcMs {
    let t = 0;
    for (const s of this.sources.values()) t = Math.max(t, s.observations.at(-1)?.observedAt ?? 0, s.healthSince);
    return t;
  }

  private assertReachable(): void {
    if (!this.reachable) throw new SiblingUnreachableError('weather');
  }

  private emit(event: WeatherAdapterEvent): void {
    for (const l of this.listeners) l(event);
  }

  private withinHours(t: UtcMs): boolean {
    const h = new Date(t).getUTCHours();
    const [open, close] = this.operatingHours;
    return (h >= open && h < close) || (h + 24 >= open && h + 24 < close);
  }

  private nextEventId(): string {
    this.eventCount += 1;
    return this.scenario.id('wx-event', this.eventCount);
  }

  /** The simplified mock state machine, on the engine's lines. Not the real engine; see the header. */
  private classify(rule: RuleDef, value: number, current: WeatherLimitState): WeatherLimitState {
    const limit = rule.limit ?? Infinity;
    const approach = rule.approachMargin;
    const back = rule.backWithinMargin;
    if (value > limit) return 'past';
    if (current === 'past' && value > limit - back) return 'past';
    if (value >= limit - approach) return 'approaching';
    if (current === 'approaching' && value >= limit - approach - back) return 'approaching';
    return 'within';
  }

  /** The metric from one reading. An airport report with wind but no gust group means "no gust": gust = wind. */
  private metricValue(rule: RuleDef, obs: WeatherObservation, src: SourceState): number | null {
    if (rule.metric === 'windKt') return obs.windKt;
    const reportFormat = src.descriptor.kind === 'noaa-metar' || src.descriptor.kind === 'awos-bridge';
    return obs.gustKt ?? (reportFormat ? obs.windKt : null);
  }

  private process(obs: WeatherObservation, live: boolean): void {
    const src = this.sources.get(obs.sourceId)!;
    src.observations.push(obs);

    if (src.health === 'not_reporting') this.changeHealth(obs.sourceId, 'reporting', obs.observedAt, obs, live);

    if (live) {
      this.emit({
        kind: 'reading',
        reading: {
          ...this.scenario.provenance('injector'),
          siteId: this.siteId,
          descriptor: { ...src.descriptor },
          header: weatherPanelHeader(src.descriptor.label),
          health: src.health,
          healthSince: src.healthSince,
          observation: obs,
        },
      });
    }

    for (const rule of this.rules) {
      const value = this.metricValue(rule, obs, src);
      // `null` is no evidence: the state stays where it was, whatever it was.
      if (value === null) continue;
      const key = this.streamKey(rule.ruleId, obs.sourceId);
      let st = this.streams.get(key);
      if (!st) {
        st = { state: 'unknown', since: null, sequence: 0, lastValue: null, lastEvidenceAt: null, pending: null };
        this.streams.set(key, st);
      }
      st.lastValue = value;
      st.lastEvidenceAt = obs.observedAt;
      const next = this.classify(rule, value, st.state);
      if (next === st.state) {
        st.pending = null;
        continue;
      }
      if (st.pending?.state !== next) st.pending = { state: next, since: obs.observedAt };
      if (obs.observedAt - st.pending.since < rule.minDurationS * 1000) continue;
      st.pending = null;

      const from = st.state;
      st.state = next;
      st.since = obs.observedAt;
      st.sequence += 1;
      const type = next === 'past' ? 'limit.past' : next === 'approaching' ? 'limit.approaching' : 'limit.back_within';
      const label = rule.metric === 'gustKt' ? 'Gusts' : 'Wind';
      const lim = `your ${rule.setName} limit of ${rule.enteredValue} ${rule.enteredUnit}`;
      const head = `${label} ${value} kt (${src.descriptor.label})`;
      const text =
        next === 'past'
          ? `${head}: past ${lim}.`
          : next === 'approaching'
            ? from === 'past'
              ? `${head}: back within ${lim}, still approaching it.`
              : `${head}: approaching ${lim}.`
            : from === 'unknown'
              ? `${head}: within ${lim}.`
              : `${head}: back within ${lim}.`;
      const event: WeatherAlertEvent = {
        ...this.scenario.provenance(live ? 'injector' : this.scenario.generator),
        eventId: this.nextEventId(),
        type,
        siteId: this.siteId,
        sourceId: obs.sourceId,
        sourceLabel: src.descriptor.label,
        sourceKind: src.descriptor.kind,
        header: weatherPanelHeader(src.descriptor.label),
        streamKey: key,
        sequence: st.sequence,
        occurredAt: obs.observedAt,
        lastObservedAt: obs.observedAt,
        // A pair's first state being within is not news; everything is recorded either way.
        notify: this.withinHours(obs.observedAt) && !(from === 'unknown' && next === 'within'),
        rule: this.snapshot(rule),
        fromState: from,
        toState: next as Exclude<WeatherLimitState, 'unknown'>,
        value,
        observation: obs,
        text,
      };
      this.events.push(event);
      if (live) {
        this.emit({ kind: 'alert', alert: event });
        const status = this.statuses('injector').find((s) => s.streamKey === key);
        if (status) this.emit({ kind: 'limit_state', status: status.status });
      }
    }
  }

  /** Every rule × source pair. A pair with no evidence yet is `unknown`, never "within". */
  private statuses(generator: MockGenerator): { streamKey: string; status: WeatherLimitStatus }[] {
    const out: { streamKey: string; status: WeatherLimitStatus }[] = [];
    for (const rule of this.rules) {
      for (const [sourceId, src] of this.sources) {
        const key = this.streamKey(rule.ruleId, sourceId);
        const st: StreamState = this.streams.get(key) ?? {
          state: 'unknown',
          since: null,
          sequence: 0,
          lastValue: null,
          lastEvidenceAt: null,
          pending: null,
        };
        out.push({
          streamKey: key,
          status: {
            ...this.scenario.provenance(generator),
            siteId: this.siteId,
            rule: this.snapshot(rule),
            sourceId,
            sourceLabel: src.descriptor.label,
            state: st.state,
            since: st.since,
            sourceHealth: src.health,
            lastValue: st.lastValue,
            lastEvidenceAt: st.lastEvidenceAt,
            sequence: st.sequence,
          },
        });
      }
    }
    return out;
  }

  private declareNotReporting(sourceId: string, at: UtcMs, live: boolean): void {
    this.changeHealth(sourceId, 'not_reporting', at, null, live);
  }

  private changeHealth(sourceId: string, to: WeatherSourceHealth, at: UtcMs, obs: WeatherObservation | null, live: boolean): void {
    const src = this.sources.get(sourceId)!;
    if (src.health === to) return;
    const from = src.health;
    src.health = to;
    src.healthSince = at;
    src.healthSequence += 1;
    const lastObservedAt = obs?.observedAt ?? src.observations.at(-1)?.observedAt ?? null;
    const setIds = [...new Set(this.rules.map((r) => r.setId))];
    const setNames = [...new Set(this.rules.map((r) => r.setName))];
    const since = lastObservedAt === null ? 'has not sent a reading yet' : `has not reported since ${hhmmUtc(lastObservedAt)}`;
    const text =
      to === 'not_reporting'
        ? `${src.descriptor.label} ${since}. Your ${setNames.join(' and ')} alerts stay as they were until it does.`
        : `${src.descriptor.label} is reporting again.`;
    const event: WeatherAlertEvent = {
      ...this.scenario.provenance(live ? 'injector' : this.scenario.generator),
      eventId: this.nextEventId(),
      type: to === 'not_reporting' ? 'source.not_reporting' : 'source.reporting',
      siteId: this.siteId,
      sourceId,
      sourceLabel: src.descriptor.label,
      sourceKind: src.descriptor.kind,
      header: weatherPanelHeader(src.descriptor.label),
      streamKey: `source:${sourceId}`,
      sequence: src.healthSequence,
      occurredAt: at,
      lastObservedAt,
      notify: this.withinHours(at),
      rule: null,
      setIds,
      fromState: from,
      toState: to,
      value: null,
      observation: to === 'not_reporting' ? null : obs,
      text,
    };
    this.events.push(event);
    if (live) this.emit({ kind: 'alert', alert: event });
  }
}

export function mockWeather(scenario?: MockScenario, options?: MockWeatherOptions): MockWeather {
  return new MockWeather(scenario, options);
}
