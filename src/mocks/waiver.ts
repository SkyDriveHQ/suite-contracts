/**
 * Mock `WaiverEngineAdapter`: a stand-in for SkyWaiver, answering for two fabricated sites.
 *
 * **What it fabricates, and why each part exists:**
 * - **Two sites on two packs, with different ages of majority** (18 and 19), so a host that hard-codes
 *   18 or a skydiving field shows the gap instead of shipping it.
 * - **A minor signed by a guardian**, because the guardian is the signer and the host must show that.
 * - **A paper waiver with no signature evidence and no date of birth**, confirmed adult by staff:
 *   "no signature" is a fact about paper, not a missing value.
 * - **One lapsed, one awaiting desk confirmation, and one superseded by a correction**, so a host
 *   cannot treat "has a waiver" as "has a usable waiver".
 * - **A skydiving waiver with no licence field**, because a tandem is not asked for one: absent, never null.
 *
 * `goUnreachable()` makes every call throw `SiblingUnreachableError('waiver')`, so a host's Rule 13
 * fallback can be tested against the same mock.
 */

import {
  SiblingUnreachableError,
  type ISODateTime,
  type Unsubscribe,
  type WaiverEngineAdapter,
  type WaiverLookup,
  type WaiverSiteRef,
  type WaiverSummary,
  type WaiverWebhookEvent,
} from '../index.js';
import { MockScenario } from './scenario.js';
import { mockName } from './rng.js';

export interface MockWaiverOptions {
  /** Ordinary valid waivers per site, on top of the fixed edge cases. Default 6. */
  validPerSite?: number;
}

const FAKE_HASH = (n: number) => n.toString(16).padStart(64, 'a');

export class MockWaiverEngine implements WaiverEngineAdapter {
  readonly source = 'mock' as const;
  readonly descriptor = { label: 'Mock waiver engine (SkyWaiver stand-in)', speaks: 'waiver' as const, isMock: true };

  private sites: WaiverSiteRef[];
  private waivers: WaiverSummary[] = [];
  private listeners = new Set<(event: WaiverWebhookEvent) => void>();
  private unreachable = false;
  private eventSeq = 0;

  constructor(
    readonly scenario: MockScenario = new MockScenario(),
    options: MockWaiverOptions = {},
  ) {
    const s = scenario;
    this.sites = [
      { siteId: s.id('waiver-site', 1), operatorId: s.id('operator', 1), name: 'Mock Sky Operator (skydiving pack)', timezone: 'America/Denver', ageOfMajority: 18, packId: 'skydiving', packVersion: '0.0.0-mock' },
      { siteId: s.id('waiver-site', 2), operatorId: s.id('operator', 1), name: 'Mock Balloon Operator (ballooning pack)', timezone: 'America/Denver', ageOfMajority: 19, packId: 'ballooning', packVersion: '0.0.0-mock' },
    ];
    const rng = s.streamFor('waivers');
    const at = (h: number): ISODateTime => `${s.activityDate}T${String(h).padStart(2, '0')}:00:00Z`;
    let n = 0;
    const base = (siteIdx: number, over: Partial<WaiverSummary>): WaiverSummary => {
      n += 1;
      const site = this.sites[siteIdx]!;
      return {
        ...s.provenance(),
        waiverId: s.id('waiver', n),
        siteId: site.siteId,
        templateId: `tpl-${FAKE_HASH(siteIdx + 1).slice(0, 12)}`,
        templateTitle: siteIdx === 0 ? 'Tandem release (mock wording)' : 'Passenger declaration (mock wording)',
        category: siteIdx === 0 ? 'tandem' : 'passenger',
        participant: { name: mockName(rng), dateOfBirth: `19${rng.int(60, 99)}-0${rng.int(1, 9)}-1${rng.int(0, 9)}`, minorOnSigningDay: false, email: null, phone: null },
        guardian: null,
        fields: siteIdx === 0 ? {} : { bodyWeightKg: rng.int(50, 110) },
        channel: 'kiosk',
        signedAt: at(8),
        expiresAt: null,
        status: 'valid',
        linkedBookingId: null,
        linkedParticipantId: null,
        signingSession: null,
        supersededBy: null,
        signature: { docHash: FAKE_HASH(siteIdx + 1), typedName: 'Mock Signer', intentConfirmed: true, signedBy: 'participant', userAgent: null },
        version: 1,
        updatedAt: at(8),
        ...over,
      } as WaiverSummary;
    };
    for (let site = 0; site < 2; site++) {
      for (let i = 0; i < (options.validPerSite ?? 6); i++) this.waivers.push(base(site, {}));
    }
    // A minor, signed by a guardian.
    this.waivers.push(base(0, {
      participant: { name: mockName(rng), dateOfBirth: '2010-05-01', minorOnSigningDay: true, email: null, phone: null },
      guardian: { name: mockName(rng), relationship: 'parent', phone: null, email: null, signedAt: at(9) },
      signature: { docHash: FAKE_HASH(1), typedName: 'Mock Parent', intentConfirmed: true, signedBy: 'guardian', userAgent: null },
      channel: 'link',
    }));
    // Paper, no date of birth, adult confirmed by staff: no signature evidence, by nature.
    this.waivers.push(base(0, {
      participant: { name: mockName(rng), dateOfBirth: null, minorOnSigningDay: null, email: null, phone: null, adultConfirmedByStaff: true },
      channel: 'paper',
      signature: null,
    }));
    // A skydiving fun jumper with a licence: the pack's fields.
    this.waivers.push(base(0, { category: 'fun-jumper', fields: { licenceNumber: 'D-12345', ratings: ['coach'] } }));
    // Lapsed, awaiting confirmation, and superseded by a correction.
    this.waivers.push(base(0, { status: 'lapsed', signedAt: '2025-01-01T08:00:00Z', expiresAt: '2026-01-01T08:00:00Z' }));
    this.waivers.push(base(1, { status: 'awaiting-confirmation', channel: 'link' }));
    const corrected = base(1, {});
    this.waivers.push(base(1, { status: 'superseded', supersededBy: corrected.waiverId, version: 2 }));
    this.waivers.push(corrected);
  }

  /** Every later call throws `SiblingUnreachableError('waiver')`, until `comeBack()`. */
  goUnreachable(): void {
    this.unreachable = true;
  }

  comeBack(): void {
    this.unreachable = false;
  }

  private check(): void {
    if (this.unreachable) throw new SiblingUnreachableError('waiver');
  }

  async listSites(): Promise<WaiverSiteRef[]> {
    this.check();
    return [...this.sites];
  }

  async findForParticipant(siteId: string, lookup: WaiverLookup): Promise<WaiverSummary[]> {
    this.check();
    return this.waivers
      .filter((w) => w.siteId === siteId)
      .filter((w) =>
        (lookup.bookingId !== undefined && w.linkedBookingId === lookup.bookingId) ||
        (lookup.name !== undefined && w.participant.name.first === lookup.name.first && w.participant.name.last === lookup.name.last) ||
        (lookup.email !== undefined && w.participant.email === lookup.email),
      )
      .sort((a, b) => Date.parse(b.signedAt) - Date.parse(a.signedAt));
  }

  async getWaiver(waiverId: string): Promise<WaiverSummary | null> {
    this.check();
    return this.waivers.find((w) => w.waiverId === waiverId) ?? null;
  }

  async listChangedSince(siteId: string, since: ISODateTime): Promise<WaiverSummary[]> {
    this.check();
    return this.waivers.filter((w) => w.siteId === siteId && Date.parse(w.updatedAt) > Date.parse(since));
  }

  /** Test helper: a waiver is signed now, and every subscriber hears `waiver.signed`. */
  signNow(siteIdx = 0): WaiverSummary {
    const template = this.waivers.find((w) => w.siteId === this.sites[siteIdx]!.siteId)!;
    const w: WaiverSummary = { ...template, waiverId: this.scenario.id('waiver', 1000 + this.eventSeq), version: 1, status: 'valid', supersededBy: null };
    this.waivers.push(w);
    this.eventSeq += 1;
    for (const l of this.listeners) l({ eventId: this.scenario.id('waiver-event', this.eventSeq), siteId: w.siteId, at: w.signedAt, type: 'waiver.signed', waiver: w });
    return w;
  }

  subscribe(listener: (event: WaiverWebhookEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

export function mockWaiverEngine(scenario?: MockScenario, options?: MockWaiverOptions): MockWaiverEngine {
  return new MockWaiverEngine(scenario, options);
}
