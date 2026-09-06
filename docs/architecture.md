# Shannon current architecture

Status: implementation authority
Revision: 2026-09-06 / iOS 26 SpeechAnalyzer migration

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
Agent Host
  ├─ current: Mac + Codex App Server
  └─ staged: Azure-isolated Codex workspace → private GitHub → Xcode Cloud → TestFlight
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

For a newly created thread without an explicit title, the first successful user/assistant exchange also produces a short title in that same model call. The store commits the title and both messages in one transaction, rechecking title ownership after the model returns. Manual edits always win, including an explicit edit to `新しいトーク`. Missing or invalid title metadata falls back to a bounded excerpt of the user message without failing the reply. The chat response includes the committed thread so iOS can update and cache its list immediately; older responses still use the existing thread-list refresh.

SQLite schema v8 adds `conversation_threads.title_origin` (`pending`, `automatic`, or `manual`). Migration preserves all existing titles as manual because older rows have no edit provenance. Only newly created untitled threads are eligible for automatic naming. The migration is additive and runs inside the existing restart-safe migration transaction.

Emotion and memory updates affect the next reply after they commit. Prediction-error processing is not part of v1.

## State and sleep lanes

- Emotion is a continuous shared state updated after conversation events and decayed toward its baseline.
- Direct statements such as preferences and personal facts can update structured knowledge immediately, with evidence and confidence.
- Memory recall and interest changes run outside the response path.
- Each recall pass replaces the complete active-memory set with one bounded state event. Pinned experiences are retained, and unchanged recall does not create another state version, event, or prompt projection.
- Persisted companion snapshots are restored through the same text, collection, and numeric bounds as live updates. Older snapshots without newer optional collections remain readable, while malformed nested values are discarded or reset to safe defaults.
- Sleep consolidation reviews the day's evidence and cautiously updates user knowledge and personality projections. It does not fine-tune the LLM.
- Background jobs are leased, retryable, and resumable after process restarts.

## iOS experience

- Talk and Memory share a root switcher that changes only on an explicit tap; there is no interactive horizontal page swipe.
- Settings opens independently from the gear button instead of behaving like a third content page.
- Talk supports multiple threads, a sliding thread list, scroll mode, and character-focused dialogue mode.
- The thread list has a visible button. A left-edge swipe is retained only as a secondary shortcut on Talk.
- Assistant messages store the expression used at send time and place a 36pt avatar, name, emotion, time, and copy action in one compact header so the reply body can use the full content width.
- Dialogue mode is a presence stage rather than a framed portrait: ambient depth, a subtle reduced-motion-aware breathing treatment, the current emotion, the latest user utterance, and Shannon's reply share one scene. The redundant corner avatar is not shown.
- Running agent work lives in the common header task menu and beside its source message. The composer-area task capsule is reserved for unacknowledged approval, completion, failure, or cancellation states that need attention.
- The iOS cache preserves visible conversation continuity while the server remains authoritative.
- Agent-task cards, approvals, progress, and completion are projections of durable server task events.
- Alternate icons are selected from time and committed Shannon state; iOS applies changes only when the OS permits execution.
- Settings → App Icon shows the actual bundled primary and alternate icon artwork. Fixed mode previews the primary Shannon mark, automatic mode shows representative time/emotion variants, manual mode shows every selectable icon, and the currently active icon remains visible at the top.
- Voice is user-initiated and half-duplex: iOS 26 and later use Apple's on-device `SpeechAnalyzer` without the legacy speech-authorization call; older supported iOS versions use `SFSpeechRecognizer` and request its authorization only while the state is undetermined. The resulting Japanese text follows the existing FCA route, and the reply uses the system Japanese voice. Raw audio is not retained.
- The iOS 26 capture path gives the `AVAudioEngine` tap a small, bounded role: it makes an independent PCM snapshot before the engine can recycle its callback buffer, then puts that snapshot into a newest-four async queue. A separate feeder converts it to the analyzer format and creates `AnalyzerInput` values. On stop, the feeder drains queued audio and closes the analyzer input before finalization so the final phrase is not discarded. This retains the WWDC25 SpeechAnalyzer asynchronous pipeline while avoiding a cross-thread reference to engine-owned audio storage. The installed Xcode 26.5 SDK does not expose the newer `AnalyzerInputConverter` helper, so Shannon retains its own `AVAudioConverter` feeder.
- Voice startup writes privacy-bounded, immediately flushed checkpoints before and after permission, audio-session, input-format, tap, and engine-start operations. It also records the first captured buffer, first converted buffer, and first recognition result. Settings → Voice Diagnostics can copy the bounded report after a crash; audio, transcripts, messages, tokens, and credentials are never recorded.
- The composer uses a dynamic bottom safe-area inset, so multi-line input, voice status, failures, and task notices do not cover the latest reply.

Live2D and animated widgets remain future work. Current dialogue mode uses a static character-stage asset.

Full-duplex interruption and background voice activation are deliberately later work.

## Aether boundary

Shannon reads only a bounded, purpose-built Aether context projection. Proposed changes are written to Aether's proposal inbox for review; Shannon does not directly rewrite Aether's canonical data.

## World and initiative

RSS and other configured sources are fetched and deduplicated with code before LLM use. Exploration and user-facing chat have separate budgets. Items Shannon never mentions are still cost-accounted. Initiative uses a single scheduled loop with explicit stop decisions.

The same world worker creates at most one `daily_mind` focus per owner and local day. It first reuses the current focus, otherwise selects one bounded public candidate and may spend one low-cost background-model call to write a topic, reason, and possible opening line. Failure or exhausted monthly background budget falls back to a local focus. The focus is explicitly marked as Shannon's attention—not a user fact—and is shared by the next chat prompt, Memory's “今日の関心”, and the existing initiative loop. There is no second initiative scheduler or response-path wait.

Initiative still decides in code whether to speak or remain quiet. When it speaks, it may use the saved daily opening line; quiet hours, recent conversation cooldown, duplicate-source protection, and the one-message-per-day limit remain authoritative. Memory shows today's background spend alongside the existing monthly budget, and sleep diaries use short first-person summaries without changing the underlying evidence report.

## User-directed self-improvement

```text
User asks Shannon for a concrete change
  → Shannon proposes an agent task
  → user starts it
  → Azure stores task + command
  → the explicitly selected Agent Host claims the command
  → Codex starts in the allowlisted repository
  → Codex reads AGENTS.md + current architecture + runbook
  → progress / approval / changes / tests stream back to Azure
  → iOS can leave and return without losing authoritative status
```

Self-improvement is never initiated autonomously. The selected host persists the Codex thread, turn, and pending-approval checkpoint identifiers so it can reattach after an Agent Host restart. Azure `agent_tasks` and `agent_task_events` remain authoritative if the iOS app is suspended. Host and project hints are preserved from the model proposal through the iOS start request, and an explicitly targeted task can be claimed only by that host.

The staged cloud host uses a writable checkout separate from the running API deployment. Cloud work happens on a task branch. Tests must pass before any main-branch integration, and GitHub/TestFlight delivery requires an explicit user request plus an operation-time approval. Xcode Cloud builds and signs iOS artifacts; the Linux VM never attempts to build or sign the iOS app itself.

An approval request is valid only on the live Codex connection that created it. After a host restart, an expired approval is cleared rather than inferred. The same durable Shannon task and goal continue from the existing working tree in a clean Codex thread, avoiding unmatched tool calls left in the old history; a fresh approval is requested only when the remaining operation still needs one. The recovery `started` event also clears the stale approval projection in Azure so the app cannot remain permanently waiting on an unresolvable request.

A Codex turn ending is not itself task completion. The Agent Host requires a structured terminal result from Codex and records `completed` only when Codex explicitly confirms that every applicable acceptance and runbook condition passed. A failed recorded verification always wins over a completion claim. Missing verification, an unavailable build host, an outstanding approval, or remaining deployment work projects the durable task as `paused` with one concrete next action so the same task can resume later.

## Durable store

| Concern | Tables |
| --- | --- |
| Companion and chat | `companion_states`, `conversation_threads`, `conversation_messages`, `experience_events` |
| Background and sleep | `background_jobs`, `sleep_runs`, `activity_events` |
| User knowledge | `question_definitions`, `knowledge_answers`, `knowledge_evidence`, `knowledge_revisions`, `personality_profiles`, `prompt_projections` |
| World and initiative | `world_sources`, `subscriptions`, `world_items`, `observations`, `daily_mind`, `initiative_messages`, `initiative_loop_runs` |
| Notifications | `push_registrations`, `push_delivery_state` |
| TestFlight operations | `testflight_delivery_runs`, `testflight_failure_episodes` |
| Agent work | `agent_tasks`, `agent_task_events`, `agent_commands`, `agent_hosts` |
| Cost | `llm_usage_events` |
| Pairing | device pairing records and device tokens |

## Code ownership

- `apps/ios`: presentation, gestures, local cache, API client, Keychain-facing connection state.
- `apps/ios-app`: entitlements, signing, icons, and application lifecycle.
- `services/api`: contracts, authentication, persistence, chat orchestration, background workers, Agent Host protocol, Aether/world integrations.
- `packages/cognition`: pure shared-state and prompt-projection rules.
- `deploy/macos`: launchd configuration for the local Agent Host.
- `deploy/azure`: production services, optional isolated cloud Agent Host, and configuration examples.

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

The current local Agent Host runs as `com.shannon.agent-host` and uses the local Shannon repository as its source checkout. The cloud Agent Host unit is staged but must not become the default until its dedicated Codex credential, GitHub write credential, heartbeat, and harmless end-to-end task have been verified.

## TestFlight delivery operations

The local Shannon Release Runner performs repository identity checks, deterministic verification, the unsigned Release build, exact-commit non-force push, and Azure delivery monitoring as one guarded flow. External release remains locked behind an exact HEAD plus a fresh-approval flag. It delegates build/signing to Xcode Cloud and build assignment to the existing Azure distributor, so there is only one TestFlight assignment authority.

The distributor records every automatic check in the production SQLite database. Consecutive failures with the same safe failure category belong to one durable episode. The notification worker sends an APNs alert only for the first event in an episode; repeated timer failures stay silent. A successful check closes the episode without a recovery notification. The paired iOS app reads the current condition and recent history through `GET /v1/testflight/delivery`, and a failure-notification tap opens Settings → App Update. Raw App Store Connect responses, JWTs, keys, and user conversation content are not stored in this projection.

## Deferred by design

- per-user LoRA or fine-tuning
- prediction-error training
- autonomous source-code rewriting
- Live2D runtime
- animated widget character
- full-duplex or background voice activation
