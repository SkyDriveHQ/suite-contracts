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
 * - **An in-person ID check on every waiver that has passed the desk** (valid, lapsed, superseded: who
 *   checked and when, never before it was signed) and `null` on the one awaiting confirmation, because
 *   Kyle's rule holds every waiver until staff check ID in person. The checkers' names and times come
 *   from their own seeded stream, so adding them changed no participant's name or date of birth for a
 *   seed. A checked waiver's `updatedAt` is the check's time, as recording a check is a change.
 *
 * `signNow()` brings in a newly signed waiver the way Kyle's rule says it arrives: awaiting confirmation,
 * with no ID check. `confirmNow()` is the desk checking ID in person: it records a fresh check, makes the
 * waiver valid and announces `waiver.confirmed`.
 *
 * - **One waiver that needs a medical clearance** (v0.6.0), checked in person but not yet cleared, so a
 *   host sees that a confirmed waiver is still not usable; and the smart-waiver facts on one kiosk waiver
 *   (initials, an emergency contact, a consent, the signing language), absent everywhere else.
 *
 * `confirmIdCheck()` is the adapter's real call (v0.6.0): it confirms a waiver awaiting confirmation, says
 * "already-confirmed" when asked again, "superseded" for a corrected one, and refuses an unknown id or a
 * check dated outside the window (ahead of now, before signing, or more than 72 hours ago).
 *
 * `goUnreachable()` makes every call throw `SiblingUnreachableError('waiver')`, so a host's Rule 13
 * fallback can be tested against the same mock.
 */

import {
  SiblingUnreachableError,
  type ISODateTime,
  type Unsubscribe,
  type WaiverIdCheck,
  type WaiverIdCheckRequest,
  type WaiverIdCheckResult,
  type WaiverEngineAdapter,
  type WaiverLookup,
  type WaiverSiteRef,
  type WaiverSummary,
  type WaiverWebhookEvent,
} from '../index.js';
import { MockScenario } from './scenario.js';
import { mockName, type Rng } from './rng.js';

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
  private connectionActive = true;
  private eventSeq = 0;
  /** Its own stream, so the ID checks do not shift any name or date drawn from 'waivers'. */
  private checks: Rng;

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
    this.checks = s.streamFor('waiver-id-checks');
    const at = (h: number): ISODateTime => `${s.activityDate}T${String(h).padStart(2, '0')}:00:00Z`;
    const idCheckAfter = (signedAt: ISODateTime) => this.idCheckAfter(signedAt);
    let n = 0;
    const base = (siteIdx: number, over: Partial<WaiverSummary>): WaiverSummary => {
      n += 1;
      const site = this.sites[siteIdx]!;
      const w = {
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
      // Decided from the finished record, so an overridden status or signing time is respected.
      if (!('idCheck' in over)) w.idCheck = w.status === 'awaiting-confirmation' ? null : idCheckAfter(w.signedAt);
      // Recording the check is a change to the waiver, so a mirror polling `listChangedSince` sees it.
      if (w.idCheck && Date.parse(w.idCheck.checkedAt) > Date.parse(w.updatedAt)) w.updatedAt = w.idCheck.checkedAt;
      return w;
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
    // Added in v0.6.0, last, so every earlier waiver keeps its id and name for a seed.
    // The smart-waiver facts (v0.6.0): initials, an emergency contact, a consent, the language signed in.
    this.waivers.push(base(0, {
      signature: { docHash: FAKE_HASH(1), typedName: 'Mock Signer', intentConfirmed: true, signedBy: 'participant', userAgent: null, initials: { risks: 'MS' } },
      signingLanguage: 'en',
      emergencyContact: { name: 'Mock Contact', phone: '+1 555 0100', relationship: null },
      consents: { photoConsent: { given: true, withdrawnAt: null } },
    }));
    // Checked in person, but a YES to a health question still needs a doctor's clearance: not usable yet.
    this.waivers.push(base(1, {
      status: 'needs-clearance',
      fields: { bodyWeightKg: 80, heartCondition: true },
      clearance: { required: true, flaggedQuestions: ['heartCondition'], cleared: null },
    }));
  }

  /** Staff checked ID in person a few minutes after signing. */
  private idCheckAfter(signedAt: ISODateTime): WaiverIdCheck {
    const staff = mockName(this.checks);
    return {
      checkedBy: `${staff.first} ${staff.last}`,
      checkedAt: new Date(Date.parse(signedAt) + this.checks.int(2, 45) * 60_000).toISOString().replace('.000Z', 'Z'),
      method: 'in-person',
    };
  }

  /** Every later call throws `SiblingUnreachableError('waiver')`, until `comeBack()`. */
  goUnreachable(): void {
    this.unreachable = true;
  }

  comeBack(): void {
    this.unreachable = false;
  }

  /** Test helper: the host's connection is switched off in SkyWaiver, so `confirmIdCheck` answers `invalid`, until `reconnect()`. */
  disconnect(): void {
    this.connectionActive = false;
  }

  reconnect(): void {
    this.connectionActive = true;
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

  /**
   * Test helper: a waiver is signed now, and every subscriber hears `waiver.signed`. Under Kyle's rule it
   * arrives awaiting confirmation with `idCheck: null`, never valid: nobody has checked ID yet.
   * (Before v0.5.0 this returned a `valid` waiver.)
   */
  signNow(siteIdx = 0): WaiverSummary {
    const template = this.waivers.find((w) => w.siteId === this.sites[siteIdx]!.siteId)!;
    const w: WaiverSummary = {
      ...template,
      waiverId: this.scenario.id('waiver', 1000 + this.eventSeq),
      version: 1,
      status: 'awaiting-confirmation',
      idCheck: null,
      supersededBy: null,
      updatedAt: template.signedAt,
    };
    this.waivers.push(w);
    this.emit({ siteId: w.siteId, at: w.signedAt, type: 'waiver.signed', waiver: w });
    return w;
  }

  /**
   * Test helper: staff check the person's ID in person and it matches. The waiver gets a fresh `idCheck`,
   * becomes `valid` with a higher version, and every subscriber hears `waiver.confirmed`. Only a waiver
   * awaiting confirmation can be confirmed; anything else throws, as it is a mistake in the test.
   */
  confirmNow(waiverId: string): WaiverSummary {
    const i = this.waivers.findIndex((w) => w.waiverId === waiverId);
    const before = this.waivers[i];
    if (!before || before.status !== 'awaiting-confirmation') throw new Error(`mock waiver ${waiverId} is not awaiting confirmation`);
    const idCheck = this.idCheckAfter(before.signedAt);
    const w: WaiverSummary = { ...before, status: 'valid', idCheck, version: before.version + 1, updatedAt: idCheck.checkedAt };
    this.waivers[i] = w;
    this.emit({ siteId: w.siteId, at: idCheck.checkedAt, type: 'waiver.confirmed', waiver: w });
    return w;
  }

  /**
   * A desk check made in the host (v0.6.0), as SkyWaiver answers it. The mock has one staff list, so any
   * caller counts as staff; the real engine records the check against the signed-in staff member.
   */
  async confirmIdCheck(request: WaiverIdCheckRequest): Promise<WaiverIdCheckResult> {
    this.check();
    if (!this.connectionActive) return { result: 'refused', reason: 'invalid', message: 'This connection is switched off in SkyWaiver.' };
    if ((request.idCheckedInPerson as boolean) !== true) return { result: 'refused', reason: 'invalid', message: 'Check their ID in person first.' };
    if (request.attestedBy !== undefined && request.attestedBy.length > 100) return { result: 'refused', reason: 'invalid', message: 'The name of who checked is too long (100 characters at most).' };
    const i = this.waivers.findIndex((w) => w.waiverId === request.waiverId);
    const before = this.waivers[i];
    if (!before) return { result: 'refused', reason: 'not-found', message: 'No such waiver at your sites.' };
    if (before.supersededBy !== null) return { result: 'superseded', waiver: before };
    if (before.idCheck) return { result: 'already-confirmed', waiver: before };
    // With no time given, the mock's desk checks a minute after signing, so a seed reproduces a day exactly.
    const atMs = request.checkedAt === undefined ? Date.parse(before.signedAt) + 60_000 : Date.parse(request.checkedAt);
    if (request.checkedAt !== undefined && (Number.isNaN(atMs) || atMs < Date.parse(before.signedAt) || atMs > Date.now() || Date.now() - atMs > 72 * 3_600_000)) {
      return { result: 'refused', reason: 'out-of-time', message: 'That ID check is outside the time allowed. Check their ID again.' };
    }
    const checkedAt = new Date(atMs).toISOString().replace('.000Z', 'Z');
    const idCheck: WaiverIdCheck = { checkedBy: request.attestedBy ?? 'Mock desk staff', checkedAt, method: 'in-person' };
    const status = before.status === 'awaiting-confirmation' ? 'valid' : before.status;
    const w: WaiverSummary = { ...before, status, idCheck, version: before.version + 1, updatedAt: checkedAt };
    this.waivers[i] = w;
    this.emit({ siteId: w.siteId, at: checkedAt, type: 'waiver.confirmed', waiver: w });
    return { result: 'confirmed', waiver: w };
  }

  private emit(event: Omit<Extract<WaiverWebhookEvent, { type: 'waiver.signed' | 'waiver.confirmed' }>, 'eventId'>): void {
    this.eventSeq += 1;
    const full = { ...event, eventId: this.scenario.id('waiver-event', this.eventSeq) } as WaiverWebhookEvent;
    for (const l of this.listeners) l(full);
  }

  subscribe(listener: (event: WaiverWebhookEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}

export function mockWaiverEngine(scenario?: MockScenario, options?: MockWaiverOptions): MockWaiverEngine {
  return new MockWaiverEngine(scenario, options);
}
