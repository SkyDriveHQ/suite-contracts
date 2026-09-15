/**
 * Mock `RigServiceAdapter` — the Rigging App → DZGO seam.
 *
 * DZGO's packing desk and rig records are live; the Rigging App is a shipped
 * product with 46 migrations. Neither has ever spoken to the other, because the
 * contract did not exist until this package. This generator is what lets DZGO
 * build and test the overlay before the Rigging App implements the real feed.
 *
 * **What it deliberately fabricates: trouble.** A generator that produced a
 * fleet of rigs all packed last month and all compliant would let a consumer
 * ship without ever rendering an outstanding bulletin or an overdue reserve.
 * Those are the states that matter, so they are always present.
 */

import type {
  AadService,
  ISODate,
  OutstandingBulletin,
  ReservePack,
  RigEvent,
  RigKind,
  RigServiceAdapter,
  RigServiceRecord,
  Unsubscribe,
} from '../index.js';
import { MockScenario } from './scenario.js';
import { mockName, shiftDays } from './rng.js';

const AAD_MODELS = ['Cypres 2', 'Vigil 2+', 'Argus', 'Astra'] as const;
const CONTAINERS = ['Javelin', 'Vector 3', 'Mirage G4', 'Infinity', 'Wings'] as const;
const COMPONENTS = ['container', 'reserve', 'main', 'AAD', 'harness'] as const;

export interface MockRigFleetOptions {
  /** Rigs to fabricate. Default 12. */
  count?: number;
  /** Share whose reserve repack date is already past. Default 0.15. */
  overdueRate?: number;
  /** Share carrying an uncomplied bulletin. Default 0.2. */
  bulletinRate?: number;
}

function buildFleet(scenario: MockScenario, options: MockRigFleetOptions): RigServiceRecord[] {
  const count = options.count ?? 12;
  const overdueRate = options.overdueRate ?? 0.15;
  const bulletinRate = options.bulletinRate ?? 0.2;
  const rng = scenario.streamFor('rig');
  const out: RigServiceRecord[] = [];

  for (let i = 0; i < count; i += 1) {
    // Roughly a dropzone's mix: mostly student and tandem fleet, a few rentals,
    // and some sport rigs the rigger services for individual jumpers.
    const kind: RigKind = rng.pick<RigKind>(['tandem', 'tandem', 'student', 'student', 'student', 'rental', 'sport']);
    const scanCode = `MOCK-RIG-${String(i + 1).padStart(3, '0')}`;

    // A US reserve repack cycle is 180 days. An overdue rig is dated past it.
    const overdue = rng.chance(overdueRate);
    const packedAgo = overdue ? rng.int(185, 260) : rng.int(5, 175);
    const packedOn = shiftDays(scenario.activityDate, -packedAgo);
    const riggerName = mockName(rng);

    const packs: ReservePack[] = [
      {
        packId: scenario.id('pack', i * 10 + 1),
        packedOn,
        dueOn: shiftDays(packedOn, 180),
        riggerName: `${riggerName.first} ${riggerName.last}`,
        // Obviously fake: a real certificate number never starts with MOCK.
        riggerCertificate: `MOCK-SR-${rng.int(100000, 999999)}`,
        sealSymbol: `${riggerName.first[0] ?? 'X'}${riggerName.last[0] ?? 'X'}${rng.int(1, 9)}`,
        ...(rng.chance(0.3) ? { notes: 'Routine repack. No findings.' } : {}),
      },
    ];
    // Most rigs have a history, not just one pack.
    if (rng.chance(0.6)) {
      const priorOn = shiftDays(packedOn, -rng.int(180, 200));
      packs.push({
        packId: scenario.id('pack', i * 10 + 2),
        packedOn: priorOn,
        dueOn: shiftDays(priorOn, 180),
        riggerName: `${riggerName.first} ${riggerName.last}`,
        riggerCertificate: `MOCK-SR-${rng.int(100000, 999999)}`,
      });
    }

    // Sport rigs often have no AAD; fleet rigs effectively always do.
    const aadServices: AadService[] = [];
    if (kind !== 'sport' || rng.chance(0.7)) {
      const servicedOn = shiftDays(scenario.activityDate, -rng.int(30, 1400));
      aadServices.push({
        serviceId: scenario.id('aad', i + 1),
        model: rng.pick(AAD_MODELS),
        serialNumber: `MOCK-AAD-${rng.int(10000, 99999)}`,
        servicedOn,
        // Cypres-style four-year service interval.
        dueOn: shiftDays(servicedOn, 4 * 365),
        ...(rng.chance(0.5) ? { batteryReplacedOn: shiftDays(servicedOn, rng.int(0, 400)) } : {}),
      });
    }

    const bulletins: OutstandingBulletin[] = [];
    if (rng.chance(bulletinRate)) {
      const issuedOn = shiftDays(scenario.activityDate, -rng.int(20, 900));
      const complied = rng.chance(0.4);
      bulletins.push({
        bulletinId: scenario.id('sb', i + 1),
        reference: `MOCK-SB-${issuedOn.slice(0, 4)}-${String(rng.int(1, 12)).padStart(2, '0')}`,
        issuedOn,
        component: rng.pick(COMPONENTS),
        summary: `Inspect ${rng.pick(COMPONENTS)} for wear at the attachment point.`,
        ...(complied ? { compliedOn: shiftDays(issuedOn, rng.int(5, 120)) } : {}),
      });
    }

    out.push({
      ...scenario.provenance(),
      scanCode,
      serial: `MOCK-${rng.pick(CONTAINERS).toUpperCase().replace(/\s+/g, '')}-${rng.int(1000, 9999)}`,
      kind,
      reservePacks: packs,
      aadServices,
      outstandingBulletins: bulletins,
      updatedAt: new Date().toISOString(),
    });
  }
  return out;
}

/** A fabricated rigger's view of a dropzone's fleet, behind the real interface. */
export class MockRigService implements RigServiceAdapter {
  readonly source = 'mock' as const;
  readonly descriptor = {
    label: 'Mock rig service records (Rigging App stand-in)',
    speaks: 'rigging' as const,
    isMock: true,
  };

  private records: RigServiceRecord[];
  private listeners = new Set<(event: RigEvent) => void>();

  constructor(
    readonly scenario: MockScenario = new MockScenario(),
    options: MockRigFleetOptions = {},
  ) {
    this.records = buildFleet(scenario, options);
  }

  /** Every scan code this mock knows, so a consumer can wire a fleet without guessing. */
  scanCodes(): string[] {
    return this.records.map((r) => r.scanCode);
  }

  async getForRigs(scanCodes: readonly string[]): Promise<RigServiceRecord[]> {
    const wanted = new Set(scanCodes);
    return this.records.filter((r) => wanted.has(r.scanCode));
  }

  async getRig(scanCode: string): Promise<RigServiceRecord | null> {
    return this.records.find((r) => r.scanCode === scanCode) ?? null;
  }

  subscribe(listener: (event: RigEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(type: RigEvent['type'], record: RigServiceRecord): void {
    const event: RigEvent = { type, at: new Date().toISOString(), record };
    for (const l of this.listeners) l(event);
  }

  /** Record a repack, as a rigger finishing one would. Drives a consumer's live view. */
  recordReservePack(scanCode: string, packedOn: ISODate, riggerName: string): RigServiceRecord | null {
    const i = this.records.findIndex((r) => r.scanCode === scanCode);
    if (i < 0) return null;
    const existing = this.records[i] as RigServiceRecord;
    const pack: ReservePack = {
      packId: this.scenario.id('pack', Date.now() % 1000),
      packedOn,
      dueOn: shiftDays(packedOn, 180),
      riggerName,
      riggerCertificate: `MOCK-SR-${this.scenario.streamFor('rig-repack').int(100000, 999999)}`,
    };
    // Newest first — `latestReservePack` trusts this order.
    const updated: RigServiceRecord = {
      ...existing,
      reservePacks: [pack, ...existing.reservePacks],
      updatedAt: new Date().toISOString(),
    };
    this.records[i] = updated;
    this.emit('rig.reserve_packed', updated);
    return updated;
  }
}

export function mockRigService(scenario?: MockScenario, options?: MockRigFleetOptions): MockRigService {
  return new MockRigService(scenario, options);
}
