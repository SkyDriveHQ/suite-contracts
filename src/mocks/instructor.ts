/**
 * Mock `InstructorRosterAdapter` — the SkyPerson → DZGO seam.
 *
 * DZGO already has a mock roster in its own test harness. This one exists for
 * the **other** side: SkyPerson has no backend at all, so its instructor role
 * has never produced a record in the shape DZGO expects. A SkyPerson developer
 * can now render against the real contract instead of a local demo constant,
 * and the day a real feed is written it replaces this and nothing else moves.
 *
 * Every record is deliberately *incomplete in realistic ways* — not everyone is
 * checked in, not everyone is a tandem instructor, some have lapsed
 * credentials. A roster where every field is populated tests nothing; the
 * branches that break in production are the null ones.
 */

import type {
  InstructorEvent,
  InstructorRating,
  InstructorRecord,
  InstructorRosterAdapter,
  ISODate,
  Unsubscribe,
} from '../index.js';
import { MockScenario } from './scenario.js';
import { mockName, shiftDays } from './rng.js';

const ALL_RATINGS: InstructorRating[] = ['tandem', 'aff', 'coach', 'video', 'handcam', 'static-line', 'iad'];

const LANGUAGES = ['en', 'es', 'fr', 'de', 'pt'] as const;

export interface MockRosterOptions {
  /** How many instructors. Default 8 — a busy Saturday's staff. */
  count?: number;
  /** Share who have checked in. Default 0.7, so the "not checked in" branch is always exercised. */
  checkedInRate?: number;
}

function buildRoster(scenario: MockScenario, options: MockRosterOptions): InstructorRecord[] {
  const count = options.count ?? 8;
  const checkedInRate = options.checkedInRate ?? 0.7;
  const rng = scenario.streamFor('instructor');
  const out: InstructorRecord[] = [];

  for (let i = 0; i < count; i += 1) {
    const name = mockName(rng);
    const vendorInstructorId = `mock-instr-${String(i + 1).padStart(3, '0')}`;

    // Roughly the real mix: most staff at a dropzone hold tandem, a good share
    // hold AFF, video is common, the rest are occasional.
    const ratings: InstructorRating[] = [];
    if (rng.chance(0.7)) ratings.push('tandem');
    if (rng.chance(0.45)) ratings.push('aff');
    if (rng.chance(0.5)) ratings.push('video');
    if (rng.chance(0.3)) ratings.push('coach');
    if (rng.chance(0.25)) ratings.push('handcam');
    // Nobody with no rating at all would be on a roster.
    if (ratings.length === 0) ratings.push(rng.pick(ALL_RATINGS));

    const isTandem = ratings.includes('tandem');
    // Tandem weight limits cluster around 220 lb and are a personal choice.
    const profileLimit = isTandem ? rng.gaussian(220, 20, 180, 260) : null;
    // A lowered limit today is the fact DZM-R-025's board is built to show.
    const loweredToday = isTandem && rng.chance(0.2);
    const tandemLimit = profileLimit === null ? null : loweredToday ? profileLimit - rng.int(10, 30) : profileLimit;

    const checkedIn = rng.chance(checkedInRate);
    const checkedInAt = checkedIn
      ? `${scenario.activityDate}T${String(rng.int(7, 9)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}:00`
      : null;

    const languages = ['en', ...(rng.chance(0.3) ? [rng.pick(LANGUAGES)] : [])].filter(
      (v, idx, arr) => arr.indexOf(v) === idx,
    );

    const ratingExpiries: Partial<Record<InstructorRating, ISODate>> = {};
    for (const r of ratings) {
      // A fifth are already past their date. Dates are facts — nothing here
      // decides what that means (DEC-024); it is the consumer's screen that
      // shows the date and lets a person judge.
      ratingExpiries[r] = shiftDays(scenario.activityDate, rng.chance(0.2) ? -rng.int(1, 90) : rng.int(30, 400));
    }

    out.push({
      ...scenario.provenance(),
      id: `mock:${vendorInstructorId}`,
      vendorInstructorId,
      name,
      ratings,
      tandemWeightLimitLbs: tandemLimit,
      profileWeightLimitLbs: profileLimit,
      languages,
      checkedInAt,
      availableUntil: checkedIn && rng.chance(0.15) ? `${rng.int(14, 17)}:00` : null,
      // DEC-095: a boolean. The 1–10 number and any reason stay inside SkyPerson.
      lighterDayRequested: checkedIn && rng.chance(0.12),
      tandemJumpsToday: isTandem && checkedIn ? rng.int(0, 6) : 0,
      mediaJumpsToday: ratings.includes('video') && checkedIn ? rng.int(0, 5) : 0,
      credentials: {
        uspaNumber: `M-${rng.int(100000, 999999)}`,
        membershipExpires: shiftDays(scenario.activityDate, rng.int(-30, 500)),
        ratingExpiries,
        medicalExpires: rng.chance(0.5) ? shiftDays(scenario.activityDate, rng.int(-10, 700)) : null,
      },
      email: `${name.first.toLowerCase()}.${name.last.toLowerCase()}@example.test`,
    });
  }
  return out;
}

/**
 * A fabricated instructor roster behind the real adapter interface.
 *
 * `checkIn` / `checkOut` are exposed so a test panel can drive the day rather
 * than only observe it — the check-in transition is what DZGO's board reacts
 * to, and a mock that could only be read would never exercise it.
 */
export class MockInstructorRoster implements InstructorRosterAdapter {
  readonly source = 'mock' as const;
  readonly descriptor = {
    label: 'Mock instructor roster (SkyPerson stand-in)',
    speaks: 'skyperson' as const,
    isMock: true,
  };

  private records: InstructorRecord[];
  private listeners = new Set<(event: InstructorEvent) => void>();

  constructor(
    readonly scenario: MockScenario = new MockScenario(),
    options: MockRosterOptions = {},
  ) {
    this.records = buildRoster(scenario, options);
  }

  async getRoster(_date: ISODate): Promise<InstructorRecord[]> {
    return [...this.records].sort((a, b) => a.name.last.localeCompare(b.name.last));
  }

  async getInstructor(id: string): Promise<InstructorRecord | null> {
    return this.records.find((r) => r.id === id || r.vendorInstructorId === id) ?? null;
  }

  subscribe(listener: (event: InstructorEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(type: InstructorEvent['type'], instructor: InstructorRecord): void {
    const event: InstructorEvent = { type, at: new Date().toISOString(), instructor };
    for (const l of this.listeners) l(event);
  }

  /** Check an instructor in, as the morning desk would. */
  checkIn(id: string, at = new Date().toISOString()): InstructorRecord | null {
    const i = this.records.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const updated = { ...(this.records[i] as InstructorRecord), checkedInAt: at };
    this.records[i] = updated;
    this.emit('instructor.checked_in', updated);
    return updated;
  }

  checkOut(id: string): InstructorRecord | null {
    const i = this.records.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const updated = { ...(this.records[i] as InstructorRecord), checkedInAt: null };
    this.records[i] = updated;
    this.emit('instructor.checked_out', updated);
    return updated;
  }

  /** Raise the lighter-day flag. Takes no level — DEC-095 keeps the number inside SkyPerson. */
  requestLighterDay(id: string): InstructorRecord | null {
    const i = this.records.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const updated = { ...(this.records[i] as InstructorRecord), lighterDayRequested: true };
    this.records[i] = updated;
    this.emit('instructor.updated', updated);
    return updated;
  }
}

export function mockInstructorRoster(
  scenario?: MockScenario,
  options?: MockRosterOptions,
): MockInstructorRoster {
  return new MockInstructorRoster(scenario, options);
}
