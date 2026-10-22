/**
 * What these tests are for: the properties a host's mirror and its Rule 13
 * fallback will rely on — that the contract stays sport-neutral, that a
 * missing pack field is missing rather than zero, that a stale write is
 * refused rather than overwriting, that a replayed event cannot roll a mirror
 * back, and that an unreachable SkyBook is a typed, catchable state.
 */

import { describe, expect, it } from 'vitest';
import { MockBookingEngine, MockScenario, mockBookingEngine } from '../src/mocks/index.js';
import {
  BookingVersionConflictError,
  SiblingUnreachableError,
  isNewerThan,
  isReinstatement,
  paymentProblems,
  type BookingSummary,
  type BookingWebhookEvent,
} from '../src/index.js';

const DAY = '2026-10-03';
const engine = (seed = 5) => mockBookingEngine(new MockScenario({ seed, activityDate: DAY }));

describe('booking boundary', () => {
  it('serves sites on two different packs, so a host cannot assume skydiving', async () => {
    const sites = await engine().listSites();
    expect(new Set(sites.map((s) => s.packId))).toEqual(new Set(['skydiving', 'ballooning']));
  });

  it('includes cancelled and no-show bookings in a day', async () => {
    const e = engine();
    const [site] = await e.listSites();
    const statuses = new Set((await e.getDay(site!.siteId, DAY)).map((b) => b.status));
    expect(statuses).toContain('cancelled');
    expect(statuses).toContain('no-show');
  });

  it('leaves an unasked pack field absent, never zero', async () => {
    const e = engine();
    const sky = (await e.listSites()).find((s) => s.packId === 'skydiving')!;
    const guests = (await e.getDay(sky.siteId, DAY)).flatMap((b) => b.participants);
    const missing = guests.filter((g) => !('bookedWeightLbs' in g.fields));
    expect(missing.length).toBeGreaterThan(0);
    for (const g of guests) expect(g.fields.bookedWeightLbs).not.toBe(0);
  });

  it('keeps "nobody answered" distinct from any attendance answer', async () => {
    const e = engine();
    const [site] = await e.listSites();
    const day = await e.getDay(site!.siteId, DAY);
    expect(day.some((b) => b.attendance === null)).toBe(true);
    expect(day.some((b) => b.attendance?.answer === 'late')).toBe(true);
  });

  it('fabricates payment summaries that add up', async () => {
    const e = engine(9);
    for (const site of await e.listSites()) {
      for (const b of await e.getDay(site.siteId, DAY)) expect(paymentProblems(b.payment)).toEqual([]);
    }
  });

  it('flags a summary whose outstanding amount does not add up', () => {
    const problems = paymentProblems({
      currency: 'USD',
      totalMinor: 10000,
      paidMinor: 2500,
      outstandingMinor: 0,
      depositCapturedMinor: 2500,
      balanceDueAt: null,
      cardOnFile: null,
      voucherAppliedMinor: 0,
    });
    expect(problems).toContain('outstandingMinor does not equal totalMinor minus paidMinor');
  });

  it('refuses a write with a stale version and changes nothing', async () => {
    const e = engine();
    const [site] = await e.listSites();
    const b = (await e.getDay(site!.siteId, DAY)).find((x) => x.status === 'confirmed')!;
    await e.reschedule(b.bookingId, { toSlotStart: `${DAY}T15:00:00`, initiator: 'operator', cause: 'weather', expectedVersion: b.version });
    await expect(
      e.updateStatus(b.bookingId, { status: 'cancelled', initiator: 'operator', cause: 'weather', expectedVersion: b.version }),
    ).rejects.toBeInstanceOf(BookingVersionConflictError);
    expect((await e.getBooking(b.bookingId))!.status).toBe('confirmed');
  });

  it('emits a rescheduled event carrying where the booking was before', async () => {
    const e = engine();
    const events: BookingWebhookEvent[] = [];
    e.subscribe((ev) => events.push(ev));
    const [site] = await e.listSites();
    const b = (await e.getDay(site!.siteId, DAY))[0]!;
    await e.reschedule(b.bookingId, { toSlotStart: `${DAY}T16:00:00`, initiator: 'customer', cause: 'customer-request', expectedVersion: b.version });
    const ev = events.find((x) => x.type === 'booking.rescheduled');
    expect(ev?.type === 'booking.rescheduled' && ev.change.fromSlotStart).toBe(b.slotStart);
  });

  it('lets a mirror ignore a replayed or older event', () => {
    expect(isNewerThan({ version: 3 }, null)).toBe(true);
    expect(isNewerThan({ version: 3 }, { version: 2 })).toBe(true);
    expect(isNewerThan({ version: 3 }, { version: 3 })).toBe(false);
    expect(isNewerThan({ version: 2 }, { version: 3 })).toBe(false);
  });

  it('keeps a partially redeemed voucher with real change left', async () => {
    const e = engine();
    const [site] = await e.listSites();
    const v = await e.getVoucher(site!.siteId, e.scenario.id('voucher', 1));
    expect(v!.balanceMinor).toBeGreaterThan(0);
    expect(v!.balanceMinor).toBeLessThan(v!.issuedMinor);
  });

  it('throws SiblingUnreachableError by type when SkyBook is unreachable (Rule 13)', async () => {
    const e = engine();
    e.goUnreachable();
    await expect(e.listSites()).rejects.toBeInstanceOf(SiblingUnreachableError);
    e.comeBack();
    expect((await e.listSites()).length).toBe(2);
  });

  it('stamps every booking as mock', async () => {
    const e = engine();
    for (const site of await e.listSites()) {
      for (const b of await e.getDay(site.siteId, DAY)) expect(b.source).toBe('mock');
    }
  });
});

describe('voucher by code (v0.9.0)', () => {
  const siteOf = async (e: ReturnType<typeof engine>) => (await e.listSites())[0]!.siteId;
  const code = MockBookingEngine.voucherCode(0);

  it('finds a voucher by its code, ignoring case, spaces and dashes', async () => {
    const e = engine();
    const found = await e.lookupVoucherByCode(await siteOf(e), ` ${code.toLowerCase().replace(/-/g, ' ')} `);
    expect(found).not.toBeNull();
    expect(found!.expiresAt).toBeNull();
    expect(found!.balanceMinor).toBe(12500);
  });

  it('returns null for an unknown code and for another site\'s code', async () => {
    const e = engine();
    const [a, b] = await e.listSites();
    expect(await e.lookupVoucherByCode(a!.siteId, 'NOPE-0000')).toBeNull();
    expect(await e.lookupVoucherByCode(b!.siteId, code)).toBeNull();
  });

  it('redeems and bumps the version and balance', async () => {
    const e = engine();
    const siteId = await siteOf(e);
    const v = (await e.lookupVoucherByCode(siteId, code))!;
    const r = await e.redeemVoucherByCode(siteId, { code, amountMinor: 5000, expectedVersion: v.version, idempotencyKey: 'k1' });
    expect(r.replayed).toBe(false);
    expect(r.voucher.balanceMinor).toBe(7500);
    expect(r.voucher.version).toBe(v.version + 1);
    expect((await e.lookupVoucherByCode(siteId, code))!.balanceMinor).toBe(7500);
  });

  it('answers a retry with the same key as replayed and writes nothing more', async () => {
    const e = engine();
    const siteId = await siteOf(e);
    const v = (await e.lookupVoucherByCode(siteId, code))!;
    const req = { code, amountMinor: 5000, expectedVersion: v.version, idempotencyKey: 'k2' };
    await e.redeemVoucherByCode(siteId, req);
    const again = await e.redeemVoucherByCode(siteId, req);
    expect(again.replayed).toBe(true);
    expect(again.voucher.balanceMinor).toBe(7500);
  });

  it('refuses a stale version with BookingVersionConflictError', async () => {
    const e = engine();
    const siteId = await siteOf(e);
    const v = (await e.lookupVoucherByCode(siteId, code))!;
    await e.redeemVoucherByCode(siteId, { code, amountMinor: 1000, expectedVersion: v.version, idempotencyKey: 'k3' });
    await expect(
      e.redeemVoucherByCode(siteId, { code, amountMinor: 1000, expectedVersion: v.version, idempotencyKey: 'k4' }),
    ).rejects.toBeInstanceOf(BookingVersionConflictError);
  });
});

describe('a scrubbed booking that is rebooked (v0.10.0)', () => {
  /** Cancel a confirmed booking (the scrub), then rebook it, recording every event. */
  async function scrubAndRebook() {
    const e = engine();
    const events: BookingWebhookEvent[] = [];
    e.subscribe((ev) => events.push(ev));
    const [site] = await e.listSites();
    const b = (await e.getDay(site!.siteId, DAY)).find((x) => x.status === 'confirmed')!;
    const cancelled = await e.updateStatus(b.bookingId, { status: 'cancelled', initiator: 'operator', cause: 'weather', expectedVersion: b.version });
    const back = await e.rebookScrubbed(b.bookingId, { toSlotStart: `${DAY}T17:00:00`, initiator: 'operator', cause: 'weather', expectedVersion: cancelled.version });
    return { e, events, b, back };
  }

  /** A host written before v0.10.0: keeps cancelled bookings, applies every booking it knows by version, ignores unknown types. */
  function oldMirror(events: BookingWebhookEvent[]) {
    const copy = new Map<string, BookingSummary>();
    for (const ev of events) {
      switch (ev.type) {
        case 'booking.created':
        case 'booking.updated':
        case 'booking.cancelled':
        case 'booking.rescheduled':
        case 'booking.attendance':
          if (isNewerThan(ev.booking, copy.get(ev.booking.bookingId))) copy.set(ev.booking.bookingId, ev.booking);
          break;
        default:
          break;
      }
    }
    return copy;
  }

  it('emits booking.reinstated with the confirmed booking and where it was before', async () => {
    const { events, b, back } = await scrubAndRebook();
    const ev = events.find((x) => x.type === 'booking.reinstated');
    expect(ev).toBeDefined();
    if (ev?.type !== 'booking.reinstated') return;
    expect(ev.booking.status).toBe('confirmed');
    expect(ev.booking.version).toBe(back.version);
    expect(ev.change.action).toBe('moved');
    expect(ev.change.fromSlotStart).toBe(b.slotStart);
  });

  it('still sends booking.rescheduled, at the same version, so an old host sees what it saw before', async () => {
    const { events, back } = await scrubAndRebook();
    expect(events.map((x) => x.type)).toEqual(['booking.cancelled', 'booking.reinstated', 'booking.rescheduled']);
    const moved = events.find((x) => x.type === 'booking.rescheduled');
    expect(moved?.type === 'booking.rescheduled' && moved.booking.version).toBe(back.version);
  });

  it('leaves a host that ignores unknown types with the booking confirmed again', async () => {
    const { events, b } = await scrubAndRebook();
    expect(oldMirror(events).get(b.bookingId)?.status).toBe('confirmed');
  });

  it('lets a host that deletes on cancel store the booking again, and makes the second event a replay', async () => {
    const { events, b } = await scrubAndRebook();
    const copy = new Map<string, BookingSummary>();
    let restored = 0;
    for (const ev of events) {
      if (!('booking' in ev)) continue;
      const id = ev.booking.bookingId;
      if (ev.type === 'booking.cancelled') {
        copy.delete(id);
        continue;
      }
      if (isReinstatement(ev, copy.get(id))) restored += 1;
      if (isNewerThan(ev.booking, copy.get(id))) copy.set(id, ev.booking);
    }
    expect(copy.get(b.bookingId)?.status).toBe('confirmed');
    expect(restored).toBe(1);
  });

  it('names a rescheduled event that brings back a booking held as cancelled as a reinstatement', async () => {
    const { events } = await scrubAndRebook();
    const cancelled = events.find((x) => x.type === 'booking.cancelled')!;
    const moved = events.find((x) => x.type === 'booking.rescheduled')!;
    if (!('booking' in cancelled) || !('booking' in moved)) throw new Error('booking events carry the booking');
    expect(isReinstatement(moved, cancelled.booking)).toBe(true);
    // Already applied (same version), or a plain move of a confirmed booking: not a reinstatement.
    expect(isReinstatement(moved, moved.booking)).toBe(false);
    expect(isReinstatement(moved, { ...cancelled.booking, status: 'confirmed' })).toBe(false);
    expect(isReinstatement(cancelled, null)).toBe(false);
  });

  it('refuses to move a cancelled booking, and to rebook one that was not cancelled', async () => {
    const e = engine();
    const [site] = await e.listSites();
    const day = await e.getDay(site!.siteId, DAY);
    const gone = day.find((x) => x.status === 'cancelled')!;
    const live = day.find((x) => x.status === 'confirmed')!;
    await expect(e.reschedule(gone.bookingId, { toSlotStart: `${DAY}T17:00:00`, initiator: 'operator', cause: 'weather', expectedVersion: gone.version })).rejects.toThrow(/cancelled/);
    await expect(e.rebookScrubbed(live.bookingId, { toSlotStart: `${DAY}T17:00:00`, initiator: 'operator', cause: 'weather', expectedVersion: live.version })).rejects.toThrow(/not scrubbed/);
    expect((await e.getBooking(gone.bookingId))!.version).toBe(gone.version);
  });
});
