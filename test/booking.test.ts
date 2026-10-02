/**
 * What these tests are for: the properties a host's mirror and its Rule 13
 * fallback will rely on — that the contract stays sport-neutral, that a
 * missing pack field is missing rather than zero, that a stale write is
 * refused rather than overwriting, that a replayed event cannot roll a mirror
 * back, and that an unreachable SkyBook is a typed, catchable state.
 */

import { describe, expect, it } from 'vitest';
import { MockScenario, mockBookingEngine } from '../src/mocks/index.js';
import {
  BookingVersionConflictError,
  SiblingUnreachableError,
  isNewerThan,
  paymentProblems,
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
