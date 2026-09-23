/**
 * Mock instructor work: a stand-in for DZGO, answering for one signed-in
 * instructor across two fabricated dropzones.
 *
 * **What it fabricates, and why each part exists:**
 * - Two dropzones, so a screen that forgets to filter by dropzone shows it.
 * - Fourteen days of work ending on the scenario's day, with days off, so
 *   period totals and "no work that day" both render.
 * - One work kind the second dropzone has **no rate for** (coach jumps), so the
 *   "not priced here" state is always on screen. A mock where every line is
 *   priced would let a zero-for-unknown bug ship.
 * - Lines older than a week are already paid, so "already paid" is exercised.
 * - Pack jobs, so an instructor who also packs sees them in the same day.
 *
 * Amounts are computed from the rates, never rolled independently, so every
 * total adds up the way DZGO's would.
 */

import {
  JUMP_KINDS,
  InvoiceRejectedError,
  invoiceProblems,
  invoiceTotalMinor,
  type AvailabilityDraft,
  type AvailabilityEntry,
  type CheckInRequest,
  type ISODate,
  type InstructorDaySummary,
  type InstructorDropzone,
  type InstructorEarningsLine,
  type InstructorInvoice,
  type InstructorJumpTotals,
  type InstructorManifestLoad,
  type InstructorWorkAdapter,
  type InstructorWorkEvent,
  type InvoiceDraft,
  type InvoiceStatus,
  type ManifestSlot,
  type Unsubscribe,
  type WorkKind,
} from '../index.js';
import { MockScenario } from './scenario.js';
import { Rng, mockName, nowIso, shiftDays } from './rng.js';

/** Per-dropzone rates in minor units. `null` = that dropzone has no rate for this kind. */
type RateCard = Record<WorkKind, number | null>;

const RATES: readonly RateCard[] = [
  { tandem: 4500, aff: 4000, coach: 2500, video: 3500, handcam: 1500, 'static-line': 3000, 'pack-job': 800, other: null },
  { tandem: 5000, aff: 4500, coach: null, video: 4000, handcam: 2000, 'static-line': null, 'pack-job': 900, other: null },
];

const DZ_NAMES = ['Mock Skydive Front Range', 'Mock Skydive High Plains'] as const;
const AIRCRAFT = ['Caravan N208MK', 'Twin Otter N300MK'] as const;

export interface MockInstructorWorkOptions {
  /** Days of history ending on the scenario's day. Default 14. */
  days?: number;
  /** Loads per operating day at each dropzone. Default 12. */
  loadsPerDay?: number;
}

interface FabricatedLoad {
  load: InstructorManifestLoad;
  date: ISODate;
  dzId: string;
}

export class MockInstructorWork implements InstructorWorkAdapter {
  readonly source = 'mock' as const;
  readonly descriptor = { label: 'Mock instructor work (DZGO stand-in)', speaks: 'dzgo' as const, isMock: true };

  private readonly rng: Rng;
  private readonly dropzones: InstructorDropzone[];
  private readonly lines: InstructorEarningsLine[] = [];
  private readonly loads: FabricatedLoad[] = [];
  private readonly availability: AvailabilityEntry[] = [];
  private readonly invoices: InstructorInvoice[] = [];
  private readonly checkIns = new Map<string, { at: string; until: string | null; lighterDay: boolean }>();
  private readonly listeners = new Set<(e: InstructorWorkEvent) => void>();
  private nextInvoice = 1;
  private nextAvailability = 1;

  constructor(
    readonly scenario: MockScenario = new MockScenario(),
    options: MockInstructorWorkOptions = {},
  ) {
    this.rng = scenario.streamFor('instructor-work');
    this.dropzones = DZ_NAMES.map((dzName, i) => ({ dzId: scenario.id('dz', i + 1), dzName, currency: 'USD' }));
    const days = options.days ?? 14;
    const loadsPerDay = options.loadsPerDay ?? 12;
    for (let back = days - 1; back >= 0; back -= 1) {
      const date = shiftDays(scenario.activityDate, -back);
      this.dropzones.forEach((dz, i) => this.fabricateDay(dz, i, date, back, loadsPerDay));
    }
    this.fabricateAvailability();
    this.fabricatePastInvoice();
    // Checked in this morning at the home dropzone, so both check-in states render.
    this.checkIns.set(this.key(this.dropzones[0]!.dzId, scenario.activityDate), {
      at: `${scenario.activityDate}T08:12:00`,
      until: null,
      lighterDay: false,
    });
  }

  private key(dzId: string, date: ISODate): string {
    return `${dzId}|${date}`;
  }

  private fabricateDay(dz: InstructorDropzone, dzIndex: number, date: ISODate, daysAgo: number, loadsPerDay: number): void {
    const rng = this.rng;
    // The home dropzone most days, the second one occasionally; some days off.
    const works = dzIndex === 0 ? rng.chance(0.7) : rng.chance(0.25);
    const isToday = daysAgo === 0;
    const rates = RATES[dzIndex]!;
    let lineNo = 0;
    const addLine = (kind: WorkKind, loadNumber: number | null, description: string) => {
      lineNo += 1;
      const rateMinor = rates[kind];
      const paidOut = daysAgo > 7;
      this.lines.push({
        ...this.scenario.provenance(),
        lineId: `${dz.dzId}:${date}:${kind}:${lineNo}`,
        dzId: dz.dzId,
        on: date,
        kind,
        loadNumber,
        description,
        rateMinor,
        amountMinor: rateMinor,
        currency: dz.currency,
        paid:
          paidOut && rateMinor !== null
            ? { payoutId: this.scenario.id('payout', Math.floor(daysAgo / 7)), paidAt: `${shiftDays(date, 7 - (daysAgo % 7))}T17:00:00` }
            : null,
      });
    };

    // Loads exist whether or not this instructor works; the manifest shows them all.
    const sentBy = isToday ? Math.floor(loadsPerDay / 2) : loadsPerDay;
    for (let n = 1; n <= loadsPerDay; n += 1) {
      const status: InstructorManifestLoad['status'] = n <= sentBy ? 'sent' : n === sentBy + 1 ? 'confirmed' : 'building';
      const minutes = 9 * 60 + (n - 1) * 40;
      const callAt = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const mySlots: ManifestSlot[] = [];
      if (works && rng.chance(0.55)) {
        const kind = rng.pick<WorkKind>(['tandem', 'tandem', 'tandem', 'video', 'handcam', 'aff', 'coach']);
        const withFirstName = kind === 'tandem' || kind === 'aff' ? mockName(rng).first : null;
        mySlots.push({ kind, withFirstName });
        if (status === 'sent') {
          const who = withFirstName ? ` with ${withFirstName}` : '';
          addLine(kind, n, `Load ${n} · ${kind === 'video' ? 'outside video' : kind}${who}`);
        }
      }
      const slotsTotal = n % 3 === 0 ? 22 : 14;
      this.loads.push({
        dzId: dz.dzId,
        date,
        load: {
          loadId: `${dz.dzId}:${date}:load:${n}`,
          loadNumber: n,
          status,
          callAt,
          aircraft: AIRCRAFT[slotsTotal === 22 ? 1 : 0]!,
          slotsFilled: status === 'building' ? rng.int(3, slotsTotal - 2) : slotsTotal - rng.int(0, 2),
          slotsTotal,
          mySlots,
        },
      });
    }
    // Some instructors pack between loads; those jobs pay per pack.
    if (works && rng.chance(0.4)) {
      const packs = rng.int(1, 4);
      for (let p = 0; p < packs; p += 1) addLine('pack-job', null, `Pack job · ${rng.pick(['tandem', 'student'])} rig`);
    }
  }

  private fabricateAvailability(): void {
    const home = this.dropzones[0]!;
    for (let ahead = 1; ahead <= 10; ahead += 1) {
      const date = shiftDays(this.scenario.activityDate, ahead);
      if (!this.rng.chance(0.6)) continue;
      const unavailable = this.rng.chance(0.25);
      this.availability.push({
        entryId: this.scenario.id('avail', this.nextAvailability++),
        dzId: home.dzId,
        date,
        status: unavailable ? 'unavailable' : 'available',
        from: null,
        until: !unavailable && this.rng.chance(0.3) ? '15:00' : null,
        note: unavailable ? 'Out of town' : null,
      });
    }
  }

  /** One accepted invoice from the week before last, so the invoice list is never empty. */
  private fabricatePastInvoice(): void {
    const home = this.dropzones[0]!;
    const periodEnd = shiftDays(this.scenario.activityDate, -8);
    const periodStart = shiftDays(periodEnd, -6);
    const lineIds = this.lines
      .filter((l) => l.dzId === home.dzId && l.on >= periodStart && l.on <= periodEnd && l.amountMinor !== null)
      .map((l) => l.lineId);
    if (lineIds.length === 0) return;
    this.invoices.push({
      ...this.scenario.provenance(),
      invoiceId: this.scenario.id('invoice', this.nextInvoice),
      number: `INV-${String(this.nextInvoice++).padStart(4, '0')}`,
      dzId: home.dzId,
      periodStart,
      periodEnd,
      lineIds,
      totalMinor: invoiceTotalMinor(lineIds, this.lines),
      currency: home.currency,
      note: null,
      status: 'paid',
      submittedAt: `${shiftDays(periodEnd, 1)}T20:00:00`,
      respondedAt: `${shiftDays(periodEnd, 2)}T10:00:00`,
      dzNote: null,
    });
  }

  private emit(event: InstructorWorkEvent): void {
    for (const l of this.listeners) l(event);
  }

  private requireDz(dzId: string): InstructorDropzone {
    const dz = this.dropzones.find((d) => d.dzId === dzId);
    if (!dz) throw new Error(`not an instructor at ${dzId}`);
    return dz;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async listDropzones(): Promise<InstructorDropzone[]> {
    return this.dropzones.map((d) => ({ ...d }));
  }

  async getDay(dzId: string, date: ISODate): Promise<InstructorDaySummary> {
    this.requireDz(dzId);
    const lines = this.lines.filter((l) => l.dzId === dzId && l.on === date);
    const jumps: Partial<Record<WorkKind, number>> = {};
    for (const l of lines) if (JUMP_KINDS.includes(l.kind)) jumps[l.kind] = (jumps[l.kind] ?? 0) + 1;
    const check = this.checkIns.get(this.key(dzId, date));
    return { dzId, date, checkedInAt: check?.at ?? null, availableUntil: check?.until ?? null, jumps, lines };
  }

  async getManifest(dzId: string, date: ISODate): Promise<InstructorManifestLoad[]> {
    this.requireDz(dzId);
    return this.loads.filter((l) => l.dzId === dzId && l.date === date).map((l) => l.load);
  }

  async getJumpTotals(dzId: string, from: ISODate, to: ISODate): Promise<InstructorJumpTotals> {
    this.requireDz(dzId);
    const byKind: Partial<Record<WorkKind, number>> = {};
    let total = 0;
    for (const l of this.lines) {
      if (l.dzId !== dzId || l.on < from || l.on > to || !JUMP_KINDS.includes(l.kind)) continue;
      byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
      total += 1;
    }
    return { dzId, from, to, byKind, total };
  }

  async getEarnings(dzId: string, from: ISODate, to: ISODate): Promise<InstructorEarningsLine[]> {
    this.requireDz(dzId);
    return this.lines.filter((l) => l.dzId === dzId && l.on >= from && l.on <= to);
  }

  async getAvailability(dzId: string, from: ISODate, to: ISODate): Promise<AvailabilityEntry[]> {
    this.requireDz(dzId);
    return this.availability.filter((a) => a.dzId === dzId && a.date >= from && a.date <= to).sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  async listInvoices(dzId: string): Promise<InstructorInvoice[]> {
    this.requireDz(dzId);
    return this.invoices.filter((i) => i.dzId === dzId);
  }

  // ── writes ───────────────────────────────────────────────────────────────

  async setAvailability(entry: AvailabilityDraft): Promise<AvailabilityEntry> {
    this.requireDz(entry.dzId);
    // One entry per person per day at a dropzone, as DZGO's table keys it.
    const existing = this.availability.findIndex((a) => a.dzId === entry.dzId && a.date === entry.date);
    const saved: AvailabilityEntry = {
      ...entry,
      entryId: existing >= 0 ? this.availability[existing]!.entryId : this.scenario.id('avail', this.nextAvailability++),
    };
    if (existing >= 0) this.availability[existing] = saved;
    else this.availability.push(saved);
    return saved;
  }

  async clearAvailability(dzId: string, entryId: string): Promise<void> {
    this.requireDz(dzId);
    const i = this.availability.findIndex((a) => a.dzId === dzId && a.entryId === entryId);
    if (i >= 0) this.availability.splice(i, 1);
  }

  async checkIn(dzId: string, request: CheckInRequest): Promise<InstructorDaySummary> {
    this.requireDz(dzId);
    const date = this.scenario.activityDate;
    this.checkIns.set(this.key(dzId, date), { at: nowIso(), until: request.availableUntil, lighterDay: request.lighterDayRequested });
    return this.getDay(dzId, date);
  }

  async checkOut(dzId: string): Promise<InstructorDaySummary> {
    this.requireDz(dzId);
    const date = this.scenario.activityDate;
    this.checkIns.delete(this.key(dzId, date));
    return this.getDay(dzId, date);
  }

  async submitInvoice(draft: InvoiceDraft): Promise<InstructorInvoice> {
    const dz = this.requireDz(draft.dzId);
    const open = this.invoices.filter((i) => i.dzId === draft.dzId);
    const problems = invoiceProblems(draft, this.lines, open);
    if (problems.length > 0) throw new InvoiceRejectedError(problems);
    const invoice: InstructorInvoice = {
      ...this.scenario.provenance('manual'),
      invoiceId: this.scenario.id('invoice', this.nextInvoice),
      number: `INV-${String(this.nextInvoice++).padStart(4, '0')}`,
      dzId: draft.dzId,
      periodStart: draft.periodStart,
      periodEnd: draft.periodEnd,
      lineIds: [...draft.lineIds],
      totalMinor: invoiceTotalMinor(draft.lineIds, this.lines),
      currency: dz.currency,
      note: draft.note,
      status: 'submitted',
      submittedAt: nowIso(),
      respondedAt: null,
      dzNote: null,
    };
    this.invoices.push(invoice);
    this.emit({ type: 'invoice.status_changed', at: invoice.submittedAt, dzId: draft.dzId, invoice });
    return invoice;
  }

  /**
   * Test-panel control: act as the dropzone responding to an invoice. Not part
   * of the adapter. In production, only DZGO changes an invoice's status.
   */
  respond(invoiceId: string, status: Exclude<InvoiceStatus, 'submitted'>, dzNote: string | null = null): InstructorInvoice {
    const inv = this.invoices.find((i) => i.invoiceId === invoiceId);
    if (!inv) throw new Error(`no invoice ${invoiceId}`);
    inv.status = status;
    inv.respondedAt = nowIso();
    inv.dzNote = dzNote;
    if (status === 'paid') {
      for (const id of inv.lineIds) {
        const line = this.lines.find((l) => l.lineId === id);
        if (line && !line.paid) {
          line.paid = { payoutId: this.scenario.id('payout', 900 + this.nextInvoice), paidAt: inv.respondedAt };
          // A consumer listening per line must see the flip, not only the invoice's status change.
          this.emit({ type: 'work.line_paid', at: inv.respondedAt, dzId: inv.dzId, line });
        }
      }
    }
    this.emit({ type: 'invoice.status_changed', at: inv.respondedAt, dzId: inv.dzId, invoice: inv });
    return inv;
  }

  /** Test-panel read: whether today's check-in carried a lighter-day request (the boolean only, DEC-095). */
  lighterDayRequested(dzId: string): boolean {
    return this.checkIns.get(this.key(dzId, this.scenario.activityDate))?.lighterDay ?? false;
  }

  subscribe(listener: (event: InstructorWorkEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function mockInstructorWork(scenario?: MockScenario, options?: MockInstructorWorkOptions): MockInstructorWork {
  return new MockInstructorWork(scenario, options);
}
