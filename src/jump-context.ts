/**
 * `JumpContext` — DZGO → SkyVideo. **The one boundary in this suite that was
 * specified before it was built** (DEC-048).
 *
 * Moved here verbatim from `@skyvideo/contracts` (`src/jump-context.ts`) when
 * the suite adopted one shared contracts package. It is unchanged in substance:
 * SkyVideo keeps re-exporting it, so no SkyVideo import path breaks, and DZGO
 * can now implement a rung-1 source against the same declaration instead of a
 * hand-copied mirror of it.
 *
 * The whole point: SkyVideo must work at a dropzone running DZGO, at a dropzone
 * running somebody else's manifest, and for a solo video flyer with no manifest
 * at all. Where the data came from is the adapter's problem, never the
 * detector's or the editor's.
 *
 * This is suite Rule 13 made structural. DZGO is rung 1 of four, and rung 4 —
 * nothing at all — has to be a first-class, fully-working state, not a degraded
 * mode that half the app forgets to handle.
 *
 * Architecture spec: `docs/skyvideo-architecture-v0.1.0.md` §2.2.
 */

import type { ISODate, ISODateTime } from './common.js';

/**
 * How much we know about who was on this jump, worst case to best.
 *
 * The ladder is ordered deliberately: a component that needs names checks
 * `rung <= 2`, and everything else keeps working regardless.
 */
export type JumpContextRung = 1 | 2 | 3 | 4;

export interface JumpContextSourceInfo {
  /** 1 = live manifest API, 2 = CSV export, 3 = camera timestamps only, 4 = nothing. */
  readonly rung: JumpContextRung;
  /** Human-readable, shown in the UI so staff know why a name is approximate. */
  readonly label: string;
  /** When this context was fetched or parsed. Staleness matters at rung 2. */
  readonly retrievedAt: ISODateTime;
  /**
   * True when the source is a live API that can be re-queried. A CSV is a
   * snapshot: re-reading it never produces anything newer.
   */
  readonly refreshable: boolean;
}

export interface PersonRef {
  /** Stable within the source. Never assume it is stable across sources. */
  readonly id: string;
  readonly displayName: string;
  /** Present only where the source distinguishes them. */
  readonly givenName?: string;
  readonly familyName?: string;
}

export interface LoadRef {
  readonly id: string;
  /** The load number the dropzone actually calls out. Not a database id. */
  readonly number: number;
  /** The moment the aircraft left the ground, if known. */
  readonly departedAt?: ISODateTime;
  readonly aircraft?: string;
}

export type JumpRole = 'tandem-student' | 'tandem-instructor' | 'videographer' | 'solo' | 'unknown';

export interface JumpSlot {
  readonly slotId: string;
  readonly role: JumpRole;
  readonly person?: PersonRef;
  /** Which tandem pair this slot belongs to, where the source models pairs. */
  readonly pairId?: string;
}

/**
 * One jump, as much as we know about it.
 *
 * Every field beyond `jumpId` and `source` is optional on purpose: a rung-4
 * context is a valid JumpContext with almost nothing filled in, and the type
 * system should force callers to handle that rather than letting them assume a
 * manifest is present.
 */
export interface JumpContext {
  readonly jumpId: string;
  readonly source: JumpContextSourceInfo;
  readonly load?: LoadRef;
  readonly slots: readonly JumpSlot[];
  /** The dropzone's own identifier for this jump, where one exists. */
  readonly externalRef?: string;
  /**
   * The local calendar date of the jumping day, in the dropzone's own
   * timezone. A jumping day is not a UTC day: a dusk load in Arizona is still
   * the same operating day. Never derive this from a UTC timestamp at the
   * point of use — the adapter resolves it once.
   */
  readonly operatingDay?: ISODate;
}

/**
 * The interface every manifest source implements. DZGO gets no special
 * treatment here; it is one implementation among several.
 */
export interface JumpContextSource {
  readonly rung: JumpContextRung;
  readonly label: string;
  /** Every jump known for an operating day. */
  listForDay(operatingDay: ISODate): Promise<readonly JumpContext[]>;
  /**
   * The jump whose load was airborne at this instant, if the source can say.
   * This is the deterministic join that makes customer identification an
   * association problem rather than a speech-recognition one.
   */
  findByInstant?(instant: ISODateTime): Promise<JumpContext | undefined>;
}

/**
 * The rung-4 source. Not a stub and not a fallback hack — it is what a
 * personal-tier user with no dropzone relationship legitimately runs on,
 * forever.
 */
export const emptyJumpContextSource: JumpContextSource = {
  rung: 4,
  label: 'No manifest — detection only',
  listForDay: async () => [],
};

/** True when this context can name people. Cheaper to read than `rung <= 2`. */
export function hasIdentities(ctx: JumpContext): boolean {
  return ctx.slots.some((s) => s.person !== undefined);
}
