/**
 * SkyAssist (DEC-167) — An AI help assistant that learns any app from its code, manuals and an expert's answers, and helps its staff in the moment.
 *
 * ## ⚠️ PROPOSED. Not agreed.
 *
 * Planted from `SkyDriveHQ/engine-seed` on 2026-10-13 under DEC-167. Safe to build a mock against; unsafe to
 * build a production dependency against until this header is removed.
 *
 * ## Rule 13
 *
 * Every boundary here is optional. A host app keeps its own native path, copies what it needs offline
 * into its own tables (the mirror rule), and degrades to "assist unavailable" when SkyAssist can't be
 * reached. SkyAssist works for an operator with no host app at all.
 *
 * ## What goes here
 *
 * Only types that cross a product boundary (scope rule, `common.ts`). No I/O, no imports beyond
 * `./common.js`. Vertical-specific shapes (anything one sport needs) stay in SkyAssist's packs.
 */

import type { ISODateTime, SuiteProvenance } from './common.js';

/** SkyAssist's own site id. A host stores it when the owner presses Connect; there is no shared tenant id. */
export type AssistSiteId = string;

/** The connection a host app holds to one SkyAssist site. */
export interface AssistConnection {
  readonly siteId: AssistSiteId;
  /** Which vertical pack shapes this site's records, e.g. `dzgo`. */
  readonly packId: string;
  readonly connectedAt: ISODateTime;
}

/** Every event SkyAssist sends a host carries this envelope, so the host can mirror it idempotently. */
export type AssistEventEnvelope<TType extends string, TData> = SuiteProvenance & {
  /** Unique per event; a host that has seen it ignores it. */
  readonly eventId: string;
  readonly type: TType;
  readonly siteId: AssistSiteId;
  readonly occurredAt: ISODateTime;
  readonly data: TData;
};

/** A screen in the host app, as the host names it (DZGO: the nav tab id, e.g. `loads`). */
export type AssistScreenId = string;

/** A question asked from a host app's help panel. Only the question and the screen leave the host. */
export interface AssistAskRequest {
  readonly question: string;
  readonly screen?: AssistScreenId;
}

/** Where an answer came from, so the panel can link to the screen rather than to a document. */
export interface AssistCitation {
  readonly screen?: AssistScreenId;
  /** What the person sees, e.g. "Loads > Hold the day". */
  readonly label: string;
  /** Trust rank of the source: 1 verified answer, 2 known issue, 3 app map or feature status, 4 guide. */
  readonly rank: 1 | 2 | 3 | 4;
}

/** Who at the operator decides something the assistant must not, named by the site's pack. */
export interface AssistHandoff {
  readonly category: string;
  /** The role that decides, e.g. "manager", in the pack's words. */
  readonly decidedBy: string;
  readonly severity: 1 | 2 | 3 | 4;
  /** One line for the person at the screen, e.g. what to do right now. */
  readonly sayNow: string;
}

export interface AssistAnswer {
  readonly answer: string;
  readonly citations: readonly AssistCitation[];
  /** Present when the question went to a person instead of, or as well as, being answered. */
  readonly handoff?: AssistHandoff;
  /** The pack build the answer came from; the host compares it with its own build. */
  readonly packBuild: string;
}
