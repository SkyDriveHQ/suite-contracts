/**
 * Compile-time assertions about the waiver contract's in-person ID check
 * (v0.5.0), checked by `test/contract-types.test.ts`, which runs the
 * TypeScript compiler over this file and fails on any error.
 *
 * Every `@ts-expect-error` here must be earned: if the contract stops
 * rejecting one of these shapes, the directive goes unused, the compiler
 * reports that (TS2578), and the test fails.
 */

import type { WaiverIdCheck, WaiverSummary } from '../../src/index.js';

// A summary exactly as a v0.4 producer wrote it: no idCheck key at all. It must
// still compile, so producers built before the field are not broken. A host
// reads the missing field as "not checked" and fails closed.
export const beforeTheField: WaiverSummary = {
  source: 'waiver',
  waiverId: 'w-1',
  siteId: 'site-1',
  templateId: 'tpl-1',
  templateTitle: 'Tandem release',
  category: 'tandem',
  participant: { name: { first: 'Ada', last: 'Lovelace' }, dateOfBirth: '1990-01-01', minorOnSigningDay: false, email: null, phone: null },
  guardian: null,
  fields: {},
  channel: 'kiosk',
  signedAt: '2026-10-03T08:00:00Z',
  expiresAt: null,
  status: 'valid',
  linkedBookingId: null,
  linkedParticipantId: null,
  signingSession: null,
  supersededBy: null,
  signature: null,
  version: 1,
  updatedAt: '2026-10-03T08:00:00Z',
};

const checked: WaiverIdCheck = { checkedBy: 'Desk staff', checkedAt: '2026-10-03T08:10:00Z', method: 'in-person' };

// Checked in person: who and when.
export const confirmed: WaiverSummary = { ...beforeTheField, idCheck: checked, updatedAt: '2026-10-03T08:10:00Z' };

// Not yet checked, said plainly.
export const notYet: WaiverSummary = { ...beforeTheField, status: 'awaiting-confirmation', idCheck: null };

// @ts-expect-error in person is the only way: Kyle's rule allows no remote check.
export const remote: WaiverIdCheck = { ...checked, method: 'remote' };

// @ts-expect-error a check says who did it.
export const nobody: WaiverIdCheck = { checkedAt: '2026-10-03T08:10:00Z', method: 'in-person' };

// @ts-expect-error a check says when.
export const never: WaiverIdCheck = { checkedBy: 'Desk staff', method: 'in-person' };

// @ts-expect-error the key is left out, or holds an object or null; never undefined.
export const undefinedCheck: WaiverSummary = { ...beforeTheField, idCheck: undefined };
