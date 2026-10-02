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
  DateOfManufacture,
  ISODate,
  OutstandingBulletin,
  ReservePack,
  RigEvent,
  RigKind,
  RigServiceAdapter,
  RigComponent,
  RigServiceRecord,
  Unsubscribe,
} from '../index.js';
import { MockScenario } from './scenario.js';
import { mockName, shiftDays, type Rng } from './rng.js';

const AAD_MODELS = ['Cypres 2', 'Vigil 2+', 'Argus', 'Astra'] as const;
const CONTAINERS = ['Javelin', 'Vector 3', 'Mirage G4', 'Infinity', 'Wings'] as const;
const COMPONENTS = ['container', 'reserve', 'main', 'AAD', 'harness'] as const;

/** Who makes each container model above, so a component's make and model agree. */
const CONTAINER_MAKERS: Record<(typeof CONTAINERS)[number], string> = {
  Javelin: 'Sun Path',
  'Vector 3': 'United Parachute Technologies',
  'Mirage G4': 'Mirage Systems',
  Infinity: 'Velocity Sports Equipment',
  Wings: 'Sky Systems',
};
const AAD_MAKERS: Record<(typeof AAD_MODELS)[number], string> = {
  'Cypres 2': 'Airtec',
  'Vigil 2+': 'Advanced Aerospace Designs',
  Argus: 'Aviacom',
  Astra: 'MarS',
};
/** Canopies by who jumps the rig: tandem mains and reserves are their own products. */
const MAINS: Record<RigKind, readonly (readonly [string, string])[]> = {
  tandem: [['United Parachute Technologies', 'Sigma 370'], ['Strong Enterprises', 'SET-400']],
  student: [['Performance Designs', 'Navigator 260'], ['Aerodyne', 'Solo 2 250']],
  rental: [['Performance Designs', 'Sabre3 190'], ['Aerodyne', 'Pilot 188']],
  sport: [['Performance Designs', 'Sabre3 150'], ['Aerodyne', 'Pilot 7 150'], ['Performance Designs', 'Valkyrie 96']],
};
const RESERVES: Record<RigKind, readonly (readonly [string, string])[]> = {
  tandem: [['United Parachute Technologies', 'Sigma Reserve 360'], ['Strong Enterprises', 'Tandem 360 Reserve']],
  student: [['Performance Designs', 'Optimum 253'], ['Aerodyne', 'Smart 260']],
  rental: [['Performance Designs', 'Optimum 193'], ['Aerodyne', 'Smart 190']],
  sport: [['Performance Designs', 'Optimum 143'], ['Aerodyne', 'Smart 150'], ['Precision Aerodynamics', 'Micro Raven 135']],
};

/** ISO week of a `YYYY-MM-DD`, as the `YYYY-Www` a Vigil's label carries. */
function isoWeek(date: ISODate): DateOfManufacture {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - weekday); // the Thursday of this week decides its year
  const yearStart = Date.UTC(dt.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((dt.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * A DOM at the precision a label would actually give: mostly to the month,
 * sometimes to the day, now and then not recorded at all. A consumer that
 * assumes every DOM is a full date breaks here rather than on a real rig.
 */
function labelDom(rng: Rng, made: ISODate): DateOfManufacture | null {
  const roll = rng.next();
  if (roll < 0.08) return null;
  if (roll < 0.7) return made.slice(0, 7);
  return made;
}

/**
 * The rig's installed components, from their own random stream.
 *
 * Built after everything else about the rig, from a separate stream, so that
 * adding components did not shift a single value the fleet already produced
 * for a given seed. Where the rig already says something (its serial, its AAD
 * service record) the component repeats it rather than contradicting it.
 */
function buildComponents(
  rng: Rng,
  scenario: MockScenario,
  i: number,
  kind: RigKind,
  container: (typeof CONTAINERS)[number],
  rigSerial: string,
  oldestPackOn: ISODate,
  aad: AadService | undefined,
): RigComponent[] {
  // Some jumpers' own rigs have never had their parts written down by the
  // rigger. That is a real, common state: the list is empty, never null.
  if (kind === 'sport' && rng.chance(0.3)) return [];

  // Every part predates the oldest repack on record.
  const madeBefore = (on: ISODate, maxDays: number) => shiftDays(on, -rng.int(30, maxDays));
  const [mainMaker, mainModel] = rng.pick(MAINS[kind]);
  const [reserveMaker, reserveModel] = rng.pick(RESERVES[kind]);
  const components: RigComponent[] = [
    {
      componentId: scenario.id('cmp', i * 10 + 1),
      kind: 'container',
      manufacturer: CONTAINER_MAKERS[container],
      model: container,
      // The rig's own serial is the container's: it is what the harness label says.
      serialNumber: rigSerial,
      dateOfManufacture: labelDom(rng, madeBefore(oldestPackOn, 12 * 365)),
    },
    {
      componentId: scenario.id('cmp', i * 10 + 2),
      kind: 'main',
      manufacturer: mainMaker,
      model: mainModel,
      // Mains get swapped and relined; their serial is the one most often missing.
      serialNumber: rng.chance(0.15) ? null : `MOCK-MAIN-${rng.int(10000, 99999)}`,
      dateOfManufacture: labelDom(rng, madeBefore(oldestPackOn, 6 * 365)),
    },
    {
      componentId: scenario.id('cmp', i * 10 + 3),
      kind: 'reserve',
      manufacturer: reserveMaker,
      model: reserveModel,
      serialNumber: `MOCK-RSV-${rng.int(10000, 99999)}`,
      dateOfManufacture: labelDom(rng, madeBefore(oldestPackOn, 12 * 365)),
    },
  ];
  if (aad) {
    const model = aad.model as (typeof AAD_MODELS)[number];
    const made = madeBefore(aad.servicedOn, 10 * 365);
    components.push({
      componentId: scenario.id('cmp', i * 10 + 4),
      kind: 'aad',
      manufacturer: AAD_MAKERS[model] ?? null,
      model: aad.model,
      serialNumber: aad.serialNumber ?? null,
      // A Vigil's label gives the week, not the day.
      dateOfManufacture: model === 'Vigil 2+' ? isoWeek(made) : labelDom(rng, made),
    });
  }
  return components;
}

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
  const componentRng = scenario.streamFor('rig-components');
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

    // Drawn in the same order as before components existed, so a seed still
    // gives the same fleet.
    const container = rng.pick(CONTAINERS);
    const serial = `MOCK-${container.toUpperCase().replace(/\s+/g, '')}-${rng.int(1000, 9999)}`;
    const oldestPackOn = packs[packs.length - 1]?.packedOn ?? packedOn;

    out.push({
      ...scenario.provenance(),
      scanCode,
      serial,
      kind,
      components: buildComponents(componentRng, scenario, i, kind, container, serial, oldestPackOn, aadServices[0]),
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
