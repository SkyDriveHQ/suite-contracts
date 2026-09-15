/**
 * Mock `JumpContextSource` — the DZGO → SkyVideo seam.
 *
 * SkyVideo shipped `emptyJumpContextSource` (rung 4) and nothing else. Rungs
 * 1–3 had no implementation of any kind, which meant the degradation ladder —
 * the single most important design decision in SkyVideo's architecture — had
 * never been exercised below the top. **This file is what lets SkyVideo test
 * its own ladder before DZGO exposes a manifest API.**
 *
 * The rungs are fabricated from **one** underlying day, then progressively
 * degraded. That is the point: rung 2 is not "different data", it is the same
 * jumps known less well. Generating each rung independently would produce a
 * test that passes while the real degradation path is broken.
 */

import type {
  ISODate,
  JumpContext,
  JumpContextRung,
  JumpContextSource,
  JumpSlot,
  LoadRef,
  PersonRef,
} from '../index.js';
import { MockScenario } from './scenario.js';
import { mockName } from './rng.js';

export interface MockJumpDayOptions {
  /** Loads to fabricate for the day. Default 4 — a small dropzone's Saturday. */
  loads?: number;
  /** Tandem pairs per load. Default 2. */
  tandemsPerLoad?: number;
  /** Solo jumpers per load. Default 6. */
  solosPerLoad?: number;
}

const AIRCRAFT = ['N182TD (Cessna 182)', 'N206XP (Caravan)', 'N99KA (King Air)'] as const;

/**
 * Builds the day once, at full fidelity.
 *
 * Every rung is derived from this, so the same jump keeps the same `jumpId`
 * however little is known about it — which is exactly the property a consumer
 * needs when a dropzone's connection drops mid-day and the source falls from
 * rung 1 to rung 2 underneath it.
 */
function buildDay(scenario: MockScenario, options: MockJumpDayOptions): JumpContext[] {
  const loadCount = options.loads ?? 4;
  const tandems = options.tandemsPerLoad ?? 2;
  const solos = options.solosPerLoad ?? 6;
  const rng = scenario.streamFor('jump-context');
  const out: JumpContext[] = [];
  let jumpN = 0;

  for (let l = 0; l < loadCount; l += 1) {
    // Loads roughly every 45 minutes from 09:00. A real day is lumpier, but a
    // predictable cadence is what makes `findByInstant` testable.
    const hour = 9 + Math.floor((l * 45) / 60);
    const minute = (l * 45) % 60;
    const departedAt = `${scenario.activityDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
    const load: LoadRef = {
      id: scenario.id('load', l + 1),
      number: l + 1,
      departedAt,
      aircraft: rng.pick(AIRCRAFT),
    };

    const person = (kind: string): PersonRef => {
      const n = mockName(rng);
      jumpN += 1;
      return {
        id: scenario.id(kind, jumpN),
        displayName: `${n.first} ${n.last}`,
        givenName: n.first,
        familyName: n.last,
      };
    };

    for (let t = 0; t < tandems; t += 1) {
      const seq = out.length + 1;
      const pairId = scenario.id('pair', seq);
      const slots: JumpSlot[] = [
        { slotId: scenario.id('slot', seq * 10), role: 'tandem-student', person: person('student'), pairId },
        { slotId: scenario.id('slot', seq * 10 + 1), role: 'tandem-instructor', person: person('ti'), pairId },
      ];
      // Not every tandem is filmed. A source that always had a videographer
      // would hide the "no video slot" branch from every consumer test.
      if (rng.chance(0.6)) {
        slots.push({ slotId: scenario.id('slot', seq * 10 + 2), role: 'videographer', person: person('vid'), pairId });
      }
      out.push({
        jumpId: scenario.id('jump', seq),
        source: { rung: 1, label: 'Mock DZGO manifest', retrievedAt: new Date().toISOString(), refreshable: true },
        load,
        slots,
        externalRef: `MOCK-${load.number}-${t + 1}`,
        operatingDay: scenario.activityDate,
      });
    }

    for (let s = 0; s < solos; s += 1) {
      const seq = out.length + 1;
      out.push({
        jumpId: scenario.id('jump', seq),
        source: { rung: 1, label: 'Mock DZGO manifest', retrievedAt: new Date().toISOString(), refreshable: true },
        load,
        slots: [{ slotId: scenario.id('slot', seq * 10), role: 'solo', person: person('jumper') }],
        operatingDay: scenario.activityDate,
      });
    }
  }
  return out;
}

const RUNG_INFO: Record<JumpContextRung, { label: string; refreshable: boolean }> = {
  1: { label: 'Mock DZGO manifest (live)', refreshable: true },
  2: { label: 'Mock manifest CSV export', refreshable: false },
  3: { label: 'Camera timestamps only', refreshable: false },
  4: { label: 'No manifest — detection only', refreshable: false },
};

/** Strips a full-fidelity day down to what a given rung actually knows. */
function degrade(jumps: readonly JumpContext[], rung: JumpContextRung): JumpContext[] {
  const retrievedAt = new Date().toISOString();
  const info = RUNG_INFO[rung];

  return jumps.map((j) => {
    const source = { rung, label: info.label, retrievedAt, refreshable: info.refreshable };
    if (rung === 1) return { ...j, source };

    // A CSV export has names but no live state: no aircraft, and the departure
    // time is whatever was true when it was exported.
    const flatLoad: LoadRef | undefined = j.load
      ? { id: j.load.id, number: j.load.number, ...(j.load.departedAt ? { departedAt: j.load.departedAt } : {}) }
      : undefined;

    if (rung === 2) {
      return { ...j, source, ...(flatLoad ? { load: flatLoad } : {}) };
    }

    // Rung 3: the camera knows a jump happened and roughly when. It knows
    // nothing about who. Slots survive **without people** rather than being
    // emptied, because the count of bodies on a jump is still real information.
    const stripped: JumpContext = {
      jumpId: j.jumpId,
      source,
      slots: j.slots.map((s) => ({ slotId: s.slotId, role: 'unknown' as const })),
      ...(flatLoad ? { load: flatLoad } : {}),
      ...(j.operatingDay ? { operatingDay: j.operatingDay } : {}),
    };
    return stripped;
  });
}

/**
 * A fabricated `JumpContextSource` at the rung you ask for.
 *
 * Pass the same `scenario` to two calls at different rungs to get the same day
 * known two different ways — which is how a consumer tests that falling down
 * the ladder does not lose track of a jump.
 */
export function mockJumpContextSource(
  rung: JumpContextRung,
  scenario: MockScenario = new MockScenario(),
  options: MockJumpDayOptions = {},
): JumpContextSource {
  const full = buildDay(scenario, options);
  const jumps = rung === 4 ? [] : degrade(full, rung);

  return {
    rung,
    label: RUNG_INFO[rung].label,

    async listForDay(operatingDay: ISODate) {
      return jumps.filter((j) => j.operatingDay === undefined || j.operatingDay === operatingDay);
    },

    async findByInstant(instant: string) {
      // Rung 3 has timestamps and nothing else, so this is the one lookup it
      // can still answer — and the reason the rung exists at all.
      const t = Date.parse(instant);
      if (Number.isNaN(t)) return undefined;
      let best: JumpContext | undefined;
      let bestGap = Number.POSITIVE_INFINITY;
      for (const j of jumps) {
        const dep = j.load?.departedAt;
        if (!dep) continue;
        const gap = Math.abs(Date.parse(dep) - t);
        if (gap < bestGap) {
          bestGap = gap;
          best = j;
        }
      }
      // Half an hour either side of a departure: wider than a jump, narrower
      // than the gap between loads.
      return bestGap <= 30 * 60 * 1000 ? best : undefined;
    },
  };
}

/** All four rungs over one fabricated day, for testing the ladder end to end. */
export function mockJumpContextLadder(
  scenario: MockScenario = new MockScenario(),
  options: MockJumpDayOptions = {},
): Record<JumpContextRung, JumpContextSource> {
  return {
    1: mockJumpContextSource(1, scenario, options),
    2: mockJumpContextSource(2, scenario, options),
    3: mockJumpContextSource(3, scenario, options),
    4: mockJumpContextSource(4, scenario, options),
  };
}
