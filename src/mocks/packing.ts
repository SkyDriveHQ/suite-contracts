/**
 * Mock packing queue and pack jobs — the SkyPerson (packer) ↔ DZGO seam.
 *
 * **This generator is complete and the contract above it is not**, which is
 * deliberate. PAK-Q-001 asks whether the four packing operations belong on one
 * adapter or several, and that question has not been answered — so this file
 * fabricates every record type the boundary carries and exposes them through
 * plain methods. Whatever adapter surface gets declared in `../packing.ts`,
 * `MockPackingDay` already has the data and the behaviour to satisfy it; only
 * the `implements` clause is missing.
 *
 * **The queue is computed, not sampled.** `short` is derived from `needed`
 * minus what is packed, the way DZGO's own `QueueLine` derives it. A generator
 * that randomised `short` independently would produce queues that do not add
 * up, and the first thing a packer notices about a queue is whether the
 * arithmetic is right.
 */

import type {
  FleetKind,
  ISODate,
  MaintenanceNote,
  PackerInvoiceSummary,
  PackingEvent,
  PackingQueueLine,
  PackJobReport,
  RigKind,
  Unsubscribe,
} from '../index.js';
import { MockScenario } from './scenario.js';
import { Rng, shiftDays } from './rng.js';

/** Per-pack rates in minor units, by rig type. Tandem pays most; sport is off-system. */
const RATES_MINOR: Record<FleetKind, number> = {
  tandem: 1200,
  student: 800,
  rental: 800,
};

const NOTE_TEXT = [
  'Main closing loop worn, recommend replacement before next pack.',
  'Slider grommet has a rough edge.',
  'Missing one rubber band on the left side.',
  'Toggle stow elastic is stretched out.',
  'Container looks fine, no findings.',
] as const;

export interface MockPackingDayOptions {
  /** Queue lines to fabricate. Default 5. */
  lines?: number;
  /** Pack jobs already completed today. Default 9. */
  completedJobs?: number;
  /** Share of completed jobs on sport rigs — the PAK-Q-003 case. Default 0.25. */
  sportShare?: number;
}

/**
 * A fabricated packing day.
 *
 * Holds the queue, the jobs, the notes and the invoices, and exposes the four
 * operations PAK-R-002/003/004/005 describe. Deliberately implements no
 * interface yet — see the file header.
 */
export class MockPackingDay {
  readonly source = 'mock' as const;
  readonly descriptor = {
    label: 'Mock packing queue (DZGO stand-in)',
    speaks: 'dzgo' as const,
    isMock: true,
  };

  private queue: PackingQueueLine[] = [];
  private jobs: PackJobReport[] = [];
  private notes: MaintenanceNote[] = [];
  private invoices: PackerInvoiceSummary[] = [];
  private listeners = new Set<(event: PackingEvent) => void>();

  readonly packerId: string;
  private readonly rng: Rng;

  constructor(
    readonly scenario: MockScenario = new MockScenario(),
    options: MockPackingDayOptions = {},
  ) {
    this.rng = scenario.streamFor('packing');
    this.packerId = scenario.id('packer', 1);
    this.buildQueue(options.lines ?? 5);
    this.buildJobs(options.completedJobs ?? 9, options.sportShare ?? 0.25);
    this.buildInvoices();
  }

  private buildQueue(lines: number): void {
    const rng = this.rng;
    for (let i = 0; i < lines; i += 1) {
      const kind: FleetKind = rng.pick<FleetKind>(['tandem', 'student', 'student', 'rental']);
      const needed = rng.int(1, 5);
      // What is packed and matching right now. The shortfall follows from it —
      // never rolled independently, or the line would not add up.
      const packedLeft = Math.max(0, needed - rng.int(0, needed + 1));
      const hour = 10 + i;
      this.queue.push({
        lineId: this.scenario.id('queue', i + 1),
        loadNumber: i + 1,
        loadAt: hour <= 18 ? `${String(hour).padStart(2, '0')}:${rng.chance(0.5) ? '00' : '30'}` : null,
        kind,
        // Student rigs are matched on canopy size; tandem and rental are not.
        size: kind === 'student' ? rng.pick([190, 210, 230, 260]) : null,
        needed,
        packedLeft,
        short: Math.max(0, needed - packedLeft),
      });
    }
  }

  private buildJobs(count: number, sportShare: number): void {
    const rng = this.rng;
    for (let i = 0; i < count; i += 1) {
      const isSport = rng.chance(sportShare);
      const kind: RigKind = isSport ? 'sport' : rng.pick<RigKind>(['tandem', 'student', 'rental']);
      const hour = 9 + Math.floor((i * 35) / 60);
      const minute = (i * 35) % 60;
      this.jobs.push({
        ...this.scenario.provenance(),
        jobId: this.scenario.id('job', i + 1),
        scanCode: `MOCK-RIG-${String(rng.int(1, 12)).padStart(3, '0')}`,
        kind,
        packedAt: `${this.scenario.activityDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`,
        packerId: this.packerId,
        // A sport job carries no rate: DZM-Q-042 keeps that payment off-system
        // entirely, and inventing a number here would imply otherwise.
        ...(isSport ? {} : { rateMinor: RATES_MINOR[kind as FleetKind], currency: 'USD' }),
      });
    }
  }

  private buildInvoices(): void {
    // Only dropzone-owned work is invoiced through the dropzone (PAK-R-005).
    const dzJobs = this.jobs.filter((j) => j.kind !== 'sport');
    const totalMinor = dzJobs.reduce((sum, j) => sum + (j.rateMinor ?? 0), 0);
    if (dzJobs.length === 0) return;
    this.invoices.push({
      ...this.scenario.provenance(),
      invoiceId: this.scenario.id('invoice', 1),
      packerId: this.packerId,
      periodStart: shiftDays(this.scenario.activityDate, -6),
      periodEnd: this.scenario.activityDate,
      jobCount: dzJobs.length,
      totalMinor,
      currency: 'USD',
      createdAt: new Date().toISOString(),
    });
  }

  private emit(event: PackingEvent): void {
    for (const l of this.listeners) l(event);
  }

  // ── PAK-R-002: read the dropzone's queue ──────────────────────────────────

  async getQueue(_day: ISODate): Promise<PackingQueueLine[]> {
    // Shortest-staffed line first: what a packer actually wants to see at the top.
    return [...this.queue].sort((a, b) => b.short - a.short);
  }

  // ── PAK-R-003: report a completed pack job ────────────────────────────────

  async recordPackJob(scanCode: string, kind: RigKind): Promise<PackJobReport> {
    const job: PackJobReport = {
      ...this.scenario.provenance('manual'),
      jobId: this.scenario.id('job', this.jobs.length + 1),
      scanCode,
      kind,
      packedAt: new Date().toISOString(),
      packerId: this.packerId,
      ...(kind === 'sport' ? {} : { rateMinor: RATES_MINOR[kind as FleetKind], currency: 'USD' }),
    };
    this.jobs.push(job);

    // Packing one rig satisfies one unit of the neediest matching line.
    const line = this.queue.find((l) => l.kind === (kind as FleetKind) && l.short > 0);
    if (line) {
      const updated: PackingQueueLine = { ...line, packedLeft: line.packedLeft + 1, short: line.short - 1 };
      this.queue[this.queue.indexOf(line)] = updated;
      this.emit({ type: 'packing.queue_changed', at: job.packedAt, line: updated });
    }
    this.emit({ type: 'packing.job_recorded', at: job.packedAt, job });
    return job;
  }

  async getPackJobs(day: ISODate): Promise<PackJobReport[]> {
    return this.jobs.filter((j) => j.packedAt.startsWith(day));
  }

  /**
   * Jobs the packer keeps for themselves.
   *
   * Separated at the API rather than filtered by callers, because PAK-Q-003 —
   * whether a dropzone may ever see these — is unanswered, and a shape that
   * made it easy to hand over the whole list would answer it by accident.
   */
  async getSportJobs(): Promise<PackJobReport[]> {
    return this.jobs.filter((j) => j.kind === 'sport');
  }

  // ── PAK-R-004: maintenance notes ──────────────────────────────────────────

  async raiseNote(scanCode: string, text: string): Promise<MaintenanceNote> {
    const note: MaintenanceNote = {
      noteId: this.scenario.id('note', this.notes.length + 1),
      scanCode,
      raisedAt: new Date().toISOString(),
      text,
    };
    this.notes.push(note);
    this.emit({ type: 'packing.note_raised', at: note.raisedAt, note });
    return note;
  }

  async getNotes(scanCode?: string): Promise<MaintenanceNote[]> {
    return scanCode ? this.notes.filter((n) => n.scanCode === scanCode) : [...this.notes];
  }

  /** Seeds a few notes, so a consumer has something to render before anyone types one. */
  seedNotes(count = 2): MaintenanceNote[] {
    const rng = this.rng;
    const made: MaintenanceNote[] = [];
    for (let i = 0; i < count; i += 1) {
      made.push({
        noteId: this.scenario.id('note', this.notes.length + i + 1),
        scanCode: `MOCK-RIG-${String(rng.int(1, 12)).padStart(3, '0')}`,
        raisedAt: `${this.scenario.activityDate}T${String(rng.int(9, 16)).padStart(2, '0')}:00:00`,
        text: rng.pick(NOTE_TEXT),
        ...(rng.chance(0.4) ? { acknowledgedAt: new Date().toISOString() } : {}),
      });
    }
    this.notes.push(...made);
    return made;
  }

  // ── PAK-R-005: invoices ───────────────────────────────────────────────────

  async getInvoices(): Promise<PackerInvoiceSummary[]> {
    return [...this.invoices];
  }

  subscribe(listener: (event: PackingEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function mockPackingDay(scenario?: MockScenario, options?: MockPackingDayOptions): MockPackingDay {
  return new MockPackingDay(scenario, options);
}
