/**
 * Packing queue and pack jobs — SkyPerson (packer role) ↔ DZGO.
 *
 * ## ⚠️ PROPOSED, and the adapter surface is an open question by name.
 *
 * `SKYPERSON-MASTER.md` §15.3 tracks the adapter shape as **PAK-Q-001**. It is
 * answered (Rule zero, 2026-10-15): separate read and write adapters, declared
 * at the bottom of this file as `PackingQueueReadAdapter` and
 * `PackingWriteAdapter`. This file defines the **records** that cross the
 * boundary and those two interfaces.
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
 * Both packing adapters carry its `source` and `descriptor`.
 */
export interface PackingAdapterIdentity {
  readonly source: SuiteSource;
  readonly descriptor: SuiteAdapterDescriptor;
  readonly unsubscribe?: Unsubscribe;
}

/**
 * What the dropzone sends SkyPerson: the day's queue, the packer's invoices, and
 * live updates. DZGO is the source of record (PAK-R-002, PAK-R-005), so every
 * method here moves data from DZGO to SkyPerson.
 *
 * **Two interfaces, not one (PAK-Q-001, answered under Rule zero 2026-10-15:
 * "separate read and write adapters").** Direction is structural. A thing that
 * is handed only this interface cannot write, and a thing handed only
 * `PackingWriteAdapter` cannot read the queue.
 */
export interface PackingQueueReadAdapter extends Pick<PackingAdapterIdentity, 'source' | 'descriptor'> {
  /** The dropzone's queue for `day`, shortest-staffed line first. */
  getQueue(day: ISODate): Promise<PackingQueueLine[]>;
  /** The packer's invoices, which DZGO already produced (PAK-R-005). Dropzone work only. */
  getInvoices(): Promise<PackerInvoiceSummary[]>;
  /** Queue changes, recorded jobs, raised notes and issued invoices, as they happen. */
  subscribe(listener: (event: PackingEvent) => void): Unsubscribe;
}

/**
 * What SkyPerson sends the dropzone: a completed pack job (PAK-R-003) and a
 * maintenance note (PAK-R-004).
 *
 * **There is no way to list jobs here, and no way to report a sport-rig job.**
 * DZM-Q-042 keeps sport-rig work off DZGO entirely, and whether a dropzone may
 * ever see it is PAK-Q-003, still Kyle's call. So `recordPackJob` takes a
 * `FleetKind`, which excludes `sport`, and neither interface carries a sport-job
 * list. A packer's own sport jobs live in SkyPerson and are not part of this
 * boundary; reaching them is a SkyPerson-internal matter, not something an
 * adapter handed to DZGO can do.
 */
export interface PackingWriteAdapter extends Pick<PackingAdapterIdentity, 'source' | 'descriptor'> {
  /** Report a completed pack job on a dropzone-owned rig. */
  recordPackJob(scanCode: string, kind: FleetKind): Promise<PackJobReport>;
  /** Raise a maintenance note on a rig. Always also kept as a private note in SkyPerson. */
  raiseNote(scanCode: string, text: string): Promise<MaintenanceNote>;
}
