/**
 * Rig records — the Rigging App → DZGO.
 *
 * ## ⚠️ PROPOSED. Not agreed.
 *
 * Suite TBD-020 lists "Rigging App ↔ DZGO" as an undefined boundary, and the
 * open thread says only: *"define the DZGO ↔ Rigging boundary as a rig adapter
 * contract (rig records, reserve-repack and AAD dates, pack status — DZM-R-060's
 * shape) and have the Rigging App implement it."* That sentence is the whole
 * specification that exists. **Everything below is this session's proposal
 * drafted from DZGO's native `RigRecord` (`dzgo/src/domain/rigs.ts`), and needs
 * Kyle's sign-off before either side builds against it.**
 *
 * The mock generator in `../mocks/rig.js` is real and usable now regardless —
 * that is the point of drafting rather than waiting. If the shape changes, the
 * mock changes with it and nothing else does.
 *
 * ## What this boundary is actually for
 *
 * DZGO already stores `reserveRepackDue` and `aadServiceDue` on every rig. So
 * the naive reading — "the Rigging App tells DZGO when the reserve is due" —
 * describes something DZGO can already do, and would violate Rule 13 by making
 * a sibling load-bearing for a fact DZGO holds natively.
 *
 * What DZGO **cannot** know on its own is *who did the work and on what
 * authority*: which certificated rigger packed the reserve, their certificate
 * number, the seal symbol, what they found. A date typed at the front desk and
 * a date attested by the rigger who packed it are different facts, and only the
 * second one is worth anything when somebody asks. **This contract carries the
 * attestation, not the date.**
 *
 * So: DZGO keeps its own dates and keeps working with no Rigging App in
 * existence. Where the overlay is present, a rig's dates gain a provenance the
 * dropzone did not have to take on trust.
 *
 * ## DEC-024 applies with unusual force here
 *
 * **Dates are facts. "Airworthy" is a judgement, and no product in this suite
 * makes it.** There is deliberately no `airworthy: boolean` on this record and
 * there must never be one. A screen may show that a repack was done on a date
 * and that an airworthiness directive is outstanding; it may not conclude, in
 * software, that a rig may or may not be jumped. That conclusion belongs to a
 * certificated rigger and to the dropzone, and the moment a boolean claims it,
 * this suite has taken on the liability for every rig it ever displayed.
 */

import type {
  ISODate,
  ISODateTime,
  SuiteAdapterDescriptor,
  SuiteProvenance,
  SuiteSource,
  Unsubscribe,
} from './common.js';

/** Matches DZGO's native `RigKind` exactly. Sport rigs are the jumper's own. */
export type RigKind = 'tandem' | 'student' | 'sport' | 'rental';

/**
 * One reserve repack, as attested by the rigger who performed it.
 *
 * This is the record an FAA ramp check or an incident investigation asks for,
 * which is why every field is about *who and what*, not *whether*.
 */
export interface ReservePack {
  readonly packId: string;
  /** When the reserve was packed. The regulatory clock starts here. */
  readonly packedOn: ISODate;
  /** Next due date **as calculated by the rigger**, not by us. */
  readonly dueOn: ISODate;
  /** The rigger's name, as it appears on the packing data card. */
  readonly riggerName: string;
  /**
   * FAA (or national equivalent) rigger certificate number.
   *
   * **Treat as personal data.** It identifies an individual and appears on a
   * legal document. A consuming product displays it on a rig's detail view to
   * staff who need it and nowhere else — never in an export, a log line, or a
   * list view.
   */
  readonly riggerCertificate: string;
  /** Seal symbol pressed into the reserve closing loop. */
  readonly sealSymbol?: string;
  /** What the rigger noted. Free text, shown verbatim, never parsed for meaning. */
  readonly notes?: string;
}

/** An AAD service event. Manufacturers set their own intervals; we record, never compute. */
export interface AadService {
  readonly serviceId: string;
  readonly model: string;
  readonly serialNumber?: string;
  readonly servicedOn: ISODate;
  /** Next service due **per the manufacturer's schedule**, as recorded by the rigger. */
  readonly dueOn?: ISODate;
  /** Battery replacement, if this visit included one. */
  readonly batteryReplacedOn?: ISODate;
}

/**
 * An outstanding manufacturer service bulletin or airworthiness directive.
 *
 * Carried because a dropzone genuinely cannot find these out on its own, and
 * because a grounded component is the single most consequential thing a rigger
 * knows that manifest does not.
 *
 * Note what this type does NOT say: it does not say the rig is unjumpable. It
 * says a bulletin exists, applies, and has or has not been complied with. The
 * judgement stays with a person.
 */
export interface OutstandingBulletin {
  readonly bulletinId: string;
  /** Manufacturer's own reference, e.g. "SB-2024-03". */
  readonly reference: string;
  readonly issuedOn: ISODate;
  /** Which component it applies to: container, reserve, main, AAD, harness. */
  readonly component: string;
  /** The manufacturer's own summary line. Shown verbatim. */
  readonly summary: string;
  readonly compliedOn?: ISODate;
}

/**
 * What the Rigging App can add about one rig.
 *
 * Keyed to DZGO's rig by `scanCode` rather than by id: the two products have
 * no shared identifier space and must never be given one (DEC-046 forbids the
 * database arrow that would create it). The scan code is physically on the rig
 * and both products already read it, which makes it the only honest join.
 */
export type RigServiceRecord = SuiteProvenance & {
  /** The code on the rig's label. The join key. */
  scanCode: string;
  /** Manufacturer serial, where the rigger recorded one. */
  serial?: string | null;
  kind: RigKind;
  /** Most recent first. A rig with no recorded repack has an empty list, not a null. */
  reservePacks: ReservePack[];
  aadServices: AadService[];
  /** Bulletins that apply and are not recorded as complied with. */
  outstandingBulletins: OutstandingBulletin[];
  /** When the Rigging App last touched this rig's record. */
  updatedAt: ISODateTime;
};

export type RigEventType = 'rig.reserve_packed' | 'rig.aad_serviced' | 'rig.bulletin_issued' | 'rig.updated';

export interface RigEvent {
  type: RigEventType;
  at: ISODateTime;
  record: RigServiceRecord;
}

/**
 * The overlay interface DZGO consumes.
 *
 * Every method may throw `SiblingUnreachableError`. DZGO catches it by type and
 * shows its own native rig records unchanged — which is Rule 13 in one
 * sentence.
 */
export interface RigServiceAdapter {
  readonly source: SuiteSource;
  readonly descriptor: SuiteAdapterDescriptor;
  /** Service records for the rigs the dropzone asks about, by scan code. */
  getForRigs(scanCodes: readonly string[]): Promise<RigServiceRecord[]>;
  getRig(scanCode: string): Promise<RigServiceRecord | null>;
  subscribe(listener: (event: RigEvent) => void): Unsubscribe;
}

/** The most recent reserve pack, or undefined. Sorting is the adapter's job, so this trusts order. */
export function latestReservePack(record: RigServiceRecord): ReservePack | undefined {
  return record.reservePacks[0];
}

/**
 * Bulletins with no recorded compliance date.
 *
 * Returns the bulletins, not a verdict — see the DEC-024 note at the top of
 * this file. The caller decides what to show; nothing here decides what it means.
 */
export function uncompliedBulletins(record: RigServiceRecord): OutstandingBulletin[] {
  return record.outstandingBulletins.filter((b) => b.compliedOn === undefined);
}
