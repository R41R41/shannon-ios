# ADR-0008 Stage 5 implementation and verification

Owner: Shannon task. Source: `codex/shannon/adr8-stage5`, based on `8200c1282a48f51fbcbd8bead998703ab35b2e0d`. Owner approved the complete plan on 2026-10-08. Status: implementation and deterministic verification complete; native visual/interaction verification pending screen unlock. Not deployed or delivered through TestFlight.

Functional and rollout authority: [adr8-stage5-contract.md](adr8-stage5-contract.md). Production remains the previously accepted Stage 4 baseline with Stage 4 and evidence decay ON. Stage 5 defaults OFF.

## What changed

- Self interests use the canonical memory writer, immutable revisions and changes, durable real-night 2/2 quotas, bounded weights, current source/forgetting checks and individual CAS undo/pin/ban/forget/resume.
- Task trees extend the existing engine and approved Host commands. Completion needs original attempt/turn/action/lease and real test evidence; legacy tasks continue without invented proof. Durable learning callbacks read exact original action receipts through a scoped port.
- Feedback binds real tool-backed owner replies and verified task results to one original choice. Reaction revisions and operation read-back feed the versioned 80/20 serve fold with independent cursors. Unknown operations, audience changes, forgetting and rollback retain their boundaries.
- Self revision has durable ordered gates, work-level failure freeze, original authority/budget/stop, physical paths and information provenance, exact grants, actual bounded code/data checks and snapshots. Validation interrupted before dispatch is closed without retaining rights; dispatched uncertainty is retained.
- Transport responsibilities moved into perception, attention, inhibition and memory; constructors moved into wiring. Pure rule/frame ports bound worker reachability and import cycles. Actual layer violations went from 43 to 0 with unchanged rules and no exception.
- iPhone and Mac share new DTO/model behavior and approved diary/reaction/work-detail controls, preserving existing navigation, voice, memory, study and task controls. A DEBUG-only native fixture replaces the root with synthetic in-memory clients and performs no live calls or writes.

## Deterministic verification

Final full source run: 2026-10-08. `scripts/verify.sh all` used the documented `SHANNON_NODE_BIN` hook with a temporary wrapper limiting Vitest to two workers. No checks or assertions were removed. The following individual results are valid; the historical Mac smoke result is excluded below.

| Check | Result |
| --- | --- |
| API type/regression | 254 files / 3,281 tests PASS |
| Cognition, evaluation, learning and mind types/regression | 39 files / 425 tests PASS |
| Shared Swift package | 777 XCTest + 157 Swift Testing = 934 PASS |
| iPhone unsigned Debug target, canonical workspace | BUILD SUCCEEDED |
| Mac unsigned Debug target/tests, canonical workspace | 28 XCTest + 5 Swift Testing = 33 PASS |
| Fast checks, product specification and semantic roles | PASS; 150 features, 77 existing accepted gaps, 26 colour roles, 605 shared strings |
| API layers | 0 violations / 0 baseline, original rules unchanged |
| Architecture / 500-line ceiling | 1,139 production source files PASS |
| Runtime entry closure / worker boundary / public port cycles | 8 exact closures, forbidden worker reachability 0, public port cycles 0 |
| Core protection after new files were Git tracked | 12 tests PASS; moved areas and new binding helper explicitly protected |
| Dependency installation | offline / frozen lockfile / ignore scripts PASS; TypeScript 5.9.3 declared as API runtime dependency |
| Release Runner deterministic tests | 8 PASS; no publication performed |
| Staged and unstaged whitespace | PASS |

Focused and independent counts overlap these full runs and are not added. Reviews covered real temporary SQLite/restarts, original proof/late ACK, ordered outbox recovery after 41 newer terminal actions, partial destination commits, frozen dispatch V/audience, first-note audience, reaction withdrawal/rollback/forgetting, night quotas/writer contention, uncertain operation read-back, physical aliases/metadata failure, JSON escape/duplicate keys/depth/suffix limits, strict/module bindings, real numeric test execution and stale validation fencing. No paid model or live external work was invoked.

## Native verification still required

The Mac was locked during this run. The old smoke detector piped `ioreg` into `grep -q` under `pipefail`; early grep completion produced SIGPIPE status 141 and could skip the lock branch. That run reported seven cases passed but is not accepted as unlocked UI evidence. The detector now drains `ioreg` before matching, checks startup and each case, monitors the survival loop, and rechecks before window counting. Shell syntax passes and an actual locked invocation returns 3 before starting the app. Independent synthetic guard/cleanup tests cover initial lock, pre-launch lock, survival relock, pre-count relock, initial/read-loop metadata failure and unlocked completion: seven cases PASS with no child or temporary directory left behind. These are guard tests, not native acceptance. The existing seven real cases, 12-second observation, window count and AppKit constraint checks remain.

After unlock, rerun `scripts/smoke-macos-inspector-launch.sh` against the built Mac target. Verify the new native synthetic fixture on both targets in Light/Dark, primary operations and relevant accessibility/error states. Screenshots must contain only synthetic data. Arguments: `-ShannonStage5Preview interests|feedback|taskTree` followed by the bare `-ShannonDesignPreview` flag. Compile success and the prior HTML prototype are separate evidence.

New Stage 5 production, signed archives, upload, TestFlight assignment/install/smoke, real external ACK recovery and quantitative first-audio comparison are unrun. Present completed native verification with this change before production/distribution approval. Reuse the rollout and seven release gates; do not grant Shannon blanket rights to modify core or production.

## Knowledge return

Syzygy `docs/knowledge/shannon-stage5-learning-boundaries.md` records reusable original-receipt/outbox, validation-vs-dispatch, input-inspection and physical-provenance boundaries. This is a Shannon-verified candidate, not a cross-app standard. The approved plan and Shannon-owned status retain the native blocker and distinguish the unchanged production baseline.
