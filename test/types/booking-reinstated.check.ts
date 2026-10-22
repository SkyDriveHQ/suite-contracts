/**
 * Compile-time assertions about booking.reinstated (v0.10.0), checked by
 * `test/contract-types.test.ts`. Every `@ts-expect-error` must be earned.
 */

import type { BookingChangeEvent, BookingSummary, BookingWebhookEvent, BookingWebhookEventType } from '../../src/index.js';

// The new type is a member of the union a host subscribes to.
export const reinstatedIsAType: BookingWebhookEventType = 'booking.reinstated';

// A listener written before v0.10.0, handling only the types it knew and ignoring the rest, still compiles.
export const oldListener = (event: BookingWebhookEvent): string | null => {
  if (event.type === 'booking.created' || event.type === 'booking.updated' || event.type === 'booking.attendance') return event.booking.bookingId;
  if (event.type === 'booking.cancelled' || event.type === 'booking.rescheduled') return event.change.changeId;
  return null;
};
export const oldSwitch = (event: BookingWebhookEvent): string | null => {
  switch (event.type) {
    case 'booking.created':
    case 'booking.updated':
    case 'booking.cancelled':
    case 'booking.rescheduled':
    case 'booking.attendance':
      return event.booking.bookingId;
    default:
      return null;
  }
};

// A reinstatement carries the booking and the change that moved it, like a reschedule.
type Reinstated = Extract<BookingWebhookEvent, { type: 'booking.reinstated' }>;
export const carries = (e: Reinstated): [BookingSummary, BookingChangeEvent] => [e.booking, e.change];
// @ts-expect-error a reinstatement must carry the change
export const noChange: Reinstated = { type: 'booking.reinstated', eventId: 'e', siteId: 's', at: '2026-10-22T00:00:00', booking: {} as BookingSummary };
