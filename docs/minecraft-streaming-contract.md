# Minecraft execution while streaming

Owner decision: 2026-10-30, Rai「マイクラしながらでも配信できるようにしてほしい」. Implemented candidate; production delivery requires the owner's next selection.

## Why the two used to conflict

The Windows OBS output reports audience `others` for as long as its output server is enabled, including an OBS preview. This remains correct: it does not prove that only the owner can see or hear the character. The common owner-request scheduler, step runner, body adapter, command transport and operator lifecycle previously required owner-alone execution together. Enabling OBS therefore cancelled game commands, reconciled the lost step and left its task queued; even operator logout was refused.

The OBS report, private chat/voice/memory rules and ordinary conversation tools keep their real audience. Nothing makes a stream look private.

## Standalone game execution

The LLM-centric Minecraft mode may continue while audience is `others` only for a standalone operator request with all of these canonical facts:

- Owner scope, generic kind, owner-request origin and the Minecraft admission's completion criteria.
- A direct root parent, no child tasks and a configured Minecraft body binding.
- The immutable accepted operator request audit row names this exact task.
- The task has no inherited conversation, memory or document sources.

The title, a client-supplied audience, a body binding alone or a completion-criteria string alone proves none of this. Missing records, unreadable authority and another scope fail closed. A conversation-derived or previously private task is not made public by turning on OBS. For a stream, start an independent game request through the operator path; only the explicitly supplied game goal is its input.

The composition applies isolation on every game-only step, including before a stream starts: the existing Minecraft instructions, game history, plan and observations remain; personal recall, body recall, shared-context preparation, private research readers, skill indexes and task-to-task tools are absent. The fixed menu remains `mc.act`, `mc.probe`, `mc.view`, `plan.update` and the model's wait/complete controls. No new model, planner, feature switch or body protocol is introduced. Game feelings may still receive the existing outcomes; no private feeling context returns to the game decision.

The audience exception is checked in the scheduler, step/observation guards, tool execution and command polling, independently of each original action lease and budget. A newly attached private source or child revokes public execution immediately. Already delivered uncertain actions still require their original release proof; no replay, new lease privilege or disclosure exception is created.

## Server and bot lifecycle

Audited operator `start`, `stop`, `login` and `logout` may run during streaming. They still require their exact original operator action/ID, owner scope, registered server, live lease, body resource and original receipt. Stop retains native other-player admission closure and the authenticated-bot-only exemption; no force stop is added. Unknown operations still block new ones. `set_day` remains owner-alone. Conversation and own-time lifecycle permissions keep their existing gates.

## Verification and release

`minecraftStreaming.test.ts` exercises the real SQLite task runtime/action leases, audience switching during a decision, body command delivery, private-source revocation, a forged operator title, private-tool rejection and the production `mc.act` queue. `operatorMinecraft.test.ts` covers independent request admission. `operatorLifecycle.test.ts` exercises audited login/logout under a public audience, wrong/missing audit rejection and the retained owner-alone day-change rule. Existing source/disclosure, lifecycle-native stop, budget and unknown/recovery suites remain applicable.

These are deterministic local tests with scripted inference and actuators. They do not establish a successful paid Minecraft run or a real livestream. The OBS setting stays on. No new run starts without the owner's choice. Source preparation and production rollout are reported separately.
