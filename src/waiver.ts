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
 * `status` says. `usableWaiversCheckedInPerson` does exactly that.
 *
 * ## v0.6.0: the desk check from a host, webhooks, and the smart-waiver facts
 *
 * - **A desk check made in a host reaches SkyWaiver** (`confirmIdCheck`). The adapter is bound to the
 *   signed-in staff member's own shared-login session, and that person must be on the SkyWaiver site's staff
 *   list: the check is recorded against them, exactly as at SkyWaiver's own desk. No host secret can confirm
 *   a waiver. A shared desk login says who actually checked in `attestedBy`. Repeating a call is safe.
 * - **"Awaiting confirmation" is said one way everywhere**: `WAIVER_STATUS_WORDS`, in the words of Kyle's rule.
 * - **Webhooks are signed the way SkyBook's are**: `SkyWaiver-Signature: t=<unix seconds>,v1=<hex>`, the
 *   HMAC-SHA256 of `"<t>.<raw body>"` with the connection's secret, checked within 300 seconds. This package
 *   names the format and parses the header; the waiver client does the cryptography (Web Crypto).
 *   `waiver.updated` is new: a walk-up waiver matched at the desk, a medical clearance recorded, or a consent
 *   withdrawn.
 * - **The smart-waiver facts (V8)**: `needs-clearance` (a YES to a health question that needs a doctor's
 *   clearance: the person signs, and takes part only once staff record the clearance), the initials on each
 *   clause that asks for them (inside `signature`), an emergency contact, consents such as photos or
 *   marketing (each asked, never assumed, and withdrawable), and the language signed in. Each is **absent**
 *   when it was not asked, never null, as `fields` already is.
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
  /**
   * The signer's initials on each clause that asked for them, by the clause's id (v0.6.0). Part of the
   * signature evidence, so as final as the rest of it. Absent when the text asked for no initials.
   */
  initials?: Record<string, string>;
}

/** How it was signed. */
export type WaiverChannel = 'kiosk' | 'link' | 'poster' | 'paper' | 'import' | 'vendor';

/**
 * What SkyWaiver says about it now, first match wins:
 *
 * - `superseded`: a correction replaced it (`supersededBy`).
 * - `lapsed`: past the operator's validity.
 * - `needs-clearance` (v0.6.0): the person answered YES to a health question that needs a doctor's
 *   clearance. They have signed; they take part only once staff record the clearance (`clearance`).
 * - `awaiting-confirmation`: signed, but nobody has yet checked the person's ID in person and confirmed it
 *   matches the person on the waiver. Kyle's rule: **"All waivers signed in any way must be checked against
 *   ID in person and confirmed to match the person to the waiver."** So this is every waiver, from every
 *   channel (kiosk, link, poster, paper, import, vendor), until the check is recorded; no setting skips it.
 * - `valid`: signed, in date, cleared if it needed clearing, and confirmed against ID in person (`idCheck`).
 *
 * Only `valid` lets a person take part. A host built before v0.6.0 that keeps only `valid` waivers therefore
 * already treats `needs-clearance` as not usable: it fails closed.
 */
export type WaiverStatus = 'valid' | 'lapsed' | 'needs-clearance' | 'awaiting-confirmation' | 'superseded';

/**
 * How every host says each status to staff (v0.6.0), so "awaiting confirmation" means the same thing on
 * every screen: the in-person ID check, for every waiver.
 */
export const WAIVER_STATUS_WORDS: Readonly<Record<WaiverStatus, string>> = {
  valid: 'Valid',
  lapsed: 'Lapsed',
  'needs-clearance': 'Needs medical clearance',
  'awaiting-confirmation': 'Awaiting ID check in person',
  superseded: 'Replaced by a correction',
};

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

/** Someone the signer named to call in an emergency (v0.6.0). */
export interface WaiverEmergencyContact {
  name: string;
  phone: string;
  relationship: string | null;
}

/** One consent the signer was asked for (photos, marketing…), as they answered it (v0.6.0). */
export interface WaiverConsent {
  /** What they answered when they signed. Never pre-ticked: every consent is asked. */
  given: boolean;
  /** When staff recorded that they withdrew it. `null` while it stands. */
  withdrawnAt: ISODateTime | null;
}

/** A waiver that needs a medical clearance before the person takes part (v0.6.0). */
export interface WaiverClearance {
  required: true;
  /** The health questions answered YES that need it, by id. Empty when staff recorded it from paper. */
  flaggedQuestions: string[];
  /** Who recorded the clearance, and when. `null` until they do; the status is then `needs-clearance`. */
  cleared: { clearedBy: string; clearedAt: ISODateTime } | null;
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
  /** The language of the text signed, e.g. `es` or `en` (v0.6.0). Absent when not known. */
  signingLanguage?: string;
  /** Absent when none was given (v0.6.0). */
  emergencyContact?: WaiverEmergencyContact;
  /** Every consent the text asked for, by its field id (v0.6.0). Absent when it asked for none. */
  consents?: Record<string, WaiverConsent>;
  /** Present only when a medical clearance is needed (v0.6.0). Absent: none is needed. */
  clearance?: WaiverClearance;
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

/** What a `waiver.updated` event reports (v0.6.0). */
export type WaiverChange = 'matched' | 'cleared' | 'consent-withdrawn';

/**
 * Everything SkyWaiver tells a host, by signed webhook (the same signature format as SkyBook's; see
 * `WAIVER_SIGNATURE_HEADER`). The body is this JSON exactly. `eventId` is the same on every retry of one
 * delivery: the idempotency key. Each event carries the whole waiver; a mirror keeps the highest `version`.
 */
export type WaiverWebhookEvent =
  /** A waiver was signed or recorded (kiosk, link, poster, paper, import). It arrives awaiting confirmation. */
  | (EventBase & { type: 'waiver.signed'; waiver: WaiverSummary })
  /** Staff recorded the in-person ID check: the waiver carries `idCheck` (and is `valid` unless it needs clearance). */
  | (EventBase & { type: 'waiver.confirmed'; waiver: WaiverSummary })
  /** A correction replaced the waiver `supersedes`, which is now `superseded`. The correction needs its own ID check. */
  | (EventBase & { type: 'waiver.corrected'; waiver: WaiverSummary; supersedes: string })
  /** Anything else that changed (v0.6.0): matched to a booking at the desk, cleared medically, or a consent withdrawn. */
  | (EventBase & { type: 'waiver.updated'; waiver: WaiverSummary; change: WaiverChange });

/** The header SkyWaiver signs every webhook with (v0.6.0). */
export const WAIVER_SIGNATURE_HEADER = 'SkyWaiver-Signature';
/** The header carrying the event's id, the same as the body's `eventId`. */
export const WAIVER_EVENT_ID_HEADER = 'SkyWaiver-Event-Id';
/** How far a signature's timestamp may be from now, either way, before a host refuses it. */
export const WAIVER_SIGNATURE_TOLERANCE_SECONDS = 300;

/** The string the HMAC-SHA256 is computed over: the timestamp, a dot, and the raw body exactly as received. */
export function waiverSignedContent(timestampSeconds: number, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`;
}

/**
 * Reads `t=<unix seconds>,v1=<64 hex>` (SkyBook's format). `null` when the header is missing or malformed;
 * the caller refuses the webhook. Checking the HMAC itself is the waiver client's job.
 */
export function parseWaiverSignatureHeader(header: string | null | undefined): { timestampSeconds: number; v1: string } | null {
  if (!header) return null;
  const parts = new Map<string, string>();
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) parts.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const t = parts.get('t');
  const v1 = parts.get('v1');
  if (t === undefined || !/^\d{1,12}$/.test(t) || v1 === undefined || !/^[0-9a-f]{64}$/.test(v1)) return null;
  return { timestampSeconds: Number(t), v1 };
}

/**
 * A desk check made in a host app, sent to SkyWaiver (v0.6.0).
 *
 * **Who may send it:** the staff member themself. The adapter is bound to their shared-login session, and
 * they must be on the SkyWaiver site's staff list; SkyWaiver records the check against them. A host's own
 * secret or service key cannot confirm a waiver.
 */
export interface WaiverIdCheckRequest {
  waiverId: string;
  /** The staff member's explicit statement that they checked the person's ID in person and it matches. */
  idCheckedInPerson: true;
  /** When the check was done, if not now: a host that was offline. At most 72 hours ago, never before signing. */
  checkedAt?: ISODateTime;
  /** The host's own name for who checked, when one login serves a shared desk device. At most 100 characters. */
  attestedBy?: string;
}

export type WaiverIdCheckResult =
  /** Recorded now. `waiver` carries the new `idCheck`. */
  | { result: 'confirmed'; waiver: WaiverSummary }
  /** It was already confirmed (perhaps by this same call, retried). Nothing new was recorded. */
  | { result: 'already-confirmed'; waiver: WaiverSummary }
  /** A correction replaced it; nothing was recorded. Check the correction (`waiver.supersededBy`). */
  | { result: 'superseded'; waiver: WaiverSummary }
  /**
   * Refused, with SkyWaiver's words for staff. `not-found`: no such waiver at a site this person is staff
   * at (also how "not on SkyWaiver's staff list" looks). `out-of-time`: `checkedAt` is ahead of now, before
   * the waiver was signed, or more than 72 hours ago: check the ID again. `invalid`: the request itself is not
   * acceptable (the host's connection is switched off, `attestedBy` is longer than 100 characters, or the
   * in-person statement is not `true`): fix the request or the connection. The host keeps its own record of
   * the check either way.
   */
  | { result: 'refused'; reason: 'not-found' | 'out-of-time' | 'invalid'; message: string };

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
  /** Record a desk check made in the host (v0.6.0). See `WaiverIdCheckRequest` for who may call it. */
  confirmIdCheck(request: WaiverIdCheckRequest): Promise<WaiverIdCheckResult>;
}

/**
 * The waivers SkyWaiver reports as current for a person: valid, and not superseded.
 *
 * This looks at `status` only, as it did before v0.5.0; it does not look at `idCheck`, so it still
 * returns a `valid` waiver written before Kyle's in-person ID rule. **A host that follows the rule uses
 * `usableWaiversCheckedInPerson` instead.**
 */
export function usableWaivers(waivers: readonly WaiverSummary[]): WaiverSummary[] {
  return waivers.filter((w) => w.status === 'valid');
}

/**
 * The waivers a host following Kyle's rule may treat as current for a person (v0.5.0): valid, not
 * superseded, **and** checked against the person's ID in person, so `idCheck` is an object. A waiver that
 * needs a medical clearance is not `valid` until it is cleared (v0.6.0), so it is left out too. A `null`
 * `idCheck` (not yet checked) or a missing one (a producer from before the field) counts as not
 * checked, and the waiver is left out: this fails closed.
 */
export function usableWaiversCheckedInPerson(waivers: readonly WaiverSummary[]): WaiverSummary[] {
  return usableWaivers(waivers).filter((w) => w.idCheck != null && w.idCheck.method === 'in-person');
}
