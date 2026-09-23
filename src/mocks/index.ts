/**
 * A mock generator for every boundary in `@skydrive/suite-contracts`.
 *
 * **Never import this from production code.** Every fabricated record carries
 * `SUITE_MOCK_SENTINEL`, which DZGO's post-build isolation check
 * (`dzgo/scripts/check-isolation.mjs`) greps production bundles for — so a leak
 * fails a build rather than shipping. That is suite Rule 10 enforced
 * mechanically instead of by care.
 *
 * Pass one shared `MockScenario` to several generators to fabricate a single
 * coherent day across products: the same seed produces the same people, so a
 * jumper on DZGO's manifest is the same jumper SkyVideo sees on the load.
 */

export { MockScenario, type MockScenarioOptions } from './scenario.js';
export { Rng, SUITE_MOCK_SENTINEL, mockName, nowIso, randomSeed, shiftDays, todayIso } from './rng.js';

export { mockJumpContextLadder, mockJumpContextSource, type MockJumpDayOptions } from './jump-context.js';
export { MockInstructorRoster, mockInstructorRoster, type MockRosterOptions } from './instructor.js';
export { MockRigService, mockRigService, type MockRigFleetOptions } from './rig.js';
export { MockPilotReports, mockPilotReports, type MockPilotDayOptions } from './pilot.js';
export { MockPackingDay, mockPackingDay, type MockPackingDayOptions } from './packing.js';
export { MockInstructorWork, mockInstructorWork, type MockInstructorWorkOptions } from './instructor-work.js';
export {
  RecordingOpsEventSink,
  assertNonIdentifying,
  mockOpsEventSink,
  mockOpsEventStream,
  type MockOpsStreamOptions,
} from './ops-events.js';
