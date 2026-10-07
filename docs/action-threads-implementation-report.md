# Stage 4 implementation evidence

Owner: ライ氏. Implementation: Codex, `codex/shannon/adr8-stage4`, based on `16bdf384`.
Observed: 2026-10-08 (JST). Reviewed runtime source: `12dd3688378c37fd2570db7c4700b276ec4f575a`. Measurement interruption cleanup is a separate script-only fix at `e260e66e`.
Production and `main` remain Stage 3 at `16bdf384`; Stage 4 defaults to OFF.

The implemented architecture and diagram are in [action-threads-contract.md](action-threads-contract.md). The concrete cutover and recovery procedure is [action-threads-rollout.md](action-threads-rollout.md). This report records source, isolated process and Apple preview evidence separately from production acceptance.

## Resulting behavior

- One separately owned mind worker, private Unix IPC, bounded projections, deadlines and disconnect recovery. Delivery rechecks the current audience and forgotten memory. An API recovery path does not create a second mind.
- One foreground slot and two background slots per scope, immutable origin, inherited marks, generations, hashed resource locks and atomic own-time budget reservations. Sent background work retains its slot while its outcome is unknown.
- Existing own-time cycle, Agent Host task and Minecraft request records remain canonical. Stop propagates to descendants; sent work waits for its original canonical acknowledgement. Unknown results retain locks and are not replayed automatically. Five repeated actual failures close one action.
- Existing outreach, incoming call, tool, owner-document and core gates remain. Own-time thinking may continue during a conversation; unsolicited delivery still passes its existing gates. Dedicated credentials, daily budget, Sonnet and the owner's evidence-decay choice are unchanged.
- iPhone sheet and Mac popover show generic titles, origin and states. Individual/all stop and explicit known own-time resume use one POST and read-back when uncertain. Server/client audience checks withhold details; old-server 404 hides the entry. A late control response cannot override a newer privacy poll.
- Cross-part imports use narrow ports. Registered API-layer exceptions shrink from 69 to 43, with no new exceptions. The memory visibility port avoids unrelated writers and an import cycle. The new early-event helper is explicitly protected as approval/budget core and registered only in its actual Agent Host entry closure.

## Review defects and permanent fixes

Three independent reviewers covered the protected core, API/Apple state and outside-operation adapters. All passed on exact source `c1bc5dbb`; the final admission change was independently rechecked by the external and API reviewers on exact runtime `12dd3688`. No unresolved actionable runtime finding remains in those reviewed scopes. Reproductions drove the following changes:

- Own-time outcomes, actual usage and closed ACKs persist in one canonical transaction. ACK-only retries settle known old budget and release only the appropriate original resources; they never run the model/tool again or erase an explicit queued resume. Known unused reservations persist a zero ACK even if delivery fails.
- Transport loss after HTTP headers, absent/malformed usage and unknown outside results remain uncertain. Legitimate measured zero usage is accepted. Every paid retry checks its action permit immediately before sending; an initial refusal with zero calls records known zero usage. The OFF path preserves the old behavior, including byte/schema golden checks.
- Agent Host recovery matches the saved original turn. Lost start responses and foreign turns do not grant an identity or release a lock. Terminal events persist with the original lease/event ID before clearing the turn, and retry idempotently after restart.
- Notifications/results/approvals arriving before a successful `turn/start` response are bounded (512 events / 2 MiB), correlated only to its returned ID and replayed in order after the owning command finishes its start handling. A concurrent execution timer cannot take another command's pending events. Foreign/unattributed approvals are rejected; lost response or overflow remains unknown. Original results and verification evidence still complete normally.
- Minecraft stores its first canonical result and ACK outbox atomically. Authenticated holding omission is an abandonment report; silence/lease expiry alone is not an ACK. Conflicting duplicates do not replace that first result. ACK retries do not repeat an outside operation.
- VM admission latency exceeded the target reproducibly. Respond-only enqueue/claim now shares one durable transaction and one RPC, retaining the same draft/idempotency/parent/sweep/slot/resource/generation/deadline checks and SQLite FULL. A busy slot retains its queued intent; a SQL failure rolls back the whole admission. Other action kinds retain their earlier path.
- Audience is checked after IPC at delivery. Apple discards an overtaken control response and performs a GET read-back. API-layer/source guards explicitly cover new core helpers; Git-based closure checks were rerun after tracking the new file.

## Deterministic verification

No paid model, Codex or Minecraft operation was used. All fixture databases and worker sockets were isolated; VM checks loaded no production environment, pairing or database.

| Check | Result and scope |
| --- | --- |
| Local full API/cognition/evaluation/learning/mind suite | 275 files / 3,497 tests passed on `2ade1df7`, before the last bounded early-event helper and test-only VM portability change |
| Final changed external/source targets | Six files / 84 tests passed before freeze; final bridge 35 passed after the last identity normalization |
| Exact `c1bc5dbb` independent rechecks | Core review: four files / 70 tests; external review: bridge/core/closures 59 tests; API/Apple review reran the original ordering reproduction and checked unchanged Swift/TF source |
| Final admission rechecks | Four target files / 82 tests passed; independent exact runtime checks also passed 82 targets + 24 core/closure tests, original model/budget reproductions and an atomic rollback/resource/stop reproduction |
| Final tracked-source fast checks | Passed on `12dd3688`: source size, protected paths/entry closures, layer baseline, product specification and shared strings |
| Types | API plus cognition/evaluation/learning/mind passed locally; final VM result below |
| Shared Swift | 777 XCTest + 145 Swift Testing passed; eight focused action-thread model tests passed |
| Apple build components | Mac unit: 28 XCTest + 5 Swift Testing; release-runner: 8 passed. Unsigned macOS Debug and iOS device Debug passed after review fixes. Earlier Simulator Debug also passed; subsequent Swift source is unchanged |

The real `mindWorkerLifecycle.test.ts` launches the production worker entry with a synthetic database and no inherited credentials. It rejects a duplicate owner, verifies private socket permissions, SIGKILLs the owning process, restarts it, rejects old-generation rights and releases an uncertain resource only after its original canonical ACK. This passed locally and is included in the VM full suite.

VM portability preserves mandatory server/shared core-path checks. Only the separate Apple-path existence check skips when the entire `apps/` tree is absent; local checks still verify all app paths. Git-listing guards skip without a Git checkout. These deployment-layout skips are reported explicitly.

The isolated VM verified all **1,334 candidate files** against Git source hashes. On runtime `12dd3688`, API plus all four package typechecks passed and the complete suite passed **275 files / 3,508 tests**, with **3 deployment-layout skips** (two Apple-dependent checks and one Git-listing check), in 388.58 seconds on Node v24.20.0. The real process-death/one-owner lifecycle case passed as part of that suite; no unhandled error occurred. The prior exact `c1bc5dbb` VM run also passed 275 files / 3,502 tests / 3 skips before the admission change. The last script-only cleanup fix leaves these production/runtime/test trees identical.

## Apple interaction evidence

Native CUA inspected a separate synthetic Debug Mac bundle, leaving the installed production app unopened. Light/dark, individual/all stop, retained entry at zero running count, explicit known own-time resume, avatar entry, unknown/stopping/five-failure states and Escape restoring capsule focus were exercised. Unknown has no resume button. Follow-up CUA rechecked live count/state changes and stop/resume after the response-ordering fixes. Synthetic screenshots: [light](screenshots/shannon-stage4-macos-light.png), [dark](screenshots/shannon-stage4-macos-dark.png), [unknown](screenshots/shannon-stage4-macos-unknown.png), [review](screenshots/shannon-stage4-macos-review.png).

A dedicated iPhone 17 / iOS 26.5 Simulator ran the synthetic preview. CUA checked the entry alongside the existing task notice, medium sheet, individual stop/resume and live count updates. [iPhone light](screenshots/shannon-stage4-ios-light.png). A launch crash in a capsule value-copy path was corrected by retaining the observable model directly, rebuilding its callers and rechecking launch/interactions. iPhone dark, avatar entry, all-stop gesture and expanded-sheet interaction remain unverified.

Real VoiceOver speech, Dynamic Type, Reduce Motion, physical-device interaction and production networking remain unverified. Shared model tests verify privacy invalidation, stale timestamps, old-server/disconnect behavior, single POST/read-back, explicit known resume and overtaken control responses. Previews were quit, the dedicated Simulator shut down and resource claims released.

## IPC and production read-only preflight

The final benchmark starts the production `mindWorker.ts` as a separate child with no inherited credentials and uses a real Unix socket and isolated synthetic database, with 20 warm-ups and 200 samples per operation. SIGINT/SIGTERM cleanup stops its owned child and removes the temporary data. We compare each warm operation against the 5/10 ms budget as a diagnostic; individual operations do not certify the plan’s actual first-voice-audio target.

| Warm macOS IPC, final admission code / production child | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Workspace perception/projection | 0.330 ms | 0.997 ms | 4.293 ms |
| Foreground atomic admission | 0.501 ms | 1.914 ms | 5.117 ms |

| Warm VM IPC on `12dd3688`, production child, after full regression | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Workspace perception/projection | 0.782 ms | 1.420 ms | 3.679 ms |
| Foreground atomic admission | 4.710 ms | 8.284 ms | 19.965 ms |

Both operations meet the warm 5/10 ms targets. A separate initial post-change VM sample also passed (workspace 0.712/1.065 ms; admission 4.220/6.660 ms). The independently reviewed `e260e66e` script was also measured on the VM: workspace p50 0.749 / p95 1.488 / max 3.138 ms; admission p50 4.714 / p95 8.804 / max 112.278 ms. Its percentiles stayed within the budget, while the observed outlier is retained in this record. No end-to-end or worst-case voice guarantee follows from these samples. Its parent-only SIGINT/SIGTERM and ordinary-run cleanup, exit codes 130/143/0, 200 samples and standalone strict typecheck passed independent review.

The previous in-process VM benchmark on `c1bc5dbb` measured foreground enqueue/claim p50 8.606 / p95 14.791 ms; an independent repeat gave 8.260 / 16.048 ms. The action connection retained WAL/FULL/busy timeout 250 ms; enqueue and claim each committed durably. The measured disk flush count supported storage as the main cause, without proving exclusive attribution. The final process-separated benchmark strengthens the conditions, so its absolute result is recorded without claiming an exact percentage improvement against the earlier in-process samples.

The benchmark excludes models, recognition, TTS, device/network latency and cold reconnect. Normal voice admission precedes server `turnStartedAt`, so server model-duration metrics omit that admission. Waiting audio can start before the reply model dispatch; a reply without waiting also incurs the separate send-time dispatch check/commit and any outstanding workspace sync. Nonstream replies can await finish/journal flush before their first segment. These gates remain. Same-condition Stage 3→4 device first-audio comparison remains a separate production acceptance check; individual microbenchmark success does not complete it.

Read-only VM preflight found production revision `16bdf384`, all five existing services and distribution timer active, unauthenticated auth 401 and live SQLite integrity `ok`. Aggregate counts were 42 conversation threads, 1,308 messages, ten terminal tasks and five device registrations. Tailscale IPv4 timed out; the same peer's IPv6 worked with its existing host-key identity preserved. No production source, unit, flag or process was changed.

## Included distribution repair

The separate TestFlight repair at `8358754d` passed exact-commit independent review and seven synthetic tests. Its changes were cherry-picked as `8460f6dc` and `b8467e86`; the three integrated files match the reviewed original. Platform selection uses `filter[preReleaseVersion.platform]=IOS` by default and preserves explicitly configured Mac selection. The effective distributor unit must run reviewed `/home/azureuser/shannon-ios` source. Applying only the repository template does not change a running systemd unit; install the effective unit and run `daemon-reload` as the rollout specifies. The separate writable Agent Host checkout stays intact. No distribution/unit mutation occurred.

## Prepared delivery and remaining acceptance

A reviewable deploy bundle is prepared at `/tmp/shannon-stage4-deploy-candidate`: `source.tar`, added/modified/deleted lists, old-file hashes, old-source inventory and manifest. Excluding Apple/design/screenshots as the Azure runbook requires, it contains **43 added / 80 modified / 0 deleted** files. Read-only production preflight matched all **80 old hashes**, found no pre-existing added path or extra old API source, and confirmed the baseline revision. The manifest identifies the final candidate, including this documentation; its production/runtime/test trees match the verified `12dd3688` and its measurement script matches reviewed `e260e66e`.

The next production action requires the owner's final delivery approval under the shared Azure runbook. It includes source/dependency and consistent SQLite backups, installing compatible code while OFF, updating both Azure and Mac Agent Hosts, installing the mind/distributor effective units, enabling Stage 4, health/ACK/quiet-interval checks and the corresponding iPhone/Mac release. No main integration/push, production restart, Stage 4 enabling or TestFlight release occurred during implementation.

Real authorized Agent Host/Minecraft stop/finish, first voice audio comparison and existing-data acceptance remain rollout checks. Windows body implementation/visual acceptance belongs to its separate repository; Minecraft enablement remains subject to its existing plan. Deterministic adapter evidence does not certify another repository's implementation.

Only unsigned local Apple Build evidence is available. Archive, Upload, Processing, Assignment, Install and human Smoke remain separate gates for both platforms. The owner's earlier successful learning-screen confirmation concerns Stage 3 and does not count as Stage 4 acceptance.
