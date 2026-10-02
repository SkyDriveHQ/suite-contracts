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
 * **Components (v0.3.0) have a different, firmer source.** `RigComponent` is
 * not drafted from DZGO, which has no per-component record yet. It is drafted
 * from the Rigging App's own `components` table (kind, manufacturer, model,
 * serial number, date of manufacture) and from DZGO's gear design §3 ("a rig
 * is an assembly", `DZGO/docs/for-humans/gear-design-v1.2.0.md`), which
 * proposes that DZGO mirror that table "closely enough that a sync is a
 * mapping rather than a translation". The contract as a whole is still
 * PROPOSED; the component shape is the part with a shipped schema behind it.
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
 * The four parts of a rig that carry their own serial and date of manufacture.
 *
 * Lower-case to match the Rigging App's `components.kind` exactly, so the feed
 * passes the value through rather than translating it. That table also allows
 * `'other'` (pilot chutes, sliders, odd parts); those are deliberately not part
 * of this boundary. The harness is part of the container, as it is on a data
 * card: a container's serial is the harness/container serial.
 */
export type RigComponentKind = 'container' | 'main' | 'reserve' | 'aad';

/**
 * A date of manufacture **at the precision it is actually known**.
 *
 * Not an `ISODate`. Manufacturers stamp a DOM to the day, to the month, or (on
 * a Vigil) to the week, and the Rigging App stores exactly what the label says
 * rather than inventing a day it does not know (its migration 0032). The three
 * forms, all lexically sortable:
 *
 * - `YYYY-MM-DD` — known to the day.
 * - `YYYY-MM` — known to the month. The common case.
 * - `YYYY-Www` — known to the ISO week, e.g. `2019-W23`. Vigil AADs.
 *
 * A consumer that needs a day (an AAD's end of life, say) must decide for
 * itself how to round a month or a week, and must say so where it shows the
 * result. Nothing in this package parses or rounds it.
 */
export type DateOfManufacture = string;

/**
 * One installed component of a rig: what it is, and the identity printed on it.
 *
 * This is **what the rig is made of**, not what was done to it. Service history
 * stays where it already is: a reserve's repacks in `ReservePack`, an AAD's
 * services and battery in `AadService`. A component carries the facts that do
 * not change while it stays in this rig, which is what lets a dropzone answer
 * "do we have any reserves from that serial range on the field?" when a
 * bulletin arrives (gear design §2).
 *
 * `serialNumber` and `dateOfManufacture` are both **required keys that may be
 * null**: the rigger may not have recorded them, and the Rigging App's columns
 * are nullable. The feed must say "not recorded" with a null rather than by
 * leaving the field out, so an unknown serial is visible as unknown.
 */
export interface RigComponent {
  /** The Rigging App's own id for the component. Stable while it exists there. */
  readonly componentId: string;
  readonly kind: RigComponentKind;
  /** As the rigger recorded it, e.g. "Sun Path" or "Airtec". */
  readonly manufacturer: string | null;
  /** As the rigger recorded it, e.g. "Javelin Odyssey" or "Cypres 2". */
  readonly model: string | null;
  /** As printed on the component. Shown verbatim, never normalised here. */
  readonly serialNumber: string | null;
  readonly dateOfManufacture: DateOfManufacture | null;
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
  /**
   * The rig's serial: **the installed container's serial** (the
   * harness/container serial on the rig's own label), or null when the rigger
   * has not recorded one. Never the AAD's or any other part's: an AAD moves
   * between rigs at service and swap, and a rig named by it would change
   * identity when it did. Every part's own serial, the container's included,
   * also travels in `components`.
   *
   * Decided 2026-10-02 (v0.4.0), under Kyle's standing "go with recommended",
   * and reversible. Doc only; the type is unchanged.
   */
  serial?: string | null;
  kind: RigKind;
  /**
   * What the rig is made of: its container, main, reserve and AAD as they are
   * installed now, normally one of each kind. No order is promised; find a
   * component by its `kind`, not its position. **Required, and an
   * empty list rather than a null** when the rigger has recorded no
   * components. A rig with no AAD simply has no `'aad'` entry. Retired
   * components are not sent; a component that moved to another rig appears
   * under that rig.
   */
  components: RigComponent[];
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
