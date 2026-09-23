# @skydrive/suite-contracts

**The cross-product boundary contracts for the SkyDrive suite, plus a mock generator for every seam.**

Types and pure functions only. No I/O, no vendor code, no product code, and no dependencies.

## Why this repo exists

The suite is four repositories — `skyapp` (DZGO, Ops), `skyperson`, `skyvideo`, `rigging` — and
until now **no repository depended on another in any way**. Every boundary type was either absent or
copied by hand.

The copying had already gone wrong. `skyperson/packages/contracts/src/instructor.ts` said:

> "Field-for-field compatible with `InstructorRecord` in `dzgo-contracts`. A test asserts the shape,
> because 'compatible' claimed in a comment is worth nothing the day somebody adds a field."

No such test existed. The diagnosis was exactly right and the safety net was not there. There is now
one declaration of each boundary type, and both sides import it.

## How to depend on it

Git tag dependency — no registry, no publish step, pinned per consumer:

```json
{
  "dependencies": {
    "@skydrive/suite-contracts": "github:SkyAppSuite/suite-contracts#v0.1.0"
  }
}
```

npm runs `prepare` on a git dependency, so the TypeScript is compiled to `dist/` at install time and
consumers get real `.js` + `.d.ts` without needing to transpile anything in `node_modules`.

Bumping is deliberate and per-repo: retag here, then `npm update` in whichever consumer is ready. No
repo is dragged forward by another repo's release.

```ts
import type { JumpContext, InstructorRecord } from '@skydrive/suite-contracts'
import { mockInstructorRoster, MockScenario } from '@skydrive/suite-contracts/mocks'
```

## What is in here

| Boundary | Direction | Status |
|---|---|---|
| `JumpContext` | DZGO → SkyVideo | **Agreed** (DEC-048). Moved here from `@skyvideo/contracts`, unchanged |
| Instructor roster | SkyPerson → DZGO | **Agreed and live.** DZGO's shipped code already depends on it |
| Rig service records | Rigging App → DZGO | ⚠️ **PROPOSED.** TBD-020 |
| Pilot reports | SkyPerson → DZGO | ⚠️ **PROPOSED.** DEC-079 |
| Packing queue / jobs | SkyPerson ↔ DZGO | ⚠️ **PROPOSED**, adapter surface open by name (PAK-Q-001) |
| Instructor work: day, manifest, jump totals, pay lines, availability, invoices | DZGO ↔ SkyPerson | ⚠️ **PROPOSED** (Kyle, 2026-09-23). Scoped to the signed-in instructor by construction |
| Ops events | every product → Ops | ⚠️ **PROPOSED.** Direction settled, shape is new |

**A PROPOSED contract is safe to build a mock against and unsafe to build a real feed against.** That
is the point of drafting rather than waiting: both sides can develop while the shape is still being
argued about, and if the shape changes, only the mock changes with it.

Each PROPOSED file opens with what is actually specified, what was inferred, and which decision or
open question it is waiting on.

## The mocks

`@skydrive/suite-contracts/mocks` has a generator per boundary. They exist because every seam in this
suite has one side that shipped and one side that has not, and the shipped side had nothing to
develop against.

```ts
import { MockScenario, mockInstructorRoster, mockJumpContextLadder } from '@skydrive/suite-contracts/mocks'

// One scenario shared across generators fabricates one coherent day:
// the same seed produces the same people on both sides of a boundary.
const day = new MockScenario({ seed: 42, activityDate: '2026-09-14' })

const roster = mockInstructorRoster(day)
const ladder = mockJumpContextLadder(day)   // all four JumpContext rungs over the same jumps
```

Three properties the generators guarantee, each with a test:

- **A seed reproduces a day exactly.** Each generator draws from its own namespaced stream, so adding
  a generator — or constructing them in a different order — cannot shift another one's output.
- **The `JumpContext` rungs degrade one day rather than fabricating four.** Rung 2 is the same jumps
  known less well, not different jumps. Generating each rung independently would produce a test that
  passes while the real degradation path is broken.
- **Trouble is always present.** Overdue reserves, outstanding bulletins, instructors who never
  checked in, reports that arrive out of order. A generator where every field is populated and every
  date is current tests nothing; the branches that break in production are the null ones.

### Mocks must never reach production

Every fabricated record carries `SUITE_MOCK_SENTINEL`
(`skydrive-suite-contracts-mock-runtime`). DZGO's post-build isolation check
(`dzgo/scripts/check-isolation.mjs`) greps production bundles for markers like it, so a mock that
leaks into a production build **fails that build** rather than shipping. That is suite Rule 10 —
"a fabricated record and a real customer must never be confusable" — enforced mechanically rather
than by care.

## Rule 13, which this package must never be used to break

> No SkyDrive product may be a required dependency of another.

Every adapter here is an **optional overlay on a native path the consuming product already has**.
DZGO has its own roster, its own rig records, its own packing desk. The sibling adds to them when
present.

If you find yourself building a consumer that cannot function when one of these returns nothing or
throws `SiblingUnreachableError`, the design is wrong — not the contract.

## Scope rule

Only types that **cross a product boundary** belong here. A product's internal vocabulary stays in
that product's own contracts package (`@skyperson/contracts`, `@skyvideo/contracts`,
`@skydrive/dzgo-contracts`). If exactly one product ever reads a type, it does not belong in this
repo.

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest
npm run typecheck
```

Suite source of truth: `docs/SKYDRIVE-MASTER.md` in the `skyapp` repo.
