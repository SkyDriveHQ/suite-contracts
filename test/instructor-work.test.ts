/**
 * The properties SkyPerson's instructor screens rely on, asserted against the
 * mock and against the pure invoice rules both products run.
 */

import { describe, expect, it } from 'vitest';
import { MockScenario, mockInstructorWork } from '../src/mocks/index.js';
import {
  InvoiceRejectedError,
  JUMP_KINDS,
  invoiceProblems,
  invoiceTotalMinor,
  type InstructorEarningsLine,
  type InstructorInvoice,
} from '../src/index.js';

const DAY = '2026-09-14';
const scenario = (seed: number) => new MockScenario({ seed, activityDate: DAY });

function line(over: Partial<InstructorEarningsLine> & { lineId: string }): InstructorEarningsLine {
  return {
    source: 'dzgo',
    dzId: 'dz-1',
    on: DAY,
    kind: 'tandem',
    loadNumber: 3,
    description: 'Load 3 · tandem',
    rateMinor: 4500,
    amountMinor: 4500,
    currency: 'USD',
    paid: null,
    ...over,
  };
}

describe('instructor work mock', () => {
  it('always has at least one line with no price, so "not priced" renders', async () => {
    // Several seeds: the unpriced kind (coach at the second dropzone) must appear
    // somewhere across the fortnight, or no screen ever meets the state.
    let unpriced = 0;
    for (const seed of [71, 72, 73, 74, 75]) {
      const work = mockInstructorWork(scenario(seed), { days: 28 });
      for (const dz of await work.listDropzones()) {
        unpriced += (await work.getEarnings(dz.dzId, '2026-08-01', DAY)).filter((l) => l.amountMinor === null).length;
      }
    }
    expect(unpriced).toBeGreaterThan(0);
  });

  it('never prices an unknown rate as zero', async () => {
    const work = mockInstructorWork(scenario(76), { days: 28 });
    for (const dz of await work.listDropzones()) {
      for (const l of await work.getEarnings(dz.dzId, '2026-08-01', DAY)) {
        if (l.rateMinor === null) expect(l.amountMinor).toBeNull();
        else expect(l.amountMinor).toBeGreaterThan(0);
      }
    }
  });

  it('counts jumps from the same lines the pay comes from', async () => {
    const work = mockInstructorWork(scenario(77));
    const [dz] = await work.listDropzones();
    const totals = await work.getJumpTotals(dz!.dzId, '2026-09-01', DAY);
    const lines = await work.getEarnings(dz!.dzId, '2026-09-01', DAY);
    expect(totals.total).toBe(lines.filter((l) => JUMP_KINDS.includes(l.kind)).length);
    expect(totals.byKind['pack-job']).toBeUndefined();
  });

  it('shows the instructor only their own slots on the manifest, others as counts', async () => {
    const work = mockInstructorWork(scenario(78));
    const [dz] = await work.listDropzones();
    const loads = await work.getManifest(dz!.dzId, DAY);
    expect(loads.length).toBeGreaterThan(0);
    for (const load of loads) {
      expect(load.slotsFilled).toBeLessThanOrEqual(load.slotsTotal);
      for (const slot of load.mySlots) {
        if (slot.withFirstName !== null) expect(slot.withFirstName).not.toContain(' ');
      }
    }
    // Today is mid-day: something already sent, something still building.
    expect(loads.some((l) => l.status === 'sent')).toBe(true);
    expect(loads.some((l) => l.status === 'building')).toBe(true);
  });

  it('keeps availability to one entry per day and lets it be cleared', async () => {
    const work = mockInstructorWork(scenario(79));
    const [dz] = await work.listDropzones();
    const date = '2026-09-20';
    await work.setAvailability({ dzId: dz!.dzId, date, status: 'available', from: null, until: '15:00', note: null });
    const second = await work.setAvailability({ dzId: dz!.dzId, date, status: 'unavailable', from: null, until: null, note: 'Sick' });
    const onDay = (await work.getAvailability(dz!.dzId, date, date));
    expect(onDay).toHaveLength(1);
    expect(onDay[0]!.status).toBe('unavailable');
    await work.clearAvailability(dz!.dzId, second.entryId);
    expect(await work.getAvailability(dz!.dzId, date, date)).toHaveLength(0);
  });

  it('checks in and out for today and shows it on the day', async () => {
    const work = mockInstructorWork(scenario(80));
    const dzs = await work.listDropzones();
    const second = dzs[1]!;
    expect((await work.getDay(second.dzId, DAY)).checkedInAt).toBeNull();
    const day = await work.checkIn(second.dzId, { availableUntil: '14:30', lighterDayRequested: false });
    expect(day.checkedInAt).not.toBeNull();
    expect(day.availableUntil).toBe('14:30');
    expect((await work.checkOut(second.dzId)).checkedInAt).toBeNull();
  });

  it('refuses to answer about a dropzone the person does not work at', async () => {
    const work = mockInstructorWork(scenario(81));
    await expect(work.getDay('mock-dz-elsewhere', DAY)).rejects.toThrow();
  });
});

describe('invoices', () => {
  it('submits priced, unpaid lines and totals them from DZGO amounts', async () => {
    const work = mockInstructorWork(scenario(82));
    const [dz] = await work.listDropzones();
    const from = '2026-09-08';
    const lines = (await work.getEarnings(dz!.dzId, from, DAY)).filter((l) => l.amountMinor !== null && !l.paid);
    expect(lines.length).toBeGreaterThan(0);
    const invoice = await work.submitInvoice({
      dzId: dz!.dzId,
      periodStart: from,
      periodEnd: DAY,
      lineIds: lines.map((l) => l.lineId),
      note: null,
    });
    expect(invoice.status).toBe('submitted');
    expect(invoice.totalMinor).toBe(lines.reduce((s, l) => s + l.amountMinor!, 0));
  });

  it('will not bill the same work twice', async () => {
    const work = mockInstructorWork(scenario(83));
    const [dz] = await work.listDropzones();
    const from = '2026-09-08';
    const lines = (await work.getEarnings(dz!.dzId, from, DAY)).filter((l) => l.amountMinor !== null && !l.paid);
    const draft = { dzId: dz!.dzId, periodStart: from, periodEnd: DAY, lineIds: lines.map((l) => l.lineId), note: null };
    await work.submitInvoice(draft);
    await expect(work.submitInvoice(draft)).rejects.toBeInstanceOf(InvoiceRejectedError);
  });

  it('releases the lines of a disputed invoice so they can be billed again', async () => {
    const work = mockInstructorWork(scenario(84));
    const [dz] = await work.listDropzones();
    const from = '2026-09-08';
    const lines = (await work.getEarnings(dz!.dzId, from, DAY)).filter((l) => l.amountMinor !== null && !l.paid);
    const draft = { dzId: dz!.dzId, periodStart: from, periodEnd: DAY, lineIds: lines.map((l) => l.lineId), note: null };
    const first = await work.submitInvoice(draft);
    work.respond(first.invoiceId, 'disputed', 'Load 4 was a coach jump, not AFF');
    await expect(work.submitInvoice(draft)).resolves.toMatchObject({ status: 'submitted' });
  });

  it('announces each line as paid, not only the invoice', async () => {
    const work = mockInstructorWork(scenario(86));
    const [dz] = await work.listDropzones();
    const from = '2026-09-08';
    const lines = (await work.getEarnings(dz!.dzId, from, DAY)).filter((l) => l.amountMinor !== null && !l.paid);
    const inv = await work.submitInvoice({ dzId: dz!.dzId, periodStart: from, periodEnd: DAY, lineIds: lines.map((l) => l.lineId), note: null });
    const paidEvents: string[] = [];
    work.subscribe((e) => { if (e.type === 'work.line_paid' && e.line) paidEvents.push(e.line.lineId); });
    work.respond(inv.invoiceId, 'paid');
    expect(paidEvents.sort()).toEqual([...inv.lineIds].sort());
  });

  it('records the lighter-day request as a boolean at check-in', async () => {
    const work = mockInstructorWork(scenario(87));
    const second = (await work.listDropzones())[1]!;
    await work.checkIn(second.dzId, { availableUntil: null, lighterDayRequested: true });
    expect(work.lighterDayRequested(second.dzId)).toBe(true);
  });

  it('marks the lines paid when the dropzone pays the invoice', async () => {
    const work = mockInstructorWork(scenario(85));
    const [dz] = await work.listDropzones();
    const from = '2026-09-08';
    const lines = (await work.getEarnings(dz!.dzId, from, DAY)).filter((l) => l.amountMinor !== null && !l.paid);
    const inv = await work.submitInvoice({ dzId: dz!.dzId, periodStart: from, periodEnd: DAY, lineIds: lines.map((l) => l.lineId), note: null });
    work.respond(inv.invoiceId, 'paid');
    const after = await work.getEarnings(dz!.dzId, from, DAY);
    for (const id of inv.lineIds) expect(after.find((l) => l.lineId === id)!.paid).not.toBeNull();
  });
});

describe('invoiceProblems', () => {
  const draft = (lineIds: string[]) => ({ dzId: 'dz-1', periodStart: '2026-09-08', periodEnd: DAY, lineIds, note: null });

  it('accepts a clean draft', () => {
    expect(invoiceProblems(draft(['a']), [line({ lineId: 'a' })], [])).toEqual([]);
  });

  it('names every reason a line cannot be billed', () => {
    const lines = [
      line({ lineId: 'unpriced', rateMinor: null, amountMinor: null }),
      line({ lineId: 'paid', paid: { payoutId: 'p1', paidAt: `${DAY}T17:00:00` } }),
      line({ lineId: 'elsewhere', dzId: 'dz-2' }),
      line({ lineId: 'old', on: '2026-08-01' }),
      line({ lineId: 'billed' }),
    ];
    const open: InstructorInvoice[] = [
      {
        source: 'dzgo',
        invoiceId: 'inv-1',
        number: 'INV-0001',
        dzId: 'dz-1',
        periodStart: '2026-09-01',
        periodEnd: DAY,
        lineIds: ['billed'],
        totalMinor: 4500,
        currency: 'USD',
        note: null,
        status: 'submitted',
        submittedAt: `${DAY}T18:00:00`,
        respondedAt: null,
        dzNote: null,
      },
    ];
    const kinds = invoiceProblems(draft(['unpriced', 'paid', 'elsewhere', 'old', 'billed', 'ghost', 'paid']), lines, open).map((p) => p.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['not-priced', 'already-paid', 'other-dropzone', 'outside-period', 'already-invoiced', 'unknown-line', 'duplicate-line']),
    );
  });

  it('flags an empty draft', () => {
    expect(invoiceProblems(draft([]), [], []).map((p) => p.kind)).toEqual(['empty']);
  });

  it('refuses to total an unpriced line rather than counting it as zero', () => {
    expect(() => invoiceTotalMinor(['u'], [line({ lineId: 'u', amountMinor: null, rateMinor: null })])).toThrow(/no price/);
  });
});
