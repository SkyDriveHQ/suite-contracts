/**
 * Compile-time assertions about the waiver contract's v0.6.0 additions, checked by
 * `test/contract-types.test.ts`. Every `@ts-expect-error` here must be earned.
 */

import type { WaiverIdCheckRequest, WaiverIdCheckResult, WaiverStatus, WaiverSummary, WaiverWebhookEvent } from '../../src/index.js';
import { beforeTheField } from './waiver-summary.check.js';

// A v0.5 summary, with none of the new keys, still compiles: every v0.6.0 field is optional.
export const v05: WaiverSummary = beforeTheField;

// The smart-waiver facts, when they were asked.
export const v06: WaiverSummary = {
  ...beforeTheField,
  status: 'needs-clearance',
  signature: { docHash: 'a'.repeat(64), typedName: 'Ada Lovelace', intentConfirmed: true, signedBy: 'participant', userAgent: null, initials: { risks: 'AL' } },
  signingLanguage: 'es',
  emergencyContact: { name: 'Charles', phone: '+44 20 0000 0000', relationship: null },
  consents: { photoConsent: { given: false, withdrawnAt: null } },
  clearance: { required: true, flaggedQuestions: ['heartCondition'], cleared: null },
};

// @ts-expect-error absent, never null: a question not asked has no key.
export const nullLanguage: WaiverSummary = { ...beforeTheField, signingLanguage: null };

// @ts-expect-error a clearance object exists only when one is required.
export const notRequired: WaiverSummary = { ...beforeTheField, clearance: { required: false, flaggedQuestions: [], cleared: null } };

// @ts-expect-error a consent is a recorded answer, not a bare boolean.
export const bareConsent: WaiverSummary = { ...beforeTheField, consents: { photoConsent: true } };

// A host must say the ID was checked in person; it cannot send false or leave it out.
export const ok: WaiverIdCheckRequest = { waiverId: 'w-1', idCheckedInPerson: true, attestedBy: 'Jo' };
// @ts-expect-error the in-person statement is the literal true.
export const notChecked: WaiverIdCheckRequest = { waiverId: 'w-1', idCheckedInPerson: false };
// @ts-expect-error the in-person statement cannot be left out.
export const silent: WaiverIdCheckRequest = { waiverId: 'w-1' };

// A refusal carries a reason and words for staff, never a waiver.
export const refused: WaiverIdCheckResult = { result: 'refused', reason: 'out-of-time', message: 'Check their ID again.' };
// @ts-expect-error a refusal has no waiver to hand back.
export const refusedWithWaiver: WaiverIdCheckResult = { result: 'refused', reason: 'not-found', message: 'x', waiver: beforeTheField };

// waiver.updated says what changed.
export const matched: WaiverWebhookEvent = { eventId: 'e', siteId: 's', at: '2026-10-08T10:00:00Z', type: 'waiver.updated', waiver: beforeTheField, change: 'matched' };
// @ts-expect-error a change the contract does not name.
export const edited: WaiverWebhookEvent = { eventId: 'e', siteId: 's', at: '2026-10-08T10:00:00Z', type: 'waiver.updated', waiver: beforeTheField, change: 'edited' };

// @ts-expect-error the status union is closed: there is no "pending".
export const pending: WaiverStatus = 'pending';
