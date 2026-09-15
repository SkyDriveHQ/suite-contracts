/**
 * What these tests are for.
 *
 * Not "does the generator run" — that a build catches. These assert the
 * properties a consumer will actually rely on and that a plausible-looking
 * generator can silently get wrong: that a seed reproduces a day, that the
 * degradation ladder loses fidelity without losing jumps, that the queue
 * arithmetic adds up, and that an Ops event cannot carry a person.
 */

import { describe, expect, it } from 'vitest';
import {
  assertNonIdentifying,
  MockScenario,
  mockInstructorRoster,
  mockJumpContextLadder,
  mockJumpContextSource,
  mockOpsEventStream,
  mockPackingDay,
  mockPilotReports,
  mockRigService,
  SUITE_MOCK_SENTINEL,
} from '../src/mocks/index.js';
import { flightHours, latestReservePack, uncompliedBulletins } from '../src/index.js';

const DAY = '2026-09-14';

describe('scenario provenance', () => {
  it('stamps every record as mock, with the scenario that made it', () => {
    const scenario = new MockScenario({ seed: 42, activityDate: DAY });
    const p = scenario.provenance();
    expect(p.source).toBe('mock');
    expect(p.mock?.scenarioId).toBe(scenario.scenarioId);
    expect(p.mock?.seed).toBe(42);
  });

  it('exposes the sentinel the isolation check greps for', () => {
    expect(new MockScenario({ seed: 1 }).sentinel).toBe(SUITE_MOCK_SENTINEL);
    // A literal, never assembled at runtime — see rng.ts.
    expect(SUITE_MOCK_SENTINEL).toBe('skydrive-suite-contracts-mock-runtime');
  });

  it('reproduces the same day from the same seed', async () => {
    const a = await mockInstructorRoster(new MockScenario({ seed: 7, activityDate: DAY })).getRoster(DAY);
    const b = await mockInstructorRoster(new MockScenario({ seed: 7, activityDate: DAY })).getRoster(DAY);
    expect(a.map((i) => i.name.last)).toEqual(b.map((i) => i.name.last));
  });

  it('produces a different day from a different seed', async () => {
    const a = await mockInstructorRoster(new MockScenario({ seed: 7, activityDate: DAY })).getRoster(DAY);
    const b = await mockInstructorRoster(new MockScenario({ seed: 8, activityDate: DAY })).getRoster(DAY);
    expect(a.map((i) => i.id)).not.toEqual(b.map((i) => i.id));
  });
});

describe('JumpContext degradation ladder', () => {
  it('keeps the same jumps at every rung above 4', async () => {
    const scenario = new MockScenario({ seed: 11, activityDate: DAY });
    const ladder = mockJumpContextLadder(scenario, { loads: 3 });
    const ids = await Promise.all([1, 2, 3].map(async (r) => {
      const jumps = await ladder[r as 1 | 2 | 3].listForDay(DAY);
      return jumps.map((j) => j.jumpId);
    }));
    // The whole point of the ladder: less is known, not fewer jumps.
    expect(ids[1]).toEqual(ids[0]);
    expect(ids[2]).toEqual(ids[0]);
    expect(ids[0]!.length).toBeGreaterThan(0);
  });

  it('loses identities at rung 3 but keeps the body count', async () => {
    const scenario = new MockScenario({ seed: 11, activityDate: DAY });
    const rung1 = await mockJumpContextSource(1, scenario, { loads: 2 }).listForDay(DAY);
    const rung3 = await mockJumpContextSource(3, scenario, { loads: 2 }).listForDay(DAY);

    expect(rung1.some((j) => j.slots.some((s) => s.person !== undefined))).toBe(true);
    expect(rung3.every((j) => j.slots.every((s) => s.person === undefined))).toBe(true);
    expect(rung3[0]!.slots.length).toBe(rung1[0]!.slots.length);
  });

  it('drops the aircraft below rung 1, because a CSV export does not carry live state', async () => {
    const scenario = new MockScenario({ seed: 3, activityDate: DAY });
    const rung1 = await mockJumpContextSource(1, scenario, { loads: 2 }).listForDay(DAY);
    const rung2 = await mockJumpContextSource(2, scenario, { loads: 2 }).listForDay(DAY);
    expect(rung1[0]!.load?.aircraft).toBeDefined();
    expect(rung2[0]!.load?.aircraft).toBeUndefined();
  });

  it('rung 4 is empty and still a valid source', async () => {
    const ladder = mockJumpContextLadder(new MockScenario({ seed: 5, activityDate: DAY }));
    expect(await ladder[4].listForDay(DAY)).toEqual([]);
    expect(ladder[4].rung).toBe(4);
  });

  it('finds a jump by instant — the join rung 3 exists for', async () => {
    const scenario = new MockScenario({ seed: 9, activityDate: DAY });
    const source = mockJumpContextSource(3, scenario, { loads: 3 });
    const jumps = await source.listForDay(DAY);
    const departedAt = jumps[0]!.load!.departedAt!;
    const found = await source.findByInstant!(departedAt);
    expect(found?.load?.number).toBe(jumps[0]!.load!.number);
  });

  it('returns nothing for an instant nowhere near a load', async () => {
    const source = mockJumpContextSource(1, new MockScenario({ seed: 9, activityDate: DAY }));
    expect(await source.findByInstant!(`${DAY}T23:59:00`)).toBeUndefined();
  });
});

describe('instructor roster', () => {
  it('exercises both the checked-in and not-checked-in branches', async () => {
    const roster = mockInstructorRoster(new MockScenario({ seed: 21, activityDate: DAY }), { count: 30 });
    const all = await roster.getRoster(DAY);
    expect(all.some((i) => i.checkedInAt !== null)).toBe(true);
    expect(all.some((i) => i.checkedInAt === null)).toBe(true);
  });

  it('carries the lighter-day request as a boolean and nothing richer (DEC-095)', async () => {
    const roster = mockInstructorRoster(new MockScenario({ seed: 22, activityDate: DAY }), { count: 20 });
    for (const i of await roster.getRoster(DAY)) {
      expect(typeof i.lighterDayRequested).toBe('boolean');
      // No level, no reason, ever — the point of the narrow type.
      expect(i).not.toHaveProperty('lighterDayLevel');
      expect(i).not.toHaveProperty('lighterDayReason');
    }
  });

  it('notifies subscribers when someone checks in', async () => {
    const roster = mockInstructorRoster(new MockScenario({ seed: 23, activityDate: DAY }), { count: 5 });
    const seen: string[] = [];
    roster.subscribe((e) => seen.push(e.type));
    const [first] = await roster.getRoster(DAY);
    roster.checkIn(first!.id);
    expect(seen).toContain('instructor.checked_in');
  });

  it('gives non-tandem staff a null weight limit rather than zero', async () => {
    const roster = mockInstructorRoster(new MockScenario({ seed: 24, activityDate: DAY }), { count: 25 });
    for (const i of await roster.getRoster(DAY)) {
      if (!i.ratings.includes('tandem')) expect(i.tandemWeightLimitLbs).toBeNull();
    }
  });
});

describe('rig service records', () => {
  it('always fabricates some trouble, or a consumer never renders it', async () => {
    const rigs = mockRigService(new MockScenario({ seed: 31, activityDate: DAY }), { count: 40 });
    const all = await rigs.getForRigs(rigs.scanCodes());
    expect(all.some((r) => uncompliedBulletins(r).length > 0)).toBe(true);
    expect(all.some((r) => latestReservePack(r)!.dueOn < DAY)).toBe(true);
  });

  it('has no airworthiness verdict anywhere on the record (DEC-024)', async () => {
    const rigs = mockRigService(new MockScenario({ seed: 32, activityDate: DAY }), { count: 5 });
    for (const r of await rigs.getForRigs(rigs.scanCodes())) {
      expect(r).not.toHaveProperty('airworthy');
      expect(r).not.toHaveProperty('grounded');
    }
  });

  it('puts the newest reserve pack first', () => {
    const rigs = mockRigService(new MockScenario({ seed: 33, activityDate: DAY }), { count: 3 });
    const code = rigs.scanCodes()[0]!;
    const updated = rigs.recordReservePack(code, DAY, 'Ada Testerson')!;
    expect(latestReservePack(updated)!.packedOn).toBe(DAY);
  });

  it('marks fabricated rigger certificates so they cannot pass for real ones', async () => {
    const rigs = mockRigService(new MockScenario({ seed: 34, activityDate: DAY }), { count: 6 });
    for (const r of await rigs.getForRigs(rigs.scanCodes())) {
      expect(latestReservePack(r)!.riggerCertificate).toMatch(/^MOCK-/);
    }
  });
});

describe('pilot reports', () => {
  it('delivers reports out of recorded order, because offline filing does (DEC-093)', async () => {
    const pilots = mockPilotReports(new MockScenario({ seed: 41, activityDate: DAY }), { flights: 12, offlineRate: 1 });
    const reports = await pilots.getFlightReports(DAY);
    const arrivalOrder = reports.map((r) => r.recordedAt);
    const recordedOrder = [...arrivalOrder].sort();
    // If these matched, a consumer sorting by arrival would look correct.
    expect(arrivalOrder).not.toEqual(recordedOrder);
  });

  it('always has receivedAt at or after recordedAt', async () => {
    const pilots = mockPilotReports(new MockScenario({ seed: 42, activityDate: DAY }), { flights: 10 });
    for (const r of await pilots.getFlightReports(DAY)) {
      expect(r.receivedAt >= r.recordedAt).toBe(true);
    }
  });

  it('runs the Hobbs meter forward across a day rather than randomising it', async () => {
    const pilots = mockPilotReports(new MockScenario({ seed: 43, activityDate: DAY }), { flights: 10, tails: ['N182TD'] });
    const reports = (await pilots.getFlightReports(DAY)).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    for (let i = 1; i < reports.length; i += 1) {
      expect(reports[i]!.engineTime!.start).toBeGreaterThanOrEqual(reports[i - 1]!.engineTime!.end!);
    }
  });

  it('computes flight hours, and returns undefined while a flight is open', () => {
    expect(flightHours({ kind: 'hobbs', start: 100, end: 100.4 })).toBe(0.4);
    expect(flightHours({ kind: 'hobbs', start: 100 })).toBeUndefined();
  });

  it('carries no computed spot suggestion (DEC-094)', async () => {
    const pilots = mockPilotReports(new MockScenario({ seed: 44, activityDate: DAY }));
    for (const w of await pilots.getWindObservations(DAY)) {
      expect(w).not.toHaveProperty('suggestedSpot');
      expect(w).not.toHaveProperty('spot');
    }
  });
});

describe('packing day', () => {
  it('computes a queue whose arithmetic adds up', async () => {
    const day = mockPackingDay(new MockScenario({ seed: 51, activityDate: DAY }), { lines: 8 });
    for (const line of await day.getQueue(DAY)) {
      expect(line.short).toBe(Math.max(0, line.needed - line.packedLeft));
      expect(line.short).toBeGreaterThanOrEqual(0);
    }
  });

  it('reduces the shortfall when a job is recorded', async () => {
    const day = mockPackingDay(new MockScenario({ seed: 52, activityDate: DAY }), { lines: 6 });
    const before = (await day.getQueue(DAY)).find((l) => l.short > 0)!;
    await day.recordPackJob('MOCK-RIG-001', before.kind);
    const after = (await day.getQueue(DAY)).find((l) => l.lineId === before.lineId)!;
    expect(after.short).toBe(before.short - 1);
  });

  it('never puts a rate on a sport job — that payment is off-system (DZM-Q-042)', async () => {
    const day = mockPackingDay(new MockScenario({ seed: 53, activityDate: DAY }), { completedJobs: 40, sportShare: 0.5 });
    const sport = await day.getSportJobs();
    expect(sport.length).toBeGreaterThan(0);
    for (const j of sport) expect(j.rateMinor).toBeUndefined();
  });

  it('invoices dropzone work only, never sport work (PAK-R-005)', async () => {
    const day = mockPackingDay(new MockScenario({ seed: 54, activityDate: DAY }), { completedJobs: 30, sportShare: 0.4 });
    const [invoice] = await day.getInvoices();
    const dzJobs = (await day.getPackJobs(DAY)).filter((j) => j.kind !== 'sport');
    expect(invoice!.jobCount).toBe(dzJobs.length);
  });

  it('keeps sport jobs reachable only through their own accessor, pending PAK-Q-003', async () => {
    const day = mockPackingDay(new MockScenario({ seed: 55, activityDate: DAY }), { completedJobs: 20, sportShare: 0.5 });
    const sport = await day.getSportJobs();
    // Every sport job is marked as such, so a consumer can never hand one over
    // without having decided to.
    expect(sport.every((j) => j.kind === 'sport')).toBe(true);
  });
});

describe('ops events', () => {
  it('carries no free text or person reference', () => {
    for (const e of mockOpsEventStream(new MockScenario({ seed: 61, activityDate: DAY }), { count: 60 })) {
      expect(() => assertNonIdentifying(e)).not.toThrow();
    }
  });

  it('rejects an event that smuggles in a string field', () => {
    const [event] = mockOpsEventStream(new MockScenario({ seed: 62, activityDate: DAY }), { count: 1 });
    const smuggled = { ...event!, detail: 'Ada Testerson could not check in' };
    expect(() => assertNonIdentifying(smuggled as never)).toThrow(/unexpected string field/);
  });

  it('correlates outcome with kind so a dashboard can be eyeballed', () => {
    for (const e of mockOpsEventStream(new MockScenario({ seed: 63, activityDate: DAY }), { count: 80 })) {
      if (e.kind === 'sync.failed') expect(e.outcome).toBe('failed');
      if (e.kind === 'product.started') expect(e.outcome).toBe('ok');
    }
  });

  it('uses an opaque tenant key, never a name', () => {
    for (const e of mockOpsEventStream(new MockScenario({ seed: 64, activityDate: DAY }), { count: 30 })) {
      expect(e.tenantKey).toMatch(/^mock-tenant-[0-9a-f]+$/);
    }
  });
});
