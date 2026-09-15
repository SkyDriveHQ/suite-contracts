/**
 * `@skydrive/suite-contracts` — every cross-product boundary in the SkyDrive
 * suite, in one place, plus a mock generator for each of them under
 * `@skydrive/suite-contracts/mocks`.
 *
 * ## Status of each boundary
 *
 * | Boundary | Direction | Status |
 * |---|---|---|
 * | `JumpContext` | DZGO → SkyVideo | **Agreed** (DEC-048). Moved here from `@skyvideo/contracts`, unchanged |
 * | Instructor roster | SkyPerson → DZGO | **Agreed and live.** DZGO's shipped code depends on it |
 * | Rig service records | Rigging App → DZGO | ⚠️ **PROPOSED.** TBD-020. Needs Kyle's sign-off |
 * | Pilot reports | SkyPerson → DZGO | ⚠️ **PROPOSED.** DEC-079. Needs Kyle's sign-off |
 * | Packing queue / jobs | SkyPerson ↔ DZGO | ⚠️ **PROPOSED**, adapter surface open by name (PAK-Q-001) |
 * | Ops events | every product → Ops | ⚠️ **PROPOSED.** Direction settled, shape is new |
 *
 * A PROPOSED contract is safe to build a mock against and unsafe to build a
 * real feed against. The mock is the point: it lets both sides develop while
 * the shape is still being argued about, and if the shape changes, only the
 * mock changes with it.
 *
 * ## Rule 13, which this package must never be used to break
 *
 * No product may be a required dependency of another. Every adapter here is an
 * **optional overlay on a native path the consuming product already has**. If
 * you find yourself building a consumer that cannot function when one of these
 * returns nothing or throws `SiblingUnreachableError`, the design is wrong, not
 * the contract.
 */

export * from './common.js';
export * from './jump-context.js';
export * from './instructor.js';
export * from './rig.js';
export * from './pilot.js';
export * from './packing.js';
export * from './ops-events.js';
