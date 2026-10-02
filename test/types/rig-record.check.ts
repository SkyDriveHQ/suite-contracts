/**
 * Compile-time assertions about the rig contract, checked by
 * `test/contract-types.test.ts`, which runs the TypeScript compiler over this
 * file and fails on any error.
 *
 * Not a test file itself: vitest strips types without checking them, so a
 * `@ts-expect-error` in an ordinary test proves nothing. Here every
 * `@ts-expect-error` must be earned. If the contract stops rejecting one of
 * these shapes, the directive goes unused, the compiler reports that (TS2578),
 * and the test fails.
 */

import type { RigComponent, RigServiceRecord } from '../../src/index.js';

const reserve: RigComponent = {
  componentId: 'c-1',
  kind: 'reserve',
  manufacturer: 'Performance Designs',
  model: 'Optimum 143',
  serialNumber: 'RSV-1',
  dateOfManufacture: '2021-06',
};

// A rig with no recorded components is valid: the list is empty.
export const noComponents: RigServiceRecord = {
  source: 'rigging',
  scanCode: 'DZ-RIG-001',
  kind: 'sport',
  components: [],
  reservePacks: [],
  aadServices: [],
  outstandingBulletins: [],
  updatedAt: '2026-09-14T09:00:00',
};

export const withComponents: RigServiceRecord = { ...noComponents, components: [reserve] };

// Unknown serial and DOM are said with a null.
export const unrecorded: RigComponent = { ...reserve, serialNumber: null, dateOfManufacture: null };

// @ts-expect-error components is required: a feed cannot leave it out.
export const missingComponents: RigServiceRecord = {
  source: 'rigging',
  scanCode: 'DZ-RIG-002',
  kind: 'sport',
  reservePacks: [],
  aadServices: [],
  outstandingBulletins: [],
  updatedAt: '2026-09-14T09:00:00',
};

// @ts-expect-error an empty list, never null.
export const nullComponents: RigServiceRecord = { ...noComponents, components: null };

// @ts-expect-error a component's DOM may be null, but the key cannot be left out.
export const domOmitted: RigComponent = {
  componentId: 'c-2',
  kind: 'main',
  manufacturer: null,
  model: null,
  serialNumber: null,
};

// @ts-expect-error the Rigging App's 'other' parts are not part of this boundary.
export const otherKind: RigComponent = { ...reserve, kind: 'other' };
