/**
 * Packing queue and pack jobs — SkyPerson (packer role) ↔ DZGO.
 *
 * ## ⚠️ PROPOSED, and the adapter surface is an open question by name.
 *
 * `SKYPERSON-MASTER.md` §15.3 tracks this as **PAK-Q-001**: *"Exact shape of
 * `PackingQueueAdapter` and whether pack-job push (PAK-R-003) and maintenance
 * sync (PAK-R-004) are the same adapter or separate ones."* That question has
 * not been answered, so this file defines the **records** that cross the
 * boundary — which the requirements do determine — and leaves the adapter
 * surface itself to be decided.
 *
 * ## Direction, which is settled
 *
 * DZGO is the source of record (PAK-R-002). The packer role *reads* the
 * dropzone's queue and *reports* completed jobs back. It never owns the queue.
 *
 * ## Rule 13, stated by §15.4 about this role specifically
 *
 * > "Every one of §15.2's capabilities already exists natively in DZGO,
 * > independent of this app... This role is the optional overlay, never the
 * > requirement."
 *
 * DZGO's packing desk (DZM-R-061) — scan-in/out, packed/available/needed-next,
 * pack jobs, invoices, and a packer-facing `/pack` phone view — is built and
 * live. A dropzone that never hears of SkyPerson loses nothing. What the
 * overlay buys is portability: a contractor working four dropzones sees one
 * queue and one invoice list instead of four.
 *
 * ## The sport-rig rule is a privacy boundary, not a feature gap
 *
 * DZGO deliberately does not track sport-rig pack jobs or their payment at all
 * (DZM-Q-042) — a fun jumper pays their packer directly, off-system. So a
 * sport-rig job recorded in SkyPerson is **the packer's own business record**.
 * Whether a dropzone may ever see one is **PAK-Q-003, explicitly Kyle's call**
 * and explicitly unanswered.
 *
 * Until it is answered, this file takes the conservative reading: `PackJobReport`
 * carries `kind`, so a consumer can tell a sport rig apart, and the *adapter*
 * is the thing that decides what it is willing to send. A shape that made sport
 * jobs indistinguishable would foreclose PAK-Q-003 by accident.
 */

import type {
  ISODate,
  ISODateTime,
  SuiteAdapterDescriptor,
  SuiteProvenance,
  SuiteSource,
  Unsubscribe,
} from './common.js';
import type { RigKind } from './rig.js';

/** Rigs a dropzone owns and pays packers for. Sport rigs are the jumper's own. */
export type FleetKind = Exclude<RigKind, 'sport'>;

/**
 * One line of "what needs packing next", as DZGO's queue computes it.
 *
 * Mirrors DZGO's native `QueueLine` (`dzgo/src/domain/rigs.ts`) with the
 * internal `LoadRecord` flattened to the two fields a packer actually reads —
 * a packer needs to know which load and when, not DZGO's whole load object.
 * Passing the internal record would leak DZGO's domain model across a product
 * boundary that DEC-046 exists to keep narrow.
 */
export interface PackingQueueLine {
  readonly lineId: string;
  /** The load number the dropzone calls out. */
  readonly loadNumber: number;
  /** When that load is expected to go, `HH:mm` local. Null = not yet timed. */
  readonly loadAt: string | null;
  readonly kind: FleetKind;
  /** Canopy size the need asked for, in square feet. Null = any size will do. */
  readonly size: number | null;
  /** How many rigs of this spec the load needs. */
  readonly needed: number;
  /** Matching packed rigs left after this load takes its share. */
  readonly packedLeft: number;
  /** Shortfall: how many still have to be packed for this line. The number the packer works to. */
  readonly short: number;
}

/** A completed pack job, as the packer reports it (PAK-R-003). */
export type PackJobReport = SuiteProvenance & {
  jobId: string;
  /** The code on the rig's label — the join key both products already read. */
  scanCode: string;
  /**
   * **Load-bearing for PAK-Q-003.** `sport` marks a job on a jumper's own rig,
   * which DZGO does not track and which is the packer's private record until
   * that question is answered.
   */
  kind: RigKind;
  packedAt: ISODateTime;
  /** Who packed it, in the consuming product's own id space. */
  packerId: string;
  /** Agreed rate in minor units. Absent for sport rigs, which are settled off-system. */
  rateMinor?: number;
  currency?: string;
};

/**
 * Something the packer noticed about a rig (PAK-R-004).
 *
 * Always at minimum a private note in SkyPerson, whether or not a dropzone
 * accepts it. Whether a dropzone can restrict which packers write back is
 * **PAK-Q-002**, unresolved, and a dropzone-side permission rather than
 * anything this type should encode.
 *
 * No severity enum, deliberately. "Needs repair" is an observation a packer is
 * entitled to make; a ranked scale invites software to act on it, and DEC-024
 * says it must not.
 */
export interface MaintenanceNote {
  readonly noteId: string;
  readonly scanCode: string;
  readonly raisedAt: ISODateTime;
  /** Free text, shown verbatim, never parsed for meaning. */
  readonly text: string;
  readonly acknowledgedAt?: ISODateTime;
}

/** A packer's invoice for a period — a read mirror of what DZGO already produced (PAK-R-005). */
export type PackerInvoiceSummary = SuiteProvenance & {
  invoiceId: string;
  packerId: string;
  periodStart: ISODate;
  periodEnd: ISODate;
  jobCount: number;
  totalMinor: number;
  currency: string;
  createdAt: ISODateTime;
};

export type PackingEventType =
  | 'packing.queue_changed'
  | 'packing.job_recorded'
  | 'packing.note_raised'
  | 'packing.invoice_issued';

export interface PackingEvent {
  type: PackingEventType;
  at: ISODateTime;
  line?: PackingQueueLine;
  job?: PackJobReport;
  note?: MaintenanceNote;
  invoice?: PackerInvoiceSummary;
}

/**
 * Identifies an implementation to the consuming product's UI and logs.
 * Whatever adapter shape PAK-Q-001 settles on carries one of these.
 */
export interface PackingAdapterIdentity {
  readonly source: SuiteSource;
  readonly descriptor: SuiteAdapterDescriptor;
  readonly unsubscribe?: Unsubscribe;
}

// TODO(human): define the adapter surface PAK-Q-001 asks about.
//
// Everything above is the data. What is missing is the interface (or
// interfaces) through which it moves. Four operations exist, from the
// requirements:
//
//   read  — the dropzone's queue for today          (PAK-R-002, DZGO → SkyPerson)
//   write — report a completed pack job             (PAK-R-003, SkyPerson → DZGO)
//   write — raise a maintenance note on a rig       (PAK-R-004, SkyPerson → DZGO)
//   read  — the packer's invoices for a period      (PAK-R-005, DZGO → SkyPerson)
//
// PAK-Q-001 asks whether these belong on one adapter or several. Declare
// whichever you decide below — one `PackingQueueAdapter`, or a read adapter
// plus one or more write adapters. Use `PackingAdapterIdentity` for the
// `source`/`descriptor` fields, and `subscribe(listener: (event: PackingEvent)
// => void): Unsubscribe` for live updates, matching `InstructorRosterAdapter`
// in `./instructor.ts`.
//
// The mock generator in `../mocks/packing.js` fabricates every record type
// above already and will implement whatever you declare here.

