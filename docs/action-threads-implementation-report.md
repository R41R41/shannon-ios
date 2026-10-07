# Stage 4 implementation evidence

Owner: ライ氏. Implementation: Codex, `codex/shannon/adr8-stage4`, based on `16bdf384`.
Observed: 2026-10-07. Production remains Stage 3 at `16bdf384`; Stage 4 is OFF by default.

The implemented contract and architecture diagram are in [action-threads-contract.md](action-threads-contract.md). This report distinguishes source verification, isolated Apple previews and production acceptance.

## Implemented slice

- One separately owned mind worker, private Unix IPC, bounded projections, deadlines and disconnect recovery. Current audience and forgotten memory are checked after communication. No second mind is created by an API recovery path.
- One foreground slot and two background slots per scope, with immutable origin, inherited marks, generations, hashed resource locks and atomic own-time budget reservations.
- Existing own-time cycle, Agent Host task and Minecraft request records remain canonical. Stop propagates to descendants; sent work waits for its canonical acknowledgement. Unknown results retain locks and are not replayed automatically. Five repeated actual failures close one action.
- Existing outreach, incoming call, tool, owner-document and core gates remain. Own-time thinking may continue during a conversation; that does not authorize an unsolicited delivery during it.
- iPhone sheet and Mac popover show generic titles, origin and states; individual/all stop and explicit known own-time resume use a single POST followed by read-back when uncertain. Server and client audience flags both withhold details. Old-server 404 hides the entry.
- Cross-part imports now use narrow ports. The registered API-layer exceptions shrink from 69 to 43, without new exceptions. The memory visibility port avoids importing unrelated writers and prevents an import cycle.

## Deterministic verification

The complete API/cognition/evaluation/learning/mind regression was rerun after fixing OFF-path timing, long-session lease checks and the explicit source/closure fixtures. The final serial run passed **274 files / 3,409 tests**, including known-versus-lost model acknowledgement and explicit resume after a known stopped thought. No model API was called.

Targeted tests include the real own-time loop with a foreground slot, abort before committing a stopped step, retained outreach gates, two-versus-three admission, same-resource writes, Mac host versus Mac-folder write contention, old-generation progress, canonical stop acknowledgement, wrong Codex turn completion, lost stop response, parent stop, five failures, budget competition, forgotten memory after IPC, expired projections and socket ownership. The final narrow adapter run passed 10 tests. Concurrent Simulator/build repeats hit a Stage 3 switch-matrix wall-clock limit and a worker RPC timeout; their assertions were not changed. The final run ended those processes, used one Vitest worker and a 60-second wall-clock limit, and passed without unhandled errors. The switch matrix itself passed all four cases in 12.2 seconds (also previously passed with its default 30-second limit).

Shared Swift: the final full run passed 774 XCTest and 145 Swift Testing tests, including five new action-thread tests: audience change invalidates a late reply, server audience hides/returns detail, a lost stop response performs read-back without a second POST, old-server/disconnect handling hides the entry, and known stopped own-time work keeps its explicit resume entry. The final focused run passed six tests after adding rejection of stale server timestamps; an old report cannot become fresh merely by arriving late.

Mac unit tests passed 28 XCTest and 5 Swift Testing tests. Release-runner tests passed all eight cases. Final unsigned macOS Debug, arm64 iOS Simulator Debug and iOS device Debug builds succeeded, including the direct observable model reference. `scripts/verify.sh all` is represented by its component checks; its shell-based GUI launch smoke is replaced by native CUA preview inspection, preserving the restriction against shell UI automation.

## Apple interaction evidence

Native CUA inspected an isolated Debug Mac bundle, never the installed production app. Ready state was inspected in light and dark appearance. Individual stop, all stop, retained entry at zero running count, explicit own-time resume, avatar entry and Escape returning focus to the invoking capsule were exercised. Unknown, stopping and five-failure states were inspected; unknown has no resume button. Screenshots are synthetic, not owner conversations: [light](screenshots/shannon-stage4-macos-light.png), [dark](screenshots/shannon-stage4-macos-dark.png), [unknown](screenshots/shannon-stage4-macos-unknown.png).

The dedicated iPhone 17 / iOS 26.5 Simulator launched the final synthetic preview. CUA verified the conversation entry alongside the existing task notice, opening the medium sheet, individual own-time stop and explicit resume with live state/count updates. [iPhone light](screenshots/shannon-stage4-ios-light.png). A transient simulator launch crash in the capsule value-copy path was found during inspection; the view now holds the observable model directly, with its callers rebuilt, and the final launch and interactions passed. iPhone dark, avatar entry, all-stop gesture and expanded-sheet interaction remain unverified.

Six shared model tests cover privacy invalidation, stale timestamps, old servers, disconnection, single-post/read-back and resumable stopped work. Real VoiceOver speech, Dynamic Type, Reduce Motion, physical-device interaction and production networking remain unverified.

## Local IPC latency

`scripts/measure-action-thread-ipc.ts` uses a real mind worker/socket and synthetic isolated databases, with 20 warm-up calls and 200 measured calls per operation. This is warm local macOS IPC, not a VM or voice end-to-end measurement.

| Operation | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Workspace perception/projection | 0.181 ms | 0.272 ms | 1.349 ms |
| Foreground enqueue/claim | 0.406 ms | 0.627 ms | 1.245 ms |

The local added-communication target (p50 ≤ 5 ms, p95 ≤ 10 ms) is met. The previously recorded Stage 3 render p95 is 3 ms for text and 2 ms for voice. VM load, cold reconnect and first-audio comparison still need verification before enabling Stage 4.

## Acceptance still required

Independent review of the protected core and outside-operation adapters is pending. VM regression, production DB backup/integrity/count checks, service registration, one-mind confirmation and real Agent Host/Minecraft acknowledgement exercises are unrun. No production paid call, credential/budget change, Sonnet enabling, main integration or Stage 4 deployment occurred.

For Apple distribution, only unsigned local build/preview evidence is available. Archive, upload, processing, assignment, TestFlight install and human smoke for Stage 4 are unrun. The owner's earlier confirmation of the learning screen concerns Stage 3 and is not a Stage 4 acceptance.

Windows body implementation/visual acceptance remains owned by its separate repository. Minecraft rollout remains subject to its existing plan. The independently reviewed TestFlight platform selection and effective-unit source repair is now included in this candidate; the original `codex/shannon/testflight-platform` branch is retained. Production application is still pending.

## Final reproducible checks

- Bundled Node: `node node_modules/vitest/vitest.mjs run services/api/tests packages/cognition/tests packages/evaluation/tests packages/learning/tests packages/mind/tests --maxWorkers=1 --testTimeout=60000`: 274 files, 3,409 tests, all passed. See `/tmp/shannon-stage4-serial-regression.log` for this local run.
- API TypeScript check passed; cognition/evaluation/learning/mind TypeScript checks passed. `bash scripts/verify.sh fast` passed, including source size, protected paths/closures, layer baseline and product/shared-string checks. `git diff --check` passed.
- Shared Swift full suite: 774 XCTest and 145 Swift Testing passed; final six focused action-thread model tests passed. Mac unit suite: 28 XCTest and 5 Swift Testing passed; release-runner: 8 passed.
- Xcode final unsigned Debug builds: ShannonDesk/macOS, ShannonApp/iOS device and ShannonApp/arm64 Simulator passed. Only one Swift/Xcode build ran at a time; the final Mac/device compiler concurrency was one.
- CUA final isolated Mac/iPhone previews confirmed rendering and observable state updates. Dedicated Simulator shut down; previews quit; resource claims released. Shared hub validator passed.

No main integration, push, production restart, Stage 4 switch enabling or TestFlight release was performed. The next step is independent review against the implementation contract, followed by the VM and Apple acceptance gates above.

## Independent review follow-up

The first three independent reviews reproduced defects in late own-time acknowledgement/budget settlement, lost Codex RPC responses, Minecraft abandonment acknowledgement, paused-task steering, server audience changes during IPC and old Apple control responses overtaking a newer poll. The follow-up preserves stop/resume and the existing protocols while correcting those causes. Known canonical acknowledgements are persisted and delivered idempotently; uncertain external outcomes retain their locks and are not replayed. A provider response body lost after HTTP headers remains uncertain rather than a zero-cost known failure.

The real `mindWorkerLifecycle.test.ts` launches the production worker entry point with an isolated database and no inherited credentials, rejects a duplicate process, kills its owner with SIGKILL, restarts it, rejects old rights and verifies that only the original canonical acknowledgement releases an uncertain resource. It passed locally.

Apple follow-up verification passed all **777 XCTest + 145 Swift Testing tests**, including eight action-thread model tests and the two new response-ordering cases. Unsigned ShannonDesk/macOS and ShannonApp/iOS device builds passed. Native CUA launched a separate synthetic Mac bundle and verified individual stop, explicit resume, observable count/state updates and Escape returning capsule focus. [Review preview](screenshots/shannon-stage4-macos-review.png). The preview was quit; the installed production app was not launched. These remain local build/synthetic evidence, not TestFlight acceptance.

Read-only VM preflight confirmed revision `16bdf384`, the five existing services and distribution timer active, unauthenticated auth 401 and live SQLite integrity `ok`. Aggregate counts were 42 conversation threads, 1,308 messages, ten terminal tasks and five paired devices. A separate `/tmp` directory holds copied dependencies for candidate verification; it contains no copied production database, pairing or environment file. IPv4 SSH timed out while the same Tailscale peer's IPv6 worked with its existing host-key identity preserved. Production source, units, flags and processes were not changed.

The separate TestFlight repair at `8358754d` passed its exact-commit independent review and seven synthetic tests. Applying it requires updating the effective systemd unit and `daemon-reload`; a repository template alone does not change the timer's actual executable. Its reviewed changes were cherry-picked as `8460f6dc` and `b8467e86` into the Stage 4 candidate for combined validation; the original branch remains intact. No distribution or production unit was changed.

Final candidate regression, VM isolated verification and exact-commit re-review are recorded below when they finish. The [rollout procedure](action-threads-rollout.md) makes the pending source/unit/host/flag cutover and Apple gates explicit.
