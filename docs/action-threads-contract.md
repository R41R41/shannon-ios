# Action threads and the shared mind

Status: implemented on `codex/shannon/adr8-stage4`; independent source review passed on runtime `12dd3688`, production rollout pending. See [verification evidence](action-threads-implementation-report.md).
Revision: 2026-10-08. Production remains Stage 3 (`16bdf384`).

Stage 4 is explicitly enabled by `SHANNON_ADR8_STAGE4=on`, with the Stage 3 workspace enabled. OFF retains the in-process Stage 3 mind, its conversation and autonomy behavior, and the existing device protocols. The new owner route returns 404 while OFF, so older servers do not produce a broken control in the apps.

## One owner, three execution slots

```mermaid
flowchart TD
  API[API: text, voice, platform and owner controls] --> IPC[Private Unix socket: closed messages and ephemeral projections]
  Own[Dedicated autonomy worker: existing cycle notebook and credentials] --> IPC
  IPC --> Mind[One mind worker: workspace and execution rights]
  Mind --> Slots[One foreground response and two background actions per scope]
  Slots --> Notebook[Action journal: IDs, origin, states, generations and hashed resources]
  API --> Agent[Canonical agent_tasks and Agent Host commands/events]
  API --> Body[Canonical Minecraft requests and body reports]
```

`mindWorker.ts` constructs the only Stage 4 `MindHost` after acquiring socket ownership. `infra/sqlite/mindOwnership.ts` holds an OS-backed SQLite writer lock in a separate private file for the worker lifetime; process death releases it. This also serializes stale-socket recovery. The socket directory is owner-only (0700), the socket and ownership file are 0600, and an existing symlink or foreign-owned path is rejected.

The API keeps a bounded projection, not another mind. Owner words in transit are ephemeral. The workspace journal contains closed events and references, never a conversation, task goal, file path or memory text. Workspace rendering re-reads the current memory snapshot after IPC, so forgetting or a changed audience wins over a previously captured snapshot. A late perception response cannot become the next turn's context. A disconnected or expired projection is dropped.

The action journal records `respond`, `ownTime`, `agentTask` and `minecraft`. The originating notebook remains authoritative: autonomy cycles, `agent_tasks`, and Minecraft requests are not copied into a replacement task system. Source IDs deduplicate scheduling. Origin and parent cannot change; descendants inherit origin and owner-informed status. A subsequently marked autonomy cycle marks its existing action too. Minecraft and Agent Host creation from her own time remain withheld by the existing tool-surface policy.

## Rights, stop and recovery

| State | Meaning and permitted next action |
| --- | --- |
| queued | No side effect has begun; admission waits for a slot and its resources. |
| running / waiting | A live generation and holder may renew; each outside operation checks its rights immediately before sending. |
| stopping | No new dispatch; the already sent operation retains resources until an acknowledgement. |
| completed / failed / cancelled | Known terminal outcome. Own-time failed/cancelled work can be explicitly resumed below the failure limit. |
| unknown | A sent result is uncertain. No automatic retry or owner resume; only the original canonical outside acknowledgement reconciles it. |

Leases last 30 seconds and live runners renew every five seconds. Generation, holder and deadline are checked at dispatch, checkpoint and finish. An expired sent lease becomes `unknown`, with a new generation fencing old progress; an expired not-sent lease becomes `cancelled`. Unknown work retains its resource keys. A canonical terminal acknowledgement can close only the immediately previous generation and its original holder. Agent Host also ignores completion from a different Codex turn ID. A stop request is not reported as stopped until the outside turn/body acknowledges it.

Canonical own-time reports and Minecraft terminal acknowledgements use private durable outboxes. An interrupted IPC delivery retries only the recorded acknowledgement, never the model, tool or body request. Own-time usage is recorded in the same transaction as its closed acknowledgement; the mind records an idempotent receipt before the canonical outbox is cleared. A known result delivered after expiry releases only the original attempt's reservation and resources, without granting fresh execution rights. A lost provider response or response body remains uncertain. Minecraft's authenticated claim that omits an old held request is its existing canonical abandonment acknowledgement; silence or lease expiry alone does not acknowledge the outside action. Lost Codex RPC results retain an uncertain host session, original turn identity and resource lock across restart.

Stop-one and stop-all use a request ID and propagate to descendants, excluding the foreground conversation. A queued action cancels immediately. An accepted stop whose HTTP answer is lost is read back; the app never automatically posts the same mutation again. A stale report, recovery, or others present removes controls. Parent termination prevents child resume. Five consecutive identical failures close the action and disable its resume. The own-time limit counts actual step failures, not worker restarts.

A conversation recovery path serializes turns locally while the mind is disconnected. It permits conversation and reads, while outside writes require the mind to reconnect. Accepted long conversations do not retain the four-second admission deadline. Resource contention waits with lease renewal and cancellation; it never grants a write merely because a timer ran out. Tool gates, owner/audience rules and path rules are checked again after the wait. The current local Mac Agent Host shares the coarse Mac-folder lock with folder tools, so a host task and a conversation cannot write that folder together; the cloud host retains its own resource.

## Budget and privacy

Own-time calls retain their dedicated credentials and the canonical daily 2,000 yen cap. Atomic reservations prevent two actions from spending the same remainder. A reservation is released only after the canonical spend ledger records known usage or after a known not-sent refusal. A lost result retains its estimate. An explicit owner request cannot relabel existing own-time work or its descendants to escape the budget. Existing outreach, owner-document, protected-core and proposal approval gates still apply.

`GET /v1/action-threads` and stop/resume routes require the authenticated owner scope. Client-supplied scopes cannot change authority. Summaries expose generic action-kind titles and closed progress/result codes, with no runner, resource, source, task goal or private words. Server body/OBS audience and client audience both withhold detail; uncertainty is private. The apps show only 「作業中」 while others may see/hear them.

The foreground has its own slot, so the own-time loop can continue thinking and working during conversation. This does not loosen the rules for starting a message, showing owner-informed work, making a call or sending a push. Those delivery gates still check conversation and audience at the actual delivery point.

## Apple surface

Talk has a small 「裏で n 件」 capsule. It opens a native iPhone sheet or Mac popover with origin and a word/icon state, stop-one, stop-all and explicit own-time resume. The dialogue/figure location has a compact matching entry. The existing composer and navigation stay primary. Unknown, stopping, five failures, recovery, stale reports, empty, others present and old-server absence have explicit states. A known stopped own-time action retains a 「停止済み」 entry for explicit resume even when nothing is running. Controls have at least 44-point targets; native dismissal restores capsule focus. No custom motion is required.

Copy comes from `design/strings.ja.json`. The DEBUG-only `ShannonPreviewActionThreads` fixture uses synthetic data and no server; `ShannonPreviewActionState=unknown|recovering|others` exercises uncertain states. These flags are used only with the existing design-preview connection store.

## Validation and rollout

Deterministic tests cover slot admission, lease/generation fencing, resource contention, stop acknowledgement, request read-back, reservations, five failures, stale Codex completion, actual own-time execution, retained outreach gates, server audience, forgotten memory and socket ownership/reconnection. Swift tests cover late replies, server/client audience changes, stop read-back and old-server absence. Apple build, visual and latency evidence is recorded in the [Stage 4 implementation report](action-threads-implementation-report.md); these are not evidence of a TestFlight install.

Before rollout: independent core review, all regression and architecture checks, VM typecheck/tests, DB backup and integrity check, plus the seven Apple release gates for distribution. Install the new API and Agent Host protocol while the switch is OFF before enabling Stage 4; older hosts are refused when ON. Register `deploy/azure/shannon-ios-mind.service` with the existing private environment file. Then explicitly enable Stage 4 for API, mind and autonomy together and verify one mind, lease recovery, auth 401, data counts and all services. A local measurement does not replace VM latency verification. Leave Sonnet and budget changes outside this rollout. The [operator rollout procedure](action-threads-rollout.md) includes the quiet interval, both Agent Hosts, effective units and separate Apple gates.

For recovery, inspect canonical task/body outcomes before reconciling unknown work. Never fabricate an acknowledgement or delete a resource lock to make a task run. Switching OFF is a rollout recovery measure; restoring intended Stage 4 behavior still requires resolving the root cause.

## Candidate original-resource acknowledgement

`action.reconcileResource` is private mind IPC, not an owner HTTP tool. Its default-deny proof runs inside the action writer transaction and can remove only a dynamic resource from an original unknown lease (generation minus one / last holder). Immutable acknowledgement IDs retain exact payloads. It never clears unknown action state, sent/result, base or other resources, or budget reservations. The configured Minecraft proof re-reads accepted original lifecycle receipts and all original physical commands. The adapter and writer both require actual input release; matching current state is insufficient. Native command insertion also rechecks lease/resource ownership under `BEGIN IMMEDIATE`, fencing both orders of the cleanup/release race.
