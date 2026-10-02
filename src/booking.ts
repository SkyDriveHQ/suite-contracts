/**
 * Booking — SkyBook → any host app (DZGO first), plus the few writes a host's
 * desk makes back: reschedule, status (cancel / no-show) and attendance.
 *
 * ## ⚠️ PROPOSED
 *
 * Kyle, 2026-10-01 (DEC-165): the booking engine leaves DZGO and becomes its
 * own product, SkyBook, that "can plug into dzgo or any app or software that
 * wants to use it", skydiving first and sport-neutral underneath. This file is
 * the boundary any host reads it through. It is safe to build a mock against
 * and unsafe to build a real feed against until SkyBook serves it.
 *
 * ## Sport-neutral by construction
 *
 * Nothing here knows about skydiving. What a participant must declare (a
 * booked weight, a language they need briefing in, a basket weight for a
 * balloon flight) lives in `BookingParticipant.fields`, whose keys are defined
 * by the site's **pack** (`BookingSiteRef.packId`). Offering kinds, resource
 * kinds and change causes are likewise the pack's strings, not a union here.
 * A host that needs a skydiving field reads it by the pack's key and treats a
 * missing key as "not asked", never as zero.
 *
 * ## The mirror rule (SKB-R-016)
 *
 * A host's desk must keep working with SkyBook unreachable and with no
 * network. So a host **copies** what its desk needs (bookings, voucher
 * balances, online prices) into its own tables on connect and on every event,
 * and reads its copy at the moment of use. Every record carries a `version`
 * that only ever increases; `isNewerThan` is the one comparison a mirror
 * needs, so a late or replayed event can never overwrite a newer copy.
 *
 * ## Rule 13
 *
 * SkyBook is an optional overlay. DZGO keeps desk-typed bookings, walk-ins and
 * vendor feeds as its native path and works fully without SkyBook. Every
 * adapter method throws `SiblingUnreachableError('booking')` when SkyBook can't
 * be reached, and the consumer carries on with its own records. Nothing is
 * ever invented in SkyBook's place.
 *
 * ## Money
 *
 * Integer minor units with an ISO 4217 currency, as everywhere in the suite.
 * Card numbers never cross this boundary: a card on file is a brand and last
 * four only.
 */

import type {
  ISODate,
  ISODateTime,
  PersonName,
  SuiteAdapterDescriptor,
  SuiteProvenance,
  SuiteSource,
  Unsubscribe,
} from './common.js';

/** One bookable place an operator runs, as a host lists it under "Connect bookings". */
export interface BookingSiteRef {
  siteId: string;
  /** The business that owns the site. One operator may run several sites. */
  operatorId: string;
  name: string;
  /** Public link path segment: `/book/<slug>`. */
  slug: string;
  /** IANA zone. Every `ISODateTime` below is an instant; render it in this zone. */
  timezone: string;
  /** ISO 4217, e.g. `USD`. */
  currency: string;
  /** Which pack defines this site's vocabulary and participant fields, e.g. `skydiving`. */
  packId: string;
  packVersion: string;
}

/** A resource a slot consumes. `kind` is the pack's word (`aircraft`, `instructor`, `balloon`…). */
export interface ResourceRef {
  resourceId: string;
  kind: string;
  name: string;
}

/** What was sold. `kind` is the pack's offering kind (`tandem`, `aff`, `standard-flight`…). */
export interface OfferingRef {
  offeringId: string;
  kind: string;
  name: string;
}

/**
 * One person on a booking. A family of four under one payer is one booking
 * with four participants.
 */
export interface BookingParticipant {
  participantId: string;
  name: PersonName;
  dateOfBirth: ISODate | null;
  email: string | null;
  phone: string | null;
  /**
   * Pack-defined answers, keyed by the pack's field ids. For the skydiving
   * pack: `bookedWeightLbs` (number), `requiresTranslation` (language string,
   * or absent when none is needed). A key the pack did not ask is absent, not
   * null and not zero.
   */
  fields: Record<string, unknown>;
  /** Per-participant arrival, written by the host's desk. `null` = not arrived. */
  arrivedAt: ISODateTime | null;
}

export type BookingStatus = 'confirmed' | 'cancelled' | 'no-show';

export interface BookingAddOn {
  /** Pack-defined code, e.g. `video`. */
  code: string;
  label: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface CardOnFileSummary {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface BookingPaymentSummary {
  currency: string;
  totalMinor: number;
  paidMinor: number;
  /** `totalMinor - paidMinor`, never negative. `paymentProblems` checks it. */
  outstandingMinor: number;
  /** Deposits are captured, not held (SKB-R-008). */
  depositCapturedMinor: number;
  /** When the off-session balance charge is due, if one is scheduled (T-48h by default). */
  balanceDueAt: ISODateTime | null;
  cardOnFile: CardOnFileSummary | null;
  /** Value taken from vouchers, already inside `paidMinor`. */
  voucherAppliedMinor: number;
}

export type AttendanceAnswer = 'coming' | 'late' | 'not-coming';

export interface BookingAttendance {
  answer: AttendanceAnswer;
  /** Minutes late, when `answer` is `late`. */
  etaMinutes: number | null;
  answeredAt: ISODateTime;
  /** Who answered: the customer on the self-service page, or the operator's desk. */
  answeredBy: 'customer' | 'operator';
}

export type BookingSummary = SuiteProvenance & {
  bookingId: string;
  /** Human-facing reference, read out on the phone. */
  reference: string;
  siteId: string;
  offering: OfferingRef;
  /** The operator's local calendar day the slot falls on. */
  activityDate: ISODate;
  slotStart: ISODateTime;
  slotEnd: ISODateTime | null;
  status: BookingStatus;
  primaryContact: { name: PersonName; email: string | null; phone: string | null };
  participants: BookingParticipant[];
  addOns: BookingAddOn[];
  /** Ties bookings that arrive together under one organiser. `null` when solo. */
  groupRef: string | null;
  payment: BookingPaymentSummary;
  /** `null` = nobody has answered, which is a different state from any answer. */
  attendance: BookingAttendance | null;
  /** Only ever increases. A mirror keeps the copy with the highest version (`isNewerThan`). */
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type ChangeAction = 'moved' | 'cancelled' | 'no-show' | 'settled';
export type ChangeInitiator = 'customer' | 'operator';
/** Which policy line applied. `waived` covers a fee waived by a scrub, not by a person. */
export type ChangePolicyRule = 'free' | 'late-cancellation' | 'no-show' | 'waived' | 'not-applicable';
export type ChangeMoneyOutcome = 'none' | 'refund' | 'credit' | 'kept' | 'pending-choice';

/** One append-only entry in a booking's change-of-plan ledger (SKB-R-017). */
export interface BookingChangeEvent {
  changeId: string;
  bookingId: string;
  action: ChangeAction;
  initiator: ChangeInitiator;
  /** Pack-defined cause, e.g. `weather`, `aircraft`, `customer-request`. */
  cause: string;
  policyRule: ChangePolicyRule;
  moneyOutcome: ChangeMoneyOutcome;
  /** The amount the outcome moved, minor units; 0 for `none`. */
  amountMinor: number;
  /** Set for `moved`: where the booking was before. */
  fromSlotStart: ISODateTime | null;
  at: ISODateTime;
}

export type VoucherStatus = 'active' | 'spent' | 'void';

/** A voucher is stored value, never a product entitlement (SKB-R-010). */
export type VoucherBalance = SuiteProvenance & {
  voucherId: string;
  siteId: string;
  /** Last four characters only; the full code never crosses this boundary. */
  codeHint: string;
  currency: string;
  issuedMinor: number;
  balanceMinor: number;
  status: VoucherStatus;
  version: number;
  updatedAt: ISODateTime;
};

interface EventBase {
  eventId: string;
  siteId: string;
  at: ISODateTime;
}

/**
 * Everything SkyBook tells a host, by webhook (HMAC-signed) or realtime.
 * The same union, so a host handles both with one function.
 */
export type BookingWebhookEvent =
  | (EventBase & { type: 'booking.created'; booking: BookingSummary })
  | (EventBase & { type: 'booking.updated'; booking: BookingSummary })
  | (EventBase & { type: 'booking.cancelled'; booking: BookingSummary; change: BookingChangeEvent })
  | (EventBase & { type: 'booking.rescheduled'; booking: BookingSummary; change: BookingChangeEvent })
  | (EventBase & { type: 'booking.attendance'; booking: BookingSummary })
  | (EventBase & { type: 'voucher.issued'; voucher: VoucherBalance })
  | (EventBase & { type: 'voucher.redeemed'; voucher: VoucherBalance; bookingId: string; amountMinor: number })
  | (EventBase & {
      type: 'payment.captured' | 'payment.refunded';
      bookingId: string;
      kind: 'deposit' | 'balance' | 'policy-charge' | 'refund';
      amountMinor: number;
      currency: string;
    })
  | (EventBase & {
      type: 'day.scrubbed';
      date: ISODate;
      /** `null` = the whole day. */
      from: ISODateTime | null;
      to: ISODateTime | null;
      cause: string;
      affectedBookingIds: string[];
    });

export type BookingWebhookEventType = BookingWebhookEvent['type'];

export interface RescheduleRequest {
  toSlotStart: ISODateTime;
  initiator: ChangeInitiator;
  /** Pack-defined cause. */
  cause: string;
  /** The version the caller read. A stale one is refused rather than overwritten. */
  expectedVersion: number;
}

export interface StatusRequest {
  status: 'cancelled' | 'no-show';
  initiator: ChangeInitiator;
  cause: string;
  expectedVersion: number;
}

export interface AttendanceRequest {
  answer: AttendanceAnswer;
  etaMinutes?: number;
  expectedVersion: number;
}

/** Thrown when `expectedVersion` is behind SkyBook's copy. The caller re-reads; nothing was written. */
export class BookingVersionConflictError extends Error {
  readonly bookingId: string;
  readonly currentVersion: number;
  constructor(bookingId: string, currentVersion: number) {
    super(`booking ${bookingId} has moved on to version ${currentVersion}`);
    this.name = 'BookingVersionConflictError';
    this.bookingId = bookingId;
    this.currentVersion = currentVersion;
  }
}

/**
 * The host-facing adapter. Every method throws `SiblingUnreachableError('booking')`
 * when SkyBook can't be reached; the host falls back to its own mirrored copy.
 */
export interface BookingEngineAdapter {
  readonly source: SuiteSource;
  readonly descriptor: SuiteAdapterDescriptor;

  /** Sites the signed-in user is a member of, for "Connect bookings". */
  listSites(): Promise<BookingSiteRef[]>;
  /** Every booking on `date` at `siteId`, cancelled ones included. */
  getDay(siteId: string, date: ISODate): Promise<BookingSummary[]>;
  getBooking(bookingId: string): Promise<BookingSummary | null>;
  getVoucher(siteId: string, voucherId: string): Promise<VoucherBalance | null>;

  reschedule(bookingId: string, request: RescheduleRequest): Promise<BookingSummary>;
  updateStatus(bookingId: string, request: StatusRequest): Promise<BookingSummary>;
  recordAttendance(bookingId: string, request: AttendanceRequest): Promise<BookingSummary>;

  subscribe(listener: (event: BookingWebhookEvent) => void): Unsubscribe;
}

/**
 * The mirror's one comparison: should `incoming` replace `existing`?
 *
 * True when there is no copy yet or `incoming` is strictly newer. An equal
 * version is a replay and is ignored, so delivering an event twice is harmless.
 */
export function isNewerThan(
  incoming: { version: number },
  existing: { version: number } | null | undefined,
): boolean {
  return !existing || incoming.version > existing.version;
}

/**
 * What is wrong with a payment summary's arithmetic, in words. Empty when it
 * adds up. A mirror runs this before storing, because a summary that does not
 * add up is a bug on the sending side and must not reach a till.
 */
export function paymentProblems(p: BookingPaymentSummary): string[] {
  const out: string[] = [];
  const ints: Array<[string, number]> = [
    ['totalMinor', p.totalMinor],
    ['paidMinor', p.paidMinor],
    ['outstandingMinor', p.outstandingMinor],
    ['depositCapturedMinor', p.depositCapturedMinor],
    ['voucherAppliedMinor', p.voucherAppliedMinor],
  ];
  for (const [name, v] of ints) {
    if (!Number.isInteger(v) || v < 0) out.push(`${name} must be a whole, non-negative number of minor units`);
  }
  if (p.outstandingMinor !== Math.max(0, p.totalMinor - p.paidMinor)) {
    out.push('outstandingMinor does not equal totalMinor minus paidMinor');
  }
  if (p.depositCapturedMinor + p.voucherAppliedMinor > p.paidMinor) {
    out.push('deposit plus voucher value is more than what was paid');
  }
  return out;
}
