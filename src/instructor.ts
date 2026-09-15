/**
 * Instructor roster — SkyPerson (instructor role) → DZGO.
 *
 * **This is the one boundary where shipped code on one side was already
 * waiting on the other.** DZGO's live code depends on it today
 * (`dzgo-contracts/src/instructor.ts`, `dzgo/src/adapters/composite-roster.ts`),
 * satisfied by a mock. SkyPerson mirrored it by hand into
 * `@skyperson/contracts` and wrote, in a comment:
 *
 * > "Field-for-field compatible with `InstructorRecord` in `dzgo-contracts`.
 * > A test asserts the shape, because 'compatible' claimed in a comment is
 * > worth nothing the day somebody adds a field."
 *
 * No such test was ever written. The diagnosis was right and the safety net
 * was not there — which is the argument for this package existing. There is
 * now one declaration and both sides import it.
 *
 * ## The rating-name discrepancy, recorded rather than silently resolved
 *
 * `SKYPERSON-MASTER.md` INS-R-007 lists the ratings with **`outside-video`**.
 * DZGO's shipped contract says **`video`**. This file takes `video`, because
 * changing it would break running code, and the master document is the thing
 * that should change. Logged as SkyPerson B-1.
 *
 * ## The privacy rule here is load-bearing
 *
 * DEC-095: the lighter-day request keeps its 1–10 scale and its optional
 * free-text reason **inside SkyPerson**. What crosses this boundary is a
 * boolean and nothing else. The instructor sees their own number and their own
 * history; manifest sees "yes" or "no"; nobody else ever sees anything.
 *
 * That is not a preference about API design. An instructor telling manifest
 * they need a lighter day is a person volunteering something about how they
 * feel, and the moment that number is visible to an employer it stops being
 * volunteered. The narrow type is what keeps the feature usable.
 *
 * ## Rule 13
 *
 * The feed is optional. DZGO keeps its own roster (DZM-R-059) behind this same
 * interface and composes the two (`CompositeRoster`), so a dropzone whose
 * instructors never install SkyPerson still has a full roster, morning
 * check-in and rotation.
 */

import type {
  ISODate,
  ISODateTime,
  PersonName,
  SuiteAdapterDescriptor,
  SuiteProvenance,
  SuiteSource,
  Unsubscribe,
} from './common.js';

/**
 * What an instructor is rated to do. Any combination.
 *
 * `video` is the outside camera on a tandem or AFF jump — spelled `video`, not
 * `outside-video`; see the note at the top of this file. Only `tandem` puts
 * someone in the tandem rotation.
 */
export type InstructorRating = 'tandem' | 'aff' | 'coach' | 'video' | 'handcam' | 'static-line' | 'iad';

export const INSTRUCTOR_RATING_LABELS: Record<InstructorRating, string> = {
  tandem: 'Tandem instructor',
  aff: 'AFF instructor',
  coach: 'Coach',
  video: 'Video flyer',
  handcam: 'Handcam',
  'static-line': 'Static line',
  iad: 'IAD',
};

/**
 * Credential expiry dates.
 *
 * **Dates are facts. "Current" is a judgement, and no product in this suite
 * makes it** (Rule 11, DEC-024). A screen may show that a rating expired on a
 * date and let a person draw the obvious conclusion; it may not display the
 * word "expired" as a verdict about whether somebody may work today, because
 * that depends on the dropzone's own rules and on things software cannot see.
 *
 * The distinction sounds pedantic until a rating shows as lapsed because of a
 * timezone rounding error and somebody is sent home.
 */
export interface InstructorCredentials {
  uspaNumber?: string | null;
  membershipExpires?: ISODate | null;
  /** Per rating, when it lapses (USPA rating renewal). */
  ratingExpiries?: Partial<Record<InstructorRating, ISODate>>;
  /** FAA medical or the dropzone's own fitness note, if it tracks one. */
  medicalExpires?: ISODate | null;
}

export type InstructorRecord = SuiteProvenance & {
  /** Consumer-side id: `${source}:${vendorInstructorId}`. */
  id: string;
  vendorInstructorId: string;
  name: PersonName;
  ratings: InstructorRating[];
  /** Heaviest tandem customer this instructor takes today, pounds. Null for non-tandem staff. */
  tandemWeightLimitLbs: number | null;
  /** Profile limit before any daily override, so a board can show "limit lowered today". */
  profileWeightLimitLbs: number | null;
  languages: string[];
  /** Morning check-in (INS-R-002). Null = not checked in today. */
  checkedInAt: ISODateTime | null;
  /** Leaves early today; null = available all day. `HH:mm` local. */
  availableUntil: string | null;
  /** **DEC-095: a boolean, and never anything richer.** */
  lighterDayRequested: boolean;
  /** Tandem jumps done today, for the even-jumps rotation view (DZM-R-025). */
  tandemJumpsToday: number;
  /** Media (handcam / outside video) jumps done today. */
  mediaJumpsToday: number;
  /** Present when the dropzone recorded the instructor itself. */
  credentials?: InstructorCredentials;
  /** For a consuming product's own records: where the registration link went. */
  email?: string | null;
};

export type InstructorEventType = 'instructor.checked_in' | 'instructor.checked_out' | 'instructor.updated';

export interface InstructorEvent {
  type: InstructorEventType;
  at: ISODateTime;
  instructor: InstructorRecord;
}

export interface InstructorRosterAdapter {
  readonly source: SuiteSource;
  readonly descriptor: SuiteAdapterDescriptor;
  /** Everyone on the roster for `date`, checked in or not. */
  getRoster(date: ISODate): Promise<InstructorRecord[]>;
  getInstructor(id: string): Promise<InstructorRecord | null>;
  subscribe(listener: (event: InstructorEvent) => void): Unsubscribe;
}

/**
 * The full lighter-day request, which **never leaves SkyPerson**.
 *
 * Declared here so the boundary is visible in the shared package rather than
 * living only in a comment on one side of it. If this type is ever referenced
 * from something that serialises toward DZGO, that is a bug with a name.
 */
export interface LighterDayRequest {
  /** 1–10. The instructor's own number. */
  readonly level: number;
  readonly reason?: string;
  readonly at: ISODateTime;
}

/** The only part of a lighter-day request the outside world may see. */
export function lighterDayRequested(request: LighterDayRequest | undefined): boolean {
  return request !== undefined;
}
