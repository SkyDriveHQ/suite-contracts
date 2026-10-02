/**
 * Mock `BookingEngineAdapter`: a stand-in for SkyBook, answering for two
 * fabricated sites on the scenario's day.
 *
 * **What it fabricates, and why each part exists:**
 * - **Two sites on two different packs** (skydiving and ballooning), so a host
 *   that hard-codes a skydiving field (a booked weight) shows the gap on the
 *   ballooning site instead of shipping it. Sport-neutral is the whole point of
 *   the contract; a one-pack mock would let it quietly stop being true.
 * - **A participant with no booked weight on the skydiving site.** The pack asks
 *   for it, but a booking taken by phone may not have it. "Not asked" must
 *   render as missing, never as zero.
 * - **A cancelled booking and a no-show**, so "cancelled ones included" is
 *   exercised.
 * - **One booking with no attendance answer, one late, one coming**, because
 *   "nobody answered" is a different state from any answer.
 * - **An outstanding balance with a T-48h charge scheduled**, and a booking part
 *   paid by voucher, so the payment arithmetic is always on screen.
 * - **A partially redeemed voucher**, because partial redemption is where every
 *   competitor's voucher breaks.
 *
 * `goUnreachable()` makes every call throw `SiblingUnreachableError('booking')`,
 * so a host's Rule 13 fallback can be tested against the same mock.
 */

import {
  BookingVersionConflictError,
  SiblingUnreachableError,
  type AttendanceRequest,
  type BookingEngineAdapter,
  type BookingParticipant,
  type BookingPaymentSummary,
  type BookingSiteRef,
  type BookingStatus,
  type BookingSummary,
  type BookingWebhookEvent,
  type ISODate,
  type RescheduleRequest,
  type StatusRequest,
  type Unsubscribe,
  type VoucherBalance,
} from '../index.js';
import { MockScenario } from './scenario.js';
import { mockName, nowIso, shiftDays, type Rng } from './rng.js';

export interface MockBookingDayOptions {
  /** Bookings per site on the scenario's day. Default 8. */
  bookingsPerSite?: number;
}

interface PackShape {
  packId: string;
  offerings: ReadonlyArray<{ kind: string; name: string; priceMinor: number }>;
  fields: (rng: Rng) => Record<string, unknown>;
}

const PACKS: readonly PackShape[] = [
  {
    packId: 'skydiving',
    offerings: [
      { kind: 'tandem', name: 'Tandem skydive', priceMinor: 27900 },
      { kind: 'aff', name: 'First-jump course', priceMinor: 39900 },
    ],
    fields: (rng) => ({
      bookedWeightLbs: rng.gaussian(175, 30, 95, 240),
      ...(rng.chance(0.15) ? { requiresTranslation: rng.pick(['Spanish', 'German', 'Mandarin']) } : {}),
    }),
  },
  {
    packId: 'ballooning',
    offerings: [
      { kind: 'standard-flight', name: 'Sunrise flight', priceMinor: 24900 },
      { kind: 'private-basket', name: 'Private basket', priceMinor: 89900 },
    ],
    fields: (rng) => ({ weightKg: rng.gaussian(80, 14, 40, 125) }),
  },
];

const SITE_NAMES = ['Mock Sky Operator (skydiving pack)', 'Mock Balloon Operator (ballooning pack)'] as const;

function slotAt(date: ISODate, i: number): string {
  const minutes = 8 * 60 + i * 45;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date}T${p(Math.floor(minutes / 60))}:${p(minutes % 60)}:00`;
}

function payment(rng: Rng, total: number, withVoucher: boolean, activityDate: ISODate): BookingPaymentSummary {
  const deposit = Math.round(total * 0.25);
  const voucher = withVoucher ? Math.min(total - deposit, 10000) : 0;
  const settled = rng.chance(0.4);
  const paid = settled ? total : deposit + voucher;
  return {
    currency: 'USD',
    totalMinor: total,
    paidMinor: paid,
    outstandingMinor: Math.max(0, total - paid),
    depositCapturedMinor: deposit,
    // Off-session balance charge at T-48h (deposits are captured, not held).
    balanceDueAt: paid < total ? `${shiftDays(activityDate, -2)}T08:00:00` : null,
    cardOnFile: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
    voucherAppliedMinor: voucher,
  };
}

function buildSites(scenario: MockScenario): BookingSiteRef[] {
  return PACKS.map((pack, i) => ({
    siteId: scenario.id('site', i + 1),
    operatorId: scenario.id('operator', 1),
    name: SITE_NAMES[i] ?? `Mock site ${i + 1}`,
    slug: `mock-site-${i + 1}`,
    timezone: 'America/Denver',
    currency: 'USD',
    packId: pack.packId,
    packVersion: '0.0.0-mock',
  }));
}

function buildBookings(scenario: MockScenario, sites: BookingSiteRef[], per: number): BookingSummary[] {
  const rng = scenario.streamFor('booking-day');
  const out: BookingSummary[] = [];
  const created = `${scenario.activityDate}T07:00:00`;
  let n = 0;
  sites.forEach((site, s) => {
    const pack = PACKS[s]!;
    for (let i = 0; i < per; i += 1) {
      n += 1;
      const offering = rng.pick(pack.offerings);
      const size = rng.int(1, 3);
      const participants: BookingParticipant[] = [];
      for (let g = 0; g < size; g += 1) {
        const fields = pack.fields(rng);
        // One skydiving guest booked by phone with no weight given: "not asked", not zero.
        if (s === 0 && i === 1 && g === 0) delete fields.bookedWeightLbs;
        participants.push({
          participantId: scenario.id('participant', n * 10 + g),
          name: mockName(rng),
          dateOfBirth: `${rng.int(1960, 2006)}-0${rng.int(1, 9)}-1${rng.int(0, 9)}`,
          email: null,
          phone: null,
          fields,
          arrivedAt: null,
        });
      }
      const status: BookingStatus = i === 2 ? 'cancelled' : i === 3 ? 'no-show' : 'confirmed';
      const attendance =
        i === 0
          ? null
          : i === 4
            ? { answer: 'late' as const, etaMinutes: 20, answeredAt: created, answeredBy: 'customer' as const }
            : { answer: 'coming' as const, etaMinutes: null, answeredAt: created, answeredBy: 'customer' as const };
      const slotStart = slotAt(scenario.activityDate, i);
      out.push({
        ...scenario.provenance(),
        bookingId: scenario.id('booking', n),
        reference: `MK${String(1000 + n)}`,
        siteId: site.siteId,
        offering: { offeringId: scenario.id(`offering-${offering.kind}`, s + 1), kind: offering.kind, name: offering.name },
        activityDate: scenario.activityDate,
        slotStart,
        slotEnd: null,
        status,
        primaryContact: { name: participants[0]!.name, email: null, phone: null },
        participants,
        addOns: s === 0 && rng.chance(0.5) ? [{ code: 'video', label: 'Handcam video', quantity: 1, unitPriceMinor: 9900 }] : [],
        groupRef: null,
        payment: payment(rng, offering.priceMinor * size, i === 5, scenario.activityDate),
        attendance,
        version: 1,
        createdAt: created,
        updatedAt: created,
      });
    }
  });
  return out;
}

function buildVouchers(scenario: MockScenario, sites: BookingSiteRef[]): VoucherBalance[] {
  const at = `${scenario.activityDate}T07:00:00`;
  return sites.map((site, i) => ({
    ...scenario.provenance(),
    voucherId: scenario.id('voucher', i + 1),
    siteId: site.siteId,
    codeHint: `X${i}Q${i}`,
    currency: 'USD',
    issuedMinor: 30000,
    // Partially redeemed: real change left, which competitors get wrong.
    balanceMinor: 12500,
    status: 'active' as const,
    version: 2,
    updatedAt: at,
  }));
}

/** A fabricated booking day behind the real adapter interface. */
export class MockBookingEngine implements BookingEngineAdapter {
  readonly source = 'mock' as const;
  readonly descriptor = {
    label: 'Mock booking engine (SkyBook stand-in)',
    speaks: 'booking' as const,
    isMock: true,
  };

  private sites: BookingSiteRef[];
  private bookings: BookingSummary[];
  private vouchers: VoucherBalance[];
  private listeners = new Set<(event: BookingWebhookEvent) => void>();
  private unreachable = false;
  private eventSeq = 0;

  constructor(
    readonly scenario: MockScenario = new MockScenario(),
    options: MockBookingDayOptions = {},
  ) {
    this.sites = buildSites(scenario);
    this.bookings = buildBookings(scenario, this.sites, options.bookingsPerSite ?? 8);
    this.vouchers = buildVouchers(scenario, this.sites);
  }

  /** Every later call throws `SiblingUnreachableError('booking')`, until `comeBack()`. */
  goUnreachable(): void {
    this.unreachable = true;
  }

  comeBack(): void {
    this.unreachable = false;
  }

  private check(): void {
    if (this.unreachable) throw new SiblingUnreachableError('booking');
  }

  async listSites(): Promise<BookingSiteRef[]> {
    this.check();
    return [...this.sites];
  }

  async getDay(siteId: string, date: ISODate): Promise<BookingSummary[]> {
    this.check();
    return this.bookings.filter((b) => b.siteId === siteId && b.activityDate === date);
  }

  async getBooking(bookingId: string): Promise<BookingSummary | null> {
    this.check();
    return this.bookings.find((b) => b.bookingId === bookingId) ?? null;
  }

  async getVoucher(siteId: string, voucherId: string): Promise<VoucherBalance | null> {
    this.check();
    return this.vouchers.find((v) => v.siteId === siteId && v.voucherId === voucherId) ?? null;
  }

  async reschedule(bookingId: string, request: RescheduleRequest): Promise<BookingSummary> {
    const { before, after } = this.write(bookingId, request.expectedVersion, (b) => ({
      ...b,
      slotStart: request.toSlotStart,
      activityDate: request.toSlotStart.slice(0, 10),
    }));
    this.emit({
      type: 'booking.rescheduled',
      siteId: after.siteId,
      booking: after,
      change: this.change(after, 'moved', request.initiator, request.cause, before.slotStart),
    });
    return after;
  }

  async updateStatus(bookingId: string, request: StatusRequest): Promise<BookingSummary> {
    const { after } = this.write(bookingId, request.expectedVersion, (b) => ({ ...b, status: request.status }));
    if (request.status === 'cancelled') {
      this.emit({
        type: 'booking.cancelled',
        siteId: after.siteId,
        booking: after,
        change: this.change(after, 'cancelled', request.initiator, request.cause, null),
      });
    } else {
      this.emit({ type: 'booking.updated', siteId: after.siteId, booking: after });
    }
    return after;
  }

  async recordAttendance(bookingId: string, request: AttendanceRequest): Promise<BookingSummary> {
    const { after } = this.write(bookingId, request.expectedVersion, (b) => ({
      ...b,
      attendance: {
        answer: request.answer,
        etaMinutes: request.etaMinutes ?? null,
        answeredAt: nowIso(),
        answeredBy: 'operator',
      },
    }));
    this.emit({ type: 'booking.attendance', siteId: after.siteId, booking: after });
    return after;
  }

  subscribe(listener: (event: BookingWebhookEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private write(
    bookingId: string,
    expectedVersion: number,
    change: (b: BookingSummary) => BookingSummary,
  ): { before: BookingSummary; after: BookingSummary } {
    this.check();
    const i = this.bookings.findIndex((b) => b.bookingId === bookingId);
    if (i < 0) throw new Error(`no booking ${bookingId}`);
    const before = this.bookings[i]!;
    if (before.version !== expectedVersion) throw new BookingVersionConflictError(bookingId, before.version);
    const after = { ...change(before), version: before.version + 1, updatedAt: nowIso() };
    this.bookings[i] = after;
    return { before, after };
  }

  private change(
    b: BookingSummary,
    action: 'moved' | 'cancelled',
    initiator: 'customer' | 'operator',
    cause: string,
    fromSlotStart: string | null,
  ) {
    return {
      changeId: this.scenario.id('change', this.eventSeq + 1),
      bookingId: b.bookingId,
      action,
      initiator,
      cause,
      policyRule: initiator === 'operator' ? ('waived' as const) : ('free' as const),
      moneyOutcome: 'none' as const,
      amountMinor: 0,
      fromSlotStart,
      at: nowIso(),
    };
  }

  private emit(event: DistributiveOmit<BookingWebhookEvent, 'eventId' | 'at'>): void {
    this.eventSeq += 1;
    const full = { ...event, eventId: this.scenario.id('event', this.eventSeq), at: nowIso() } as BookingWebhookEvent;
    for (const l of this.listeners) l(full);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function mockBookingEngine(scenario?: MockScenario, options?: MockBookingDayOptions): MockBookingEngine {
  return new MockBookingEngine(scenario, options);
}
