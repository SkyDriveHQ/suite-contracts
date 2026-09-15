/**
 * Shared vocabulary for every cross-product boundary in the SkyDrive suite.
 *
 * This package exists because the suite is four repositories (DEC-063 as
 * amended by the split plan), and a boundary type that lives in only one of
 * them is a boundary type the other side copies by hand. SkyPerson's
 * `instructor.ts` says it is "field-for-field compatible with `InstructorRecord`
 * in `dzgo-contracts`. A test asserts the shape." No such test was ever
 * written. That is the failure mode this package removes: there is now one
 * declaration, and both sides import it.
 *
 * **Scope rule.** Only types that cross a product boundary belong here. A
 * product's internal vocabulary stays in that product's own contracts package
 * (`@skyperson/contracts`, `@skyvideo/contracts`, `@skydrive/dzgo-contracts`).
 * If exactly one product ever reads a type, it does not belong in this file.
 *
 * **Dependency rule.** This package depends on nothing, imports nothing, and
 * performs no I/O. Suite Rule 13 says no product may be a required dependency
 * of another; a contracts package that reached for a runtime would smuggle one
 * product's choices into every other product's bundle.
 */

/** Calendar date, `YYYY-MM-DD`, in the local time zone of the place it describes. */
export type ISODate = string;

/** Instant, ISO-8601 with offset or `Z`. */
export type ISODateTime = string;

export type Unsubscribe = () => void;

/**
 * Which product or vendor a record came from.
 *
 * This is the discriminator suite Rule 10 leans on: a fabricated test record
 * and a real customer must never be confusable, even in a shared schema, a
 * screenshot, or a pasted bug report.
 *
 * **Products and provenance only — no vendor names.** DZGO's own `RecordSource`
 * keeps `peekpro`, `smartwaiver` and `instructor-app`, because only DZGO has an
 * opinion about a booking vendor's data shape. Carrying them here would break
 * this file's own scope rule: a value exactly one product ever reads does not
 * belong in the shared vocabulary.
 */
export type SuiteSource =
  | 'mock'
  | 'dzgo'
  | 'skyperson'
  | 'skyvideo'
  | 'rigging'
  | 'manual'
  | 'import';

/** How a mock record was produced. Shown in every test panel and kept on the record. */
export type MockGenerator = 'manual' | 'random' | 'canned' | 'injector';

export interface MockProvenance {
  /** Identifies the fabricated day a record belongs to, so a day can be wiped cleanly. */
  scenarioId: string;
  scenarioName: string;
  generator: MockGenerator;
  /** Present for randomized scenarios so a run can be reproduced exactly. */
  seed?: number;
  generatedAt: ISODateTime;
}

/**
 * Every record crossing a boundary carries provenance.
 *
 * The union forces the `mock` block to be present when — and only when —
 * `source` is `'mock'`. A mock record cannot be constructed without its
 * scenario tag, and a real record cannot accidentally carry one. This is the
 * same shape as `Provenance` in `@skydrive/dzgo-contracts`, deliberately, so
 * DZGO's existing records pass through unchanged.
 */
export type SuiteProvenance =
  | { source: 'mock'; mock: MockProvenance }
  | { source: Exclude<SuiteSource, 'mock'>; mock?: undefined };

export interface PersonName {
  first: string;
  middle?: string;
  last: string;
}

export function formatName(name: PersonName): string {
  return name.middle ? `${name.first} ${name.middle} ${name.last}` : `${name.first} ${name.last}`;
}

/** Describes an adapter implementation to the consuming product's UI and logs. */
export interface SuiteAdapterDescriptor {
  /** Human label, e.g. "Mock packing queue (SkyPerson stand-in)". */
  label: string;
  /** Which system's data shape this adapter speaks. */
  speaks: SuiteSource;
  /** True for any adapter whose records are fabricated. Drives every "TEST DATA" badge. */
  isMock: boolean;
}

/**
 * Thrown by any boundary adapter when the sibling product cannot be reached.
 *
 * Distinct from the consuming product's own backend being down. Every consumer
 * catches this **by type, not by message text**, and carries on with its own
 * native records — which suite Rule 13 guarantees it has. A sibling being
 * unreachable is a normal operating state, not an error condition.
 */
export class SiblingUnreachableError extends Error {
  readonly product: SuiteSource;
  constructor(product: SuiteSource) {
    super(`${product} is unreachable`);
    this.name = 'SiblingUnreachableError';
    this.product = product;
  }
}

/** Age in whole years on `onDate`. Local calendar arithmetic, no time zones. */
export function ageOn(dateOfBirth: ISODate, onDate: ISODate): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [oy, om, od] = onDate.split('-').map(Number) as [number, number, number];
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age -= 1;
  return age;
}
