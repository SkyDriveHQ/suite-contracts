/**
 * Product → SkyDrive Ops event push.
 *
 * ## ⚠️ PROPOSED. Not agreed.
 *
 * Ops states the boundary from its own side, in `ops/src/supabase/projects.ts`:
 *
 * > "Ops never reads another product's database (SKYDRIVEOPS-MASTER.md 5).
 * > That boundary is the answer to the DEC-035 shared-tenant question TBD-045
 * > raised: **products push events here, Ops does not reach into them.**"
 *
 * That establishes the direction and the prohibition. It does not define the
 * event. This file is this session's proposal for the event shape, and needs
 * Kyle's sign-off.
 *
 * ## Why the payload is deliberately impoverished
 *
 * Every product in this suite holds data that must not leak into a cross-
 * product operations view: customer names, waiver contents, an instructor's
 * lighter-day number (DEC-095), a rigger's certificate number, a jumper's
 * logbook. Ops needs to know that a thing happened and whether it worked. It
 * does not need to know who it happened to.
 *
 * So `OpsEvent` carries **no free-text payload and no person reference at
 * all**. A product that needs to say more says it with a new `kind`, which is
 * a reviewable change, rather than by putting a sentence in a string field,
 * which is not. This is the one design choice here worth defending: the
 * expensive version of this mistake is discovering that six months of
 * operations logs contain customer names.
 *
 * ## Rule 13
 *
 * Every product must run with no Ops in existence. The sink is fire-and-forget:
 * `emit` never rejects, never blocks a user action, and never surfaces an error
 * to a person. An Ops outage is invisible to a dropzone at work.
 */

import type { ISODateTime, SuiteSource } from './common.js';

/**
 * What kind of thing happened.
 *
 * Intentionally a closed union. Adding a member is a deliberate act with a
 * reviewer; it is the mechanism that keeps the payload honest.
 */
export type OpsEventKind =
  | 'product.started'
  | 'product.deployed'
  | 'sync.succeeded'
  | 'sync.failed'
  | 'sibling.unreachable'
  | 'adapter.configured'
  | 'migration.applied'
  | 'error.unhandled';

/** Coarse outcome. Ops dashboards count these; nothing branches on them. */
export type OpsEventOutcome = 'ok' | 'degraded' | 'failed';

/**
 * One event, as pushed by a product.
 *
 * Note the absence of: names, ids of people, free text, request bodies, and
 * anything a customer typed. See the header.
 */
export interface OpsEvent {
  readonly eventId: string;
  readonly kind: OpsEventKind;
  readonly outcome: OpsEventOutcome;
  /** Which product emitted it. */
  readonly product: SuiteSource;
  /** The emitting build, so a spike can be tied to a deploy. */
  readonly release?: string;
  readonly at: ISODateTime;
  /**
   * Opaque, non-identifying grouping key — a dropzone or tenant *hash*, never
   * a name and never a user id. Lets Ops see "one tenant is failing" without
   * learning which.
   */
  readonly tenantKey?: string;
  /**
   * Bounded numeric detail only: durations, counts, retry numbers.
   *
   * Numbers, deliberately. A `Record<string, string>` would become a place to
   * put a customer's name within a month.
   */
  readonly measures?: Readonly<Record<string, number>>;
}

/**
 * The sink a product writes to.
 *
 * **`emit` returns void and never throws.** A product that awaited an Ops
 * write, or showed a person an error because one failed, would have made Ops a
 * required dependency — exactly what Rule 13 forbids. Implementations queue,
 * drop, and forget.
 */
export interface OpsEventSink {
  readonly product: SuiteSource;
  emit(event: OpsEvent): void;
  /** Best-effort delivery of anything queued. Resolves even when nothing was sent. */
  flush?(): Promise<void>;
}

/**
 * The no-Ops sink. Every product's default, and a fully correct way to run
 * forever — not a stub.
 */
export const nullOpsEventSink: OpsEventSink = {
  product: 'dzgo',
  emit: () => {},
};
