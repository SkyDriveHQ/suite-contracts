/**
 * Waiver — SkyWaiver → any host app (DZGO and the Rigging App first).
 *
 * ## ⚠️ PROPOSED
 *
 * Kyle, 2026-10-01 (DEC-165, part 2): the waiver engine follows the booking engine out of DZGO and
 * becomes its own product, SkyWaiver, that any app can plug into. This file is the boundary a host reads
 * it through. Safe to build a mock against; unsafe to build a real feed against until SkyWaiver serves it.
 *
 * ## Sport-neutral by construction
 *
 * DZGO's own waiver record hard-codes skydiving: a fixed category list (tandem, student, fun jumper…),
 * USPA licence fields and a weight. Here the category is the **pack's** string and every sport-specific
 * answer (a licence number, ratings, a weight) lives in `fields`, keyed by the pack. A host that needs a
 * skydiving field reads it by the pack's key and treats a missing key as "not asked".
 *
 * ## What a waiver proves, and how a host checks it
 *
 * A waiver SkyWaiver witnessed carries `signature`: the SHA-256 fingerprint of the exact text the signer
 * saw, what they typed, that they ticked "I intend this as my signature", and who signed (the
 * participant, or a guardian for a minor). A paper or imported waiver has no signature: its evidence is
 * the paper, or the system it came from, and the record says so instead of pretending. The fingerprint
 * itself is checked by the waiver client (Web Crypto), not here: this package performs no I/O.
 *
 * ## The host decides what blocks
 *
 * SkyWaiver reports facts (`status`: valid, lapsed, awaiting confirmation, superseded). Whether a missing
 * or lapsed waiver blocks check-in is the host's rule (in DZGO, a hard block; Kyle, DZM-Q-057).
 *
 * ## Every waiver is checked against ID in person (v0.5.0)
 *
 * Kyle's rule (Ops abc8a464): "All waivers signed in any way must by checked against ID in person and
 * confirmed to match the person to the waiver." So no waiver, from any channel (kiosk, link, poster,
 * paper, import or vendor), is `valid` until staff have checked the person's ID in person and recorded
 * that it matches. `idCheck` on the summary says who did that and when. A host that enforces the rule
 * fails closed: a waiver whose `idCheck` is `null` or absent is not confirmed against ID, whatever its
 * `status` says.
 *
 * ## Rule 13 and the mirror rule
 *
 * SkyWaiver is an optional overlay. A host keeps its own waivers (DZGO: native, paper, imported) as its
 * native path, copies SkyWaiver's into its own tables, and keeps matching them to bookings itself. Every
 * adapter method throws `SiblingUnreachableError('waiver')` when SkyWaiver can't be reached. A waiver is
 * never invented in SkyWaiver's place.
 */

import type { ISODate, ISODateTime, PersonName, SuiteAdapterDescriptor, SuiteProvenance, SuiteSource, Unsubscribe } from './common.js';

/** One place an operator collects waivers, as a host lists it under "Connect waivers". */
export interface WaiverSiteRef {
  siteId: string;
  operatorId: string;
  name: string;
  /** IANA zone. Every `ISODateTime` below is an instant; render it in this zone. */
  timezone: string;
  /**
   * Under this age a participant needs a guardian to sign. **The site's jurisdiction setting, never a
   * fixed 18**: it differs between countries and some states.
   */
  ageOfMajority: number;
  /** Which pack defines this site's categories and fields, e.g. `skydiving`. */
  packId: string;
  packVersion: string;
}

export interface WaiverParticipant {
  name: PersonName;
  dateOfBirth: ISODate | null;
  /** Under the site's age of majority on the day signed. `null` when no date of birth was given. */
  minorOnSigningDay: boolean | null;
  email: string | null;
  phone: string | null;
  /**
   * A paper waiver recorded with no date of birth: staff confirmed the signed paper shows an adult.
   * Absent on every other waiver.
   */
  adultConfirmedByStaff?: boolean;
}

/** Present when the participant is a minor: the guardian is the actual signer. */
export interface WaiverGuardian {
  name: PersonName;
  relationship: string;
  phone: string | null;
  email: string | null;
  signedAt: ISODateTime;
}

/** Evidence of a signature SkyWaiver itself witnessed. `null` on paper, imported and vendor waivers. */
export interface WaiverSignature {
  /** SHA-256 hex of the exact template text shown to the signer. The template version's identity. */
  docHash: string;
  /** What the signer typed, verbatim. */
  typedName: string;
  /** The signer ticked an explicit "I intend this as my signature" box. Without it, it is not a signature. */
  intentConfirmed: boolean;
  signedBy: 'participant' | 'guardian';
  /** Weak evidence, kept because it is free and occasionally decisive. */
  userAgent: string | null;
}

/** How it was signed. */
export type WaiverChannel = 'kiosk' | 'link' | 'poster' | 'paper' | 'import' | 'vendor';

/**
 * What SkyWaiver says about it now. `valid`: signed, in date, and confirmed by staff against the person's
 * ID in person (see `idCheck`). `lapsed`: past the operator's validity. `awaiting-confirmation`: signed,
 * but nobody at the desk has yet checked the person's ID in person and matched them to the waiver. Under
 * Kyle's rule this applies to **every** waiver from **every** channel, not only remote ones: each one
 * waits here until the ID check is recorded. `superseded`: a correction replaced it (`supersededBy`).
 */
export type WaiverStatus = 'valid' | 'lapsed' | 'awaiting-confirmation' | 'superseded';

/**
 * A member of staff checked the person's ID in person and confirmed it matches the person named on the
 * waiver. Recorded by the producer (SkyWaiver) at the moment the check is done.
 */
export interface WaiverIdCheck {
  /** Who checked: the staff member's display name, or their id, as the producer knows them. */
  checkedBy: string;
  /** When the check was recorded. */
  checkedAt: ISODateTime;
  /** How it was checked. Only ever in person: Kyle's rule allows no other way. */
  method: 'in-person';
}

export type WaiverSummary = SuiteProvenance & {
  waiverId: string;
  siteId: string;
  /** The template version signed: its fingerprint-derived id. */
  templateId: string;
  templateTitle: string;
  /** The pack's category, e.g. `tandem` for skydiving or `passenger` for ballooning. */
  category: string;
  participant: WaiverParticipant;
  guardian: WaiverGuardian | null;
  /** Pack-defined answers (licence, ratings, a weight…). A question not asked is absent, never null or zero. */
  fields: Record<string, unknown>;
  channel: WaiverChannel;
  signedAt: ISODateTime;
  /** `null` = the operator's policy never lapses it. */
  expiresAt: ISODateTime | null;
  status: WaiverStatus;
  /** The booking this was signed for, when SkyWaiver knows it (a per-participant link). Never set by the signer. */
  linkedBookingId: string | null;
  linkedParticipantId: string | null;
  /** Poster signatures: people who signed one after another on one phone, so a desk shows them as a party. */
  signingSession: string | null;
  supersededBy: string | null;
  signature: WaiverSignature | null;
  /**
   * Whether staff have checked this person's ID in person against the waiver (v0.5.0).
   *
   * - **An object**: yes. Staff checked the ID in person and matched the person to the waiver; it says
   *   who and when.
   * - **`null`**: not yet. The producer follows the rule and is saying plainly that nobody has checked.
   * - **Absent**: the producer was built before this field existed and cannot say. A host must treat
   *   that exactly like `null` (not checked) and fail closed, never assume a check happened.
   *
   * A `valid` waiver from a producer that follows Kyle's rule always carries an object here. That is how
   * a host tells a `valid` confirmed against ID from one written before the rule.
   *
   * Optional, rather than required, so that producers built against v0.4 still compile against this
   * version; a later major version may make it required. With `exactOptionalPropertyTypes` on, the key is
   * either left out or holds an object or `null`; it never holds `undefined`.
   */
  idCheck?: WaiverIdCheck | null;
  /** Only ever increases. A mirror keeps the copy with the highest version (`isNewerThan` in booking.ts). */
  version: number;
  updatedAt: ISODateTime;
};

/** How a host finds a person's waiver. Any combination; SkyWaiver matches the strongest it has. */
export interface WaiverLookup {
  bookingId?: string;
  participantId?: string;
  email?: string;
  name?: PersonName;
  dateOfBirth?: ISODate;
}

interface EventBase {
  eventId: string;
  siteId: string;
  at: ISODateTime;
}

/** Everything SkyWaiver tells a host, by signed webhook (the same signature format as SkyBook's). */
export type WaiverWebhookEvent =
  | (EventBase & { type: 'waiver.signed'; waiver: WaiverSummary })
  /** Staff recorded the in-person ID check: the waiver is now `valid` and carries `idCheck`. */
  | (EventBase & { type: 'waiver.confirmed'; waiver: WaiverSummary })
  | (EventBase & { type: 'waiver.corrected'; waiver: WaiverSummary; supersedes: string });

export type WaiverWebhookEventType = WaiverWebhookEvent['type'];

/**
 * The host-facing adapter. Every method throws `SiblingUnreachableError('waiver')` when SkyWaiver can't
 * be reached; the host falls back to its own waivers.
 */
export interface WaiverEngineAdapter {
  readonly source: SuiteSource;
  readonly descriptor: SuiteAdapterDescriptor;

  listSites(): Promise<WaiverSiteRef[]>;
  /** Every waiver at the site that matches, newest first, superseded ones included (status tells them apart). */
  findForParticipant(siteId: string, lookup: WaiverLookup): Promise<WaiverSummary[]>;
  getWaiver(waiverId: string): Promise<WaiverSummary | null>;
  /** For mirroring: everything changed at the site since an instant. */
  listChangedSince(siteId: string, since: ISODateTime): Promise<WaiverSummary[]>;
  subscribe(listener: (event: WaiverWebhookEvent) => void): Unsubscribe;
}

/**
 * The waivers SkyWaiver reports as current for a person: valid, and not superseded.
 *
 * This looks at `status` only, as it did before v0.5.0; it does not look at `idCheck`. A host that
 * enforces Kyle's in-person ID rule must also require `idCheck` to be an object, and treat `null` or a
 * missing field as not checked.
 */
export function usableWaivers(waivers: readonly WaiverSummary[]): WaiverSummary[] {
  return waivers.filter((w) => w.status === 'valid');
}
