/**
 * Instructor work — DZGO → SkyPerson (instructor role), plus the three writes
 * an instructor makes back: availability, check-in and an invoice.
 *
 * ## ⚠️ PROPOSED
 *
 * Kyle, 2026-09-23: instructors should be able to check in, mark availability,
 * see their jumps, view the manifest, see their working-day totals *as
 * reported by DZGO*, and turn those into an invoice to the dropzone. The
 * roster contract (`./instructor.ts`) only carries the SkyPerson → DZGO half.
 * This file is the other half. It is safe to build a mock against and unsafe
 * to build a real feed against until DZGO serves it.
 *
 * ## Who owns what (DEC-096)
 *
 * The dropzone owns its pay rates and its record of the work done there. So
 * every amount on this boundary is **DZGO's number**: SkyPerson displays it,
 * groups it and puts it on an invoice, and never computes a rate of its own.
 * A line DZGO has no rate for arrives with `amountMinor: null`, "not priced
 * here", and **never as a zero**, because a zero on an invoice is a claim that
 * the work was free.
 *
 * ## The adapter is scoped to one person, by construction
 *
 * No method takes an instructor id. An implementation is built for the
 * signed-in person (DZGO resolves `instructor_profiles.user_id` from the
 * identity token) and can only ever answer about them. That is the property
 * DZGO's row-level security does not yet have (finding d0eab4c0, 2026-09-23),
 * so it must live in the interface rather than be trusted to a query.
 *
 * ## The manifest is a projection
 *
 * `InstructorManifestLoad` is not DZGO's `LoadRecord`. It carries the loads, the
 * instructor's own slots on them, and head counts. Other people's slots appear
 * only as counts, and a tandem student only by first name. The same rule
 * `packing.ts` states: pass what the reader needs, not the other product's
 * domain model (DEC-046).
 *
 * ## Invoices: composed here, received there
 *
 * The instructor picks DZGO-reported lines and submits them. DZGO receives the
 * invoice and says what happened to it (accepted, disputed, paid). An invoice
 * line is a reference to an earnings line, never a free-typed amount, so an
 * invoice cannot claim work the dropzone has no record of, and one piece of
 * work cannot be billed twice (`invoiceProblems`). This is the simple
 * engagement model (DZM-R-003 Model A: the dropzone pays per jump, per pack
 * job, per media jump). The "dropzone as a service to the instructor" model
 * (Model B, DEC-081) replaces invoices with settlement statements and is not
 * modelled here.
 *
 * ## Rule 13
 *
 * Every write here is an optional overlay on a native DZGO screen: the desk
 * still checks instructors in, the dropzone's own availability page still
 * works, and a dropzone that never hears of SkyPerson pays its staff exactly
 * as before.
 */

import type { ISODate, ISODateTime, SuiteAdapterDescriptor, SuiteProvenance, SuiteSource, Unsubscribe } from './common.js';

/**
 * The kinds of work a dropzone can pay an instructor for.
 *
 * Deliberately wider than what DZGO prices today (tandem only, 2026-09-23):
 * the contract carries what the work *was*, and whether the dropzone has a rate
 * for it is `amountMinor`'s job.
 */
export type WorkKind =
  | 'tandem'
  | 'aff'
  | 'coach'
  | 'video'
  | 'handcam'
  | 'static-line'
  | 'pack-job'
  | 'other';

export const WORK_KIND_LABELS: Record<WorkKind, string> = {
  tandem: 'Tandem',
  aff: 'AFF',
  coach: 'Coach jump',
  video: 'Outside video',
  handcam: 'Handcam',
  'static-line': 'Static line',
  'pack-job': 'Pack job',
  other: 'Other',
};

/** Work kinds that are jumps (a pack job is work, not a jump). */
export const JUMP_KINDS: readonly WorkKind[] = ['tandem', 'aff', 'coach', 'video', 'handcam', 'static-line'];

/** A dropzone this person works at, as far as DZGO knows. */
export interface InstructorDropzone {
  readonly dzId: string;
  readonly dzName: string;
  readonly currency: string;
}

/**
 * One piece of work DZGO recorded for this instructor, with the pay DZGO
 * attached to it.
 *
 * `lineId` is DZGO's own key for the work: the same key its payouts use
 * (`payout_items (dz_id, kind, item_id)`), so "already paid" and "already
 * invoiced" are checks against one identity, not a fuzzy match.
 */
export type InstructorEarningsLine = SuiteProvenance & {
  lineId: string;
  dzId: string;
  on: ISODate;
  kind: WorkKind;
  /** The load it happened on. Null for work that is not on a load (a pack job). */
  loadNumber: number | null;
  /** Shown verbatim, e.g. "Load 7 · tandem with Sam". */
  description: string;
  /** DZGO's rate for this kind of work. Null = the dropzone has no rate set for it. */
  rateMinor: number | null;
  /** What DZGO says this line is worth. Null = not priced; never a zero standing in for unknown. */
  amountMinor: number | null;
  currency: string;
  /** Present once the dropzone has paid this line. */
  paid: { payoutId: string; paidAt: ISODateTime } | null;
};

/** One instructor's day at one dropzone. */
export interface InstructorDaySummary {
  readonly dzId: string;
  readonly date: ISODate;
  /** Morning check-in as DZGO holds it, whoever recorded it. Null = not checked in. */
  readonly checkedInAt: ISODateTime | null;
  /** Leaving early today, `HH:mm` local. Null = available all day. */
  readonly availableUntil: string | null;
  /** Jumps by kind on loads that have been sent. */
  readonly jumps: Partial<Record<WorkKind, number>>;
  readonly lines: readonly InstructorEarningsLine[];
}

/** One of the instructor's own slots on a load. */
export interface ManifestSlot {
  readonly kind: WorkKind;
  /** First name only, and only for the person this instructor is responsible for (a tandem student). */
  readonly withFirstName: string | null;
}

/** A load as the instructor sees it on the manifest. */
export interface InstructorManifestLoad {
  readonly loadId: string;
  readonly loadNumber: number;
  readonly status: 'building' | 'confirmed' | 'sent';
  /** Planned call time, `HH:mm` local. Null = not yet timed. */
  readonly callAt: string | null;
  readonly aircraft: string | null;
  readonly slotsFilled: number;
  readonly slotsTotal: number;
  /** Empty when the instructor is not on this load. */
  readonly mySlots: readonly ManifestSlot[];
}

/** Working jumps at one dropzone over a period, as DZGO counted them from sent loads. */
export interface InstructorJumpTotals {
  readonly dzId: string;
  readonly from: ISODate;
  readonly to: ISODate;
  readonly byKind: Partial<Record<WorkKind, number>>;
  readonly total: number;
}

/** Mirrors DZGO's `staff_availability` row. */
export interface AvailabilityEntry {
  readonly entryId: string;
  readonly dzId: string;
  readonly date: ISODate;
  readonly status: 'available' | 'unavailable';
  /** `HH:mm` local. Null = from the start of the day. */
  readonly from: string | null;
  /** `HH:mm` local. Null = to the end of the day. */
  readonly until: string | null;
  readonly note: string | null;
}

export type AvailabilityDraft = Omit<AvailabilityEntry, 'entryId'>;

/** SkyPerson → DZGO. The lighter-day level never crosses; only the boolean does (DEC-095). */
export interface CheckInRequest {
  readonly availableUntil: string | null;
  readonly lighterDayRequested: boolean;
}

export type InvoiceStatus = 'submitted' | 'accepted' | 'disputed' | 'paid';

/** What the instructor sends. Line references only; the total is derived, never typed. */
export interface InvoiceDraft {
  readonly dzId: string;
  readonly periodStart: ISODate;
  readonly periodEnd: ISODate;
  readonly lineIds: readonly string[];
  /** Optional note to the dropzone, shown verbatim. */
  readonly note: string | null;
}

export type InstructorInvoice = SuiteProvenance & {
  invoiceId: string;
  /** The instructor's own sequential number, e.g. "INV-0007", for their records. */
  number: string;
  dzId: string;
  periodStart: ISODate;
  periodEnd: ISODate;
  lineIds: string[];
  totalMinor: number;
  currency: string;
  note: string | null;
  status: InvoiceStatus;
  submittedAt: ISODateTime;
  /** Set when the dropzone responds. */
  respondedAt: ISODateTime | null;
  /** The dropzone's reason when it disputes a line, shown verbatim. */
  dzNote: string | null;
};

export type InstructorWorkEventType =
  | 'work.line_recorded'
  | 'work.line_paid'
  | 'manifest.changed'
  | 'invoice.status_changed';

export interface InstructorWorkEvent {
  type: InstructorWorkEventType;
  at: ISODateTime;
  dzId: string;
  line?: InstructorEarningsLine;
  invoice?: InstructorInvoice;
}

/** Why an invoice cannot be submitted as drafted. */
export type InvoiceProblem =
  | { kind: 'empty' }
  | { kind: 'unknown-line'; lineId: string }
  | { kind: 'other-dropzone'; lineId: string }
  | { kind: 'outside-period'; lineId: string }
  | { kind: 'not-priced'; lineId: string }
  | { kind: 'already-paid'; lineId: string }
  | { kind: 'already-invoiced'; lineId: string; invoiceId: string }
  | { kind: 'duplicate-line'; lineId: string };

/**
 * Everything wrong with a draft, checked against DZGO's own lines and the
 * instructor's open invoices. Empty = it can be submitted.
 *
 * Both sides run the same function: SkyPerson to disable the Send button with
 * a reason, DZGO to refuse the submission if SkyPerson's copy was stale.
 */
export function invoiceProblems(
  draft: InvoiceDraft,
  lines: readonly InstructorEarningsLine[],
  openInvoices: readonly InstructorInvoice[],
): InvoiceProblem[] {
  const problems: InvoiceProblem[] = [];
  if (draft.lineIds.length === 0) problems.push({ kind: 'empty' });
  const byId = new Map(lines.map((l) => [l.lineId, l]));
  const claimed = new Map<string, string>();
  for (const inv of openInvoices) {
    if (inv.status === 'disputed') continue; // a disputed invoice releases its lines to be billed again
    for (const id of inv.lineIds) claimed.set(id, inv.invoiceId);
  }
  const seen = new Set<string>();
  for (const id of draft.lineIds) {
    if (seen.has(id)) {
      problems.push({ kind: 'duplicate-line', lineId: id });
      continue;
    }
    seen.add(id);
    const line = byId.get(id);
    if (!line) {
      problems.push({ kind: 'unknown-line', lineId: id });
      continue;
    }
    if (line.dzId !== draft.dzId) problems.push({ kind: 'other-dropzone', lineId: id });
    if (line.on < draft.periodStart || line.on > draft.periodEnd) problems.push({ kind: 'outside-period', lineId: id });
    if (line.amountMinor === null) problems.push({ kind: 'not-priced', lineId: id });
    if (line.paid) problems.push({ kind: 'already-paid', lineId: id });
    const other = claimed.get(id);
    if (other) problems.push({ kind: 'already-invoiced', lineId: id, invoiceId: other });
  }
  return problems;
}

/** The invoice total, from DZGO's line amounts. Throws on an unpriced line rather than counting it as zero. */
export function invoiceTotalMinor(lineIds: readonly string[], lines: readonly InstructorEarningsLine[]): number {
  const byId = new Map(lines.map((l) => [l.lineId, l]));
  let total = 0;
  for (const id of lineIds) {
    const line = byId.get(id);
    if (!line) throw new Error(`unknown earnings line ${id}`);
    if (line.amountMinor === null) throw new Error(`earnings line ${id} has no price`);
    total += line.amountMinor;
  }
  return total;
}

/**
 * Everything SkyPerson's instructor role reads from and writes to one or more
 * dropzones, for **the signed-in person only**.
 *
 * Reads throw `SiblingUnreachableError` when DZGO cannot be reached; the
 * instructor app then shows its own offline state and carries on (Rule 13).
 */
export interface InstructorWorkAdapter {
  readonly source: SuiteSource;
  readonly descriptor: SuiteAdapterDescriptor;

  /** The dropzones where this person is on the instructor roster. */
  listDropzones(): Promise<InstructorDropzone[]>;

  getDay(dzId: string, date: ISODate): Promise<InstructorDaySummary>;
  getManifest(dzId: string, date: ISODate): Promise<InstructorManifestLoad[]>;
  getJumpTotals(dzId: string, from: ISODate, to: ISODate): Promise<InstructorJumpTotals>;
  getEarnings(dzId: string, from: ISODate, to: ISODate): Promise<InstructorEarningsLine[]>;

  getAvailability(dzId: string, from: ISODate, to: ISODate): Promise<AvailabilityEntry[]>;
  setAvailability(entry: AvailabilityDraft): Promise<AvailabilityEntry>;
  clearAvailability(dzId: string, entryId: string): Promise<void>;

  /** Today's check-in at `dzId`. Shows on DZGO's board the same as a desk check-in. */
  checkIn(dzId: string, request: CheckInRequest): Promise<InstructorDaySummary>;
  checkOut(dzId: string): Promise<InstructorDaySummary>;

  listInvoices(dzId: string): Promise<InstructorInvoice[]>;
  /** DZGO re-runs `invoiceProblems` and rejects with the list if the draft is no longer valid. */
  submitInvoice(draft: InvoiceDraft): Promise<InstructorInvoice>;

  subscribe(listener: (event: InstructorWorkEvent) => void): Unsubscribe;
}

/** Thrown by `submitInvoice` when DZGO refuses a draft. Carries the reasons as data, not text. */
export class InvoiceRejectedError extends Error {
  readonly problems: InvoiceProblem[];
  constructor(problems: InvoiceProblem[]) {
    super(`invoice rejected: ${problems.map((p) => p.kind).join(', ')}`);
    this.name = 'InvoiceRejectedError';
    this.problems = problems;
  }
}
