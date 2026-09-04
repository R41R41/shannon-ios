# Shannon current architecture

Status: implementation authority
Revision: 2026-09-04 / context v16

## System shape

```text
iPhone app
  ├─ Talk / dialogue / threads / memory / settings
  ├─ Keychain pairing token
  └─ local conversation cache
          │ paired HTTPS
          ▼
Azure VM: API + SQLite + background workers
  ├─ FCA response lane
  ├─ emotion, memory, sleep, world and initiative lanes
  ├─ Aether bounded context + proposal inbox
  └─ durable agent-task state
          ▲ authenticated commands/events
          │
Mac Agent Host
  └─ Codex App Server (stdio) in an allowlisted local repository
```

Production endpoint: `https://sh4nnon.com/companion`.

## FCA response lane

The response path is intentionally short and uses one immutable state snapshot:

1. Authenticate the device and resolve the conversation thread.
2. Load the latest committed companion state.
3. Assemble the minimal identity prompt, prompt projection, relevant Aether context, active agent-task projection, and bounded conversation history.
4. Call the fixed chat model once.
5. Store the assistant reply, its selected expression, and any immediate explicit user facts.
6. Enqueue non-blocking emotion, memory, and activity work.

Emotion and memory updates affect the next reply after they commit. Prediction-error processing is not part of v1.

## State and sleep lanes

- Emotion is a continuous shared state updated after conversation events and decayed toward its baseline.
- Direct statements such as preferences and personal facts can update structured knowledge immediately, with evidence and confidence.
- Memory recall and interest changes run outside the response path.
- Sleep consolidation reviews the day's evidence and cautiously updates user knowledge and personality projections. It does not fine-tune the LLM.
- Background jobs are leased, retryable, and resumable after process restarts.

## iOS experience

- Talk, Memory, and Settings form the primary horizontal workspace.
- Talk supports multiple threads, a sliding thread list, scroll mode, and character-focused dialogue mode.
- Assistant messages store the expression used at send time.
- The iOS cache preserves visible conversation continuity while the server remains authoritative.
- Agent-task cards, approvals, progress, and completion are projections of durable server task events.
- Alternate icons are selected from time and committed Shannon state; iOS applies changes only when the OS permits execution.

Live2D and animated widgets remain future work. Current dialogue mode uses a static character-stage asset.

## Aether boundary

Shannon reads only a bounded, purpose-built Aether context projection. Proposed changes are written to Aether's proposal inbox for review; Shannon does not directly rewrite Aether's canonical data.

## World and initiative

RSS and other configured sources are fetched and deduplicated with code before LLM use. Exploration and user-facing chat have separate budgets. Items Shannon never mentions are still cost-accounted. Initiative uses a single scheduled loop with explicit stop decisions.

## User-directed self-improvement

```text
User asks Shannon for a concrete change
  → Shannon proposes an agent task
  → user starts it
  → Azure stores task + command
  → Mac Agent Host claims the command
  → Codex starts in the allowlisted repository
  → Codex reads AGENTS.md + current architecture + runbook
  → progress / approval / changes / tests stream back to Azure
  → iOS can leave and return without losing authoritative status
```

Self-improvement is never initiated autonomously. The Mac host persists the Codex thread, turn, and pending-approval checkpoint identifiers so it can reattach after an Agent Host restart. Azure `agent_tasks` and `agent_task_events` remain authoritative if the iOS app is suspended.

An approval request is valid only on the live Codex connection that created it. After a host restart, an expired approval is cleared rather than inferred. The same durable Shannon task and goal continue from the existing working tree in a clean Codex thread, avoiding unmatched tool calls left in the old history; a fresh approval is requested only when the remaining operation still needs one. The recovery `started` event also clears the stale approval projection in Azure so the app cannot remain permanently waiting on an unresolvable request.

## Durable store

| Concern | Tables |
| --- | --- |
| Companion and chat | `companion_states`, `conversation_threads`, `conversation_messages`, `experience_events` |
| Background and sleep | `background_jobs`, `sleep_runs`, `activity_events` |
| User knowledge | `question_definitions`, `knowledge_answers`, `knowledge_evidence`, `knowledge_revisions`, `personality_profiles`, `prompt_projections` |
| World and initiative | `world_sources`, `subscriptions`, `world_items`, `observations`, `initiative_messages`, `initiative_loop_runs` |
| Notifications | `push_registrations`, `push_delivery_state` |
| Agent work | `agent_tasks`, `agent_task_events`, `agent_commands`, `agent_hosts` |
| Cost | `llm_usage_events` |
| Pairing | device pairing records and device tokens |

## Code ownership

- `apps/ios`: presentation, gestures, local cache, API client, Keychain-facing connection state.
- `apps/ios-app`: entitlements, signing, icons, and application lifecycle.
- `services/api`: contracts, authentication, persistence, chat orchestration, background workers, Agent Host protocol, Aether/world integrations.
- `packages/cognition`: pure shared-state and prompt-projection rules.
- `deploy/macos`: launchd configuration for the local Agent Host.
- `deploy/azure`: production services and configuration examples.

## Production layout

```text
/home/azureuser/shannon-ios/                  # deployed source
/home/azureuser/shannon-ios-data/shannon.sqlite
/home/azureuser/.config/shannon-ios/api.env   # secrets and production settings
```

Systemd services:

- `shannon-ios.service`
- `shannon-ios-worker.service`
- `shannon-ios-world.service`

The local Mac Agent Host runs as `com.shannon.agent-host` and uses the local Shannon repository as its source checkout.

## Deferred by design

- per-user LoRA or fine-tuning
- prediction-error training
- autonomous source-code rewriting
- Live2D runtime
- animated widget character
