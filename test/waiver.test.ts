/**
 * The properties a host's mirror and its Rule 13 fallback rely on: the contract stays sport-neutral, the
 * age of majority is the site's, "has a waiver" is not "has a usable waiver", paper has no signature by
 * nature, and an unreachable SkyWaiver is a typed, catchable state.
 */
import { describe, expect, it } from 'vitest';
import { MockScenario, mockWaiverEngine } from '../src/mocks/index.js';
import {
  SiblingUnreachableError,
  WAIVER_STATUS_WORDS,
  parseWaiverSignatureHeader,
  usableWaivers,
  usableWaiversCheckedInPerson,
  waiverSignedContent,
  type WaiverSummary,
  type WaiverWebhookEvent,
} from '../src/index.js';

const engine = () => mockWaiverEngine(new MockScenario({ seed: 7, activityDate: '2026-10-03' }));

describe('waiver boundary', () => {
  it('serves two packs with different ages of majority, so a host cannot assume skydiving or 18', async () => {
    const sites = await engine().listSites();
    expect(new Set(sites.map((s) => s.packId))).toEqual(new Set(['skydiving', 'ballooning']));
    expect(new Set(sites.map((s) => s.ageOfMajority))).toEqual(new Set([18, 19]));
  });

  it('marks a guardian as the signer for a minor', async () => {
    const e = engine();
    const [sky] = await e.listSites();
    const all = await e.listChangedSince(sky!.siteId, '2000-01-01T00:00:00Z');
    const minor = all.find((w) => w.participant.minorOnSigningDay === true)!;
    expect(minor.guardian).not.toBeNull();
    expect(minor.signature?.signedBy).toBe('guardian');
  });

  it('gives paper no signature evidence, and keeps a staff adult confirmation', async () => {
    const e = engine();
    const [sky] = await e.listSites();
    const paper = (await e.listChangedSince(sky!.siteId, '2000-01-01T00:00:00Z')).find((w) => w.channel === 'paper')!;
    expect(paper.signature).toBeNull();
    expect(paper.participant).toMatchObject({ dateOfBirth: null, minorOnSigningDay: null, adultConfirmedByStaff: true });
  });

  it('keeps pack fields in fields, absent when not asked', async () => {
    const e = engine();
    const [sky] = await e.listSites();
    const all = await e.listChangedSince(sky!.siteId, '2000-01-01T00:00:00Z');
    expect(all.find((w) => w.category === 'fun-jumper')!.fields).toMatchObject({ licenceNumber: 'D-12345' });
    expect('licenceNumber' in all.find((w) => w.category === 'tandem')!.fields).toBe(false);
  });

  it('separates having a waiver from having a usable one', async () => {
    const e = engine();
    const statuses = new Set<string>();
    for (const s of await e.listSites()) for (const w of await e.listChangedSince(s.siteId, '2000-01-01T00:00:00Z')) statuses.add(w.status);
    expect(statuses).toEqual(new Set(['valid', 'lapsed', 'needs-clearance', 'awaiting-confirmation', 'superseded']));
    const ball = (await e.listSites())[1]!;
    const all = await e.listChangedSince(ball.siteId, '2000-01-01T00:00:00Z');
    expect(usableWaivers(all).every((w) => w.status === 'valid')).toBe(true);
    const superseded = all.find((w) => w.status === 'superseded')!;
    expect(all.some((w) => w.waiverId === superseded.supersededBy)).toBe(true);
  });

  it('records an in-person ID check on every waiver past the desk, and none on one awaiting confirmation', async () => {
    const e = engine();
    const all = [];
    for (const s of await e.listSites()) all.push(...(await e.listChangedSince(s.siteId, '2000-01-01T00:00:00Z')));
    const valid = all.filter((w) => w.status === 'valid');
    expect(valid.length).toBeGreaterThan(0);
    // Kyle's rule: a valid waiver is one confirmed against ID in person, from every channel.
    for (const w of valid) {
      expect(w.idCheck).toMatchObject({ method: 'in-person' });
      expect(w.idCheck!.checkedBy.length).toBeGreaterThan(0);
      expect(Date.parse(w.idCheck!.checkedAt)).toBeGreaterThanOrEqual(Date.parse(w.signedAt));
      expect(Date.parse(w.updatedAt)).toBeGreaterThanOrEqual(Date.parse(w.idCheck!.checkedAt));
    }
    expect(new Set(valid.map((w) => w.channel))).toEqual(new Set(['kiosk', 'link', 'paper']));
    for (const w of all.filter((x) => x.status === 'lapsed' || x.status === 'superseded')) {
      expect(w.idCheck).toMatchObject({ method: 'in-person' });
      expect(Date.parse(w.idCheck!.checkedAt)).toBeGreaterThanOrEqual(Date.parse(w.signedAt));
    }
    const awaiting = all.filter((w) => w.status === 'awaiting-confirmation');
    expect(awaiting.length).toBe(1);
    expect(awaiting[0]!.idCheck).toBeNull();
  });

  it('tells subscribers when a waiver is signed', async () => {
    const e = engine();
    const seen: WaiverWebhookEvent[] = [];
    const off = e.subscribe((ev) => seen.push(ev));
    e.signNow();
    off();
    e.signNow();
    expect(seen.map((ev) => ev.type)).toEqual(['waiver.signed']);
  });

  it('brings a newly signed waiver in awaiting confirmation, with no ID check, never valid', async () => {
    const e = engine();
    const w = e.signNow();
    expect(w.status).toBe('awaiting-confirmation');
    expect(w.idCheck).toBeNull();
    expect(usableWaivers([w])).toEqual([]);
    expect((await e.getWaiver(w.waiverId))!.status).toBe('awaiting-confirmation');
  });

  it('confirms a waiver only when staff record a fresh in-person ID check', async () => {
    const e = engine();
    const seen: WaiverWebhookEvent[] = [];
    e.subscribe((ev) => seen.push(ev));
    const signed = e.signNow();
    const confirmed = e.confirmNow(signed.waiverId);
    expect(confirmed).toMatchObject({ waiverId: signed.waiverId, status: 'valid', version: signed.version + 1 });
    expect(confirmed.idCheck).toMatchObject({ method: 'in-person' });
    expect(confirmed.idCheck!.checkedBy.length).toBeGreaterThan(0);
    expect(Date.parse(confirmed.idCheck!.checkedAt)).toBeGreaterThanOrEqual(Date.parse(signed.signedAt));
    expect(confirmed.updatedAt).toBe(confirmed.idCheck!.checkedAt);
    expect(await e.getWaiver(signed.waiverId)).toEqual(confirmed);
    expect(seen.map((ev) => ev.type)).toEqual(['waiver.signed', 'waiver.confirmed']);
    expect(seen[1]!.waiver).toEqual(confirmed);
    expect(new Set(seen.map((ev) => ev.eventId)).size).toBe(2);
    expect(usableWaiversCheckedInPerson([confirmed])).toEqual([confirmed]);
    // Only a waiver awaiting confirmation can be confirmed.
    expect(() => e.confirmNow(signed.waiverId)).toThrow();
  });

  it('keeps only waivers checked in person when the host follows the rule, failing closed', () => {
    const valid = { status: 'valid' } as WaiverSummary;
    const checkedIn = { ...valid, idCheck: { checkedBy: 'Desk staff', checkedAt: '2026-10-03T08:10:00Z', method: 'in-person' } } as WaiverSummary;
    const notYet = { ...valid, idCheck: null } as WaiverSummary;
    const beforeTheField = valid; // no idCheck key: a producer from before v0.5.0
    const awaiting = { status: 'awaiting-confirmation', idCheck: null } as WaiverSummary;
    const lapsedButChecked = { ...checkedIn, status: 'lapsed' } as WaiverSummary;
    const all = [checkedIn, notYet, beforeTheField, awaiting, lapsedButChecked];
    expect(usableWaiversCheckedInPerson(all)).toEqual([checkedIn]);
    // The older helper is unchanged: status only.
    expect(usableWaivers(all)).toEqual([checkedIn, notYet, beforeTheField]);
  });

  it('agrees with the mock: every valid waiver it serves was checked in person', async () => {
    const e = engine();
    for (const s of await e.listSites()) {
      const all = await e.listChangedSince(s.siteId, '2000-01-01T00:00:00Z');
      expect(usableWaiversCheckedInPerson(all)).toEqual(usableWaivers(all));
    }
  });

  it('is a typed, catchable state when SkyWaiver cannot be reached', async () => {
    const e = engine();
    e.goUnreachable();
    await expect(e.listSites()).rejects.toBeInstanceOf(SiblingUnreachableError);
    await expect(e.listSites()).rejects.toMatchObject({ product: 'waiver' });
    e.comeBack();
    expect((await e.listSites()).length).toBe(2);
  });
});

describe('waiver boundary v0.6.0', () => {
  it('keeps a waiver that needs a medical clearance out of the usable ones, even once its ID is checked', async () => {
    const e = engine();
    const ball = (await e.listSites())[1]!;
    const all = await e.listChangedSince(ball.siteId, '2000-01-01T00:00:00Z');
    const needs = all.find((w) => w.status === 'needs-clearance')!;
    expect(needs.clearance).toEqual({ required: true, flaggedQuestions: ['heartCondition'], cleared: null });
    expect(needs.idCheck).toMatchObject({ method: 'in-person' });
    expect(usableWaiversCheckedInPerson([needs])).toEqual([]);
    expect(usableWaivers([needs])).toEqual([]);
  });

  it('leaves the smart-waiver facts absent where they were not asked, never null', async () => {
    const e = engine();
    const [sky] = await e.listSites();
    const all = await e.listChangedSince(sky!.siteId, '2000-01-01T00:00:00Z');
    const v8 = all.find((w) => w.signingLanguage !== undefined)!;
    expect(v8.signature?.initials).toEqual({ risks: 'MS' });
    expect(v8.consents).toEqual({ photoConsent: { given: true, withdrawnAt: null } });
    for (const w of all.filter((x) => x !== v8)) {
      for (const k of ['signingLanguage', 'emergencyContact', 'consents', 'clearance'] as const) expect(k in w, `${w.waiverId} ${k}`).toBe(false);
      if (w.signature) expect('initials' in w.signature).toBe(false);
    }
  });

  it('confirms a desk check made in a host once, and says so plainly when asked again', async () => {
    const e = engine();
    const seen: WaiverWebhookEvent[] = [];
    e.subscribe((ev) => seen.push(ev));
    const w = e.signNow();
    const first = await e.confirmIdCheck({ waiverId: w.waiverId, idCheckedInPerson: true, attestedBy: 'Jo at the desk' });
    expect(first.result).toBe('confirmed');
    if (first.result !== 'confirmed') return;
    expect(first.waiver).toMatchObject({ status: 'valid', idCheck: { checkedBy: 'Jo at the desk', method: 'in-person' }, version: w.version + 1 });
    expect((await e.confirmIdCheck({ waiverId: w.waiverId, idCheckedInPerson: true })).result).toBe('already-confirmed');
    expect(seen.map((ev) => ev.type)).toEqual(['waiver.signed', 'waiver.confirmed']);
  });

  it('refuses an unknown waiver and a check outside the time allowed, and answers "superseded" for a corrected one', async () => {
    const e = engine();
    const w = e.signNow();
    expect(await e.confirmIdCheck({ waiverId: 'nope', idCheckedInPerson: true })).toMatchObject({ result: 'refused', reason: 'not-found' });
    const ahead = new Date(Date.now() + 3_600_000).toISOString();
    expect(await e.confirmIdCheck({ waiverId: w.waiverId, idCheckedInPerson: true, checkedAt: ahead })).toMatchObject({ result: 'refused', reason: 'out-of-time' });
    const ball = (await e.listSites())[1]!;
    const superseded = (await e.listChangedSince(ball.siteId, '2000-01-01T00:00:00Z')).find((x) => x.status === 'superseded')!;
    expect((await e.confirmIdCheck({ waiverId: superseded.waiverId, idCheckedInPerson: true })).result).toBe('superseded');
    e.goUnreachable();
    await expect(e.confirmIdCheck({ waiverId: w.waiverId, idCheckedInPerson: true })).rejects.toBeInstanceOf(SiblingUnreachableError);
  });

  it('refuses an invalid desk check: inactive connection, a long attestedBy, or no in-person statement', async () => {
    const e = engine();
    const w = e.signNow();
    expect(await e.confirmIdCheck({ waiverId: w.waiverId, idCheckedInPerson: true, attestedBy: 'x'.repeat(101) })).toMatchObject({ result: 'refused', reason: 'invalid' });
    expect(await e.confirmIdCheck({ waiverId: w.waiverId, idCheckedInPerson: true, attestedBy: 'x'.repeat(100) })).toMatchObject({ result: 'confirmed' });
    const w2 = e.signNow();
    expect(await e.confirmIdCheck({ waiverId: w2.waiverId, idCheckedInPerson: false as unknown as true })).toMatchObject({ result: 'refused', reason: 'invalid' });
    e.disconnect();
    expect(await e.confirmIdCheck({ waiverId: w2.waiverId, idCheckedInPerson: true })).toMatchObject({ result: 'refused', reason: 'invalid' });
    e.reconnect();
    expect((await e.confirmIdCheck({ waiverId: w2.waiverId, idCheckedInPerson: true })).result).toBe('confirmed');
  });

  it('says "awaiting confirmation" as the in-person ID check', () => {
    expect(WAIVER_STATUS_WORDS['awaiting-confirmation']).toBe('Awaiting ID check in person');
    expect(Object.keys(WAIVER_STATUS_WORDS).sort()).toEqual(['awaiting-confirmation', 'lapsed', 'needs-clearance', 'superseded', 'valid']);
  });

  it('reads the signature header in the booking engine format, and names the signed content', () => {
    const v1 = 'a'.repeat(64);
    expect(parseWaiverSignatureHeader(`t=1760000000,v1=${v1}`)).toEqual({ timestampSeconds: 1760000000, v1 });
    expect(parseWaiverSignatureHeader(` v1=${v1} , t=1760000000 `)).toEqual({ timestampSeconds: 1760000000, v1 });
    for (const bad of [null, undefined, '', `t=abc,v1=${v1}`, 't=1760000000', `t=1,v1=${'A'.repeat(64)}`, `v1=${v1}`]) {
      expect(parseWaiverSignatureHeader(bad), String(bad)).toBeNull();
    }
    expect(waiverSignedContent(1760000000, '{"a":1}')).toBe('1760000000.{"a":1}');
  });
});
