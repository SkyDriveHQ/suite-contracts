/**
 * Compile-time assertions about voucher-by-code (v0.9.0), checked by
 * `test/contract-types.test.ts`. Every `@ts-expect-error` must be earned.
 */

import type { BookingEngineAdapter, RedeemVoucherRequest, VoucherBalance, VoucherByCode } from '../../src/index.js';

// An adapter written before v0.9.0 has neither method and must still compile.
export type OldAdapter = Omit<BookingEngineAdapter, 'lookupVoucherByCode' | 'redeemVoucherByCode'>;
export const oldAdapterIsStillAnAdapter = (a: OldAdapter): BookingEngineAdapter => a;

// A coded voucher is a voucher balance plus expiresAt, which must be present (null = never expires).
export const asBalance = (v: VoucherByCode): VoucherBalance => v;
// @ts-expect-error expiresAt is required, null when vouchers never expire
export const noExpiry: VoucherByCode = {} as VoucherBalance;

export const request: RedeemVoucherRequest = { code: 'MOCK-GIFT-0000', amountMinor: 5000, expectedVersion: 2, idempotencyKey: 'k', note: 'desk' };
// @ts-expect-error idempotencyKey is required
export const noKey: RedeemVoucherRequest = { code: 'c', amountMinor: 1, expectedVersion: 1 };
// @ts-expect-error expectedVersion is required
export const noVersion: RedeemVoucherRequest = { code: 'c', amountMinor: 1, idempotencyKey: 'k' };

export const lookup = (a: BookingEngineAdapter) => a.lookupVoucherByCode?.('s', 'c');
export const lookupType: ((a: BookingEngineAdapter) => Promise<VoucherByCode | null> | undefined) = lookup;
