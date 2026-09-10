# Shannon current architecture

Status: implementation authority
Revision: 2026-09-09 / Shannon × Voyager Phase 2 local vertical slice

## System shape

```text
iPhone app + Shannon Desk for Mac
  ├─ shared conversation, thread, memory, and agent-task models
  ├─ platform-native Talk / work / memory / settings surfaces
  ├─ per-device Keychain pairing token
  └─ per-device local conversation cache
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
4. Call the fixed chat model once with adaptive-depth response guidance: lead with the outcome, stay concise for simple questions, and preserve enough Markdown-structured detail for explanation, design, research, and implementation work.
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

- Talk is the product root. The outer shell does not clip the conversation scroll surface, so message content can move behind both the status area and home-indicator area. Restrained top and bottom gradients preserve system-status and input readability without turning either edge into an opaque bar.
- Talk has no persistent centered title. Circular material controls float at the upper left and right for the common drawer and new-thread action, leaving the conversation visually continuous beneath them.
- The common drawer holds the thread list plus explicit destinations for “頭の中”, current agent work, and Settings. Talk and Memory are no longer presented as equally weighted tabs or a persistent segmented switcher.
- The drawer material occupies the full display height, including behind the status area and home indicator. Its interactive content retains a safe top start and enough bottom space for every destination to remain readable and tappable.
- Settings opens from the drawer instead of behaving like a third content page.
- Talk supports multiple threads, a sliding thread list, scroll mode, and character-focused dialogue mode.
- The thread list has a visible button. A rightward swipe beginning within the left half of Talk is retained as a secondary shortcut; it is disabled while the composer is active.
- Assistant messages store the expression used at send time and place a 42pt avatar, name, emotion, time, and copy action in one compact header so the reply body can use the full content width. User messages use a quiet pale-blue container rather than competing with Shannon's presence color.
- Assistant replies render safe, local Markdown blocks for headings, ordered and unordered lists, quotations, code, dividers, emphasis, and approved links. Raw HTML and unsafe URL schemes remain plain text.
- The Clear Signal color system separates Shannon's electric-blue presence accent from the darker accessible action color. Light and dark themes share semantic canvas, surface, user-message, text, state, and warm-emotion roles rather than literal color reuse. Appearance selection is one app-wide environment value: Light and Dark apply immediately, while “端末に合わせる” removes the product override and re-resolves the current device appearance before returning to Settings. Presented Settings surfaces resolve their palette from the live environment instead of retaining the palette from presentation time.
- Dialogue mode is a presence stage rather than a framed portrait: ambient depth, a subtle reduced-motion-aware breathing treatment, the current emotion, the latest user utterance, and Shannon's reply share one scene. The redundant corner avatar is not shown.
- Running agent work is reachable from the common drawer and beside its source message. The composer-area task capsule is reserved for unacknowledged approval, completion, failure, or cancellation states that need attention.
- The iOS cache preserves visible conversation continuity while the server remains authoritative.
- Agent-task cards, approvals, progress, and completion are projections of durable server task events.
- Alternate icons are selected from time and committed Shannon state; iOS applies changes only when the OS permits execution.
- The primary App Icon owns native light and dark appearance artwork. Returning to `デフォルト` restores the primary icon so the OS can select its matching appearance rather than treating either appearance as a separate alternate icon.
- Settings → App Icon shows the actual bundled primary and alternate icon artwork. The mode selector offers only automatic (`シャノンに任せる`) and manual (`自分で選ぶ`). Automatic mode uses the existing time/emotion variants. Manual mode contains `デフォルト` followed only by Shannon expression icons; temporary Aether/Shannon/Voyager comparison choices are not shipped. The primary preview follows the app appearance. A stored legacy `fixed` selection, or any removed/invalid manual selection, is migrated safely to `デフォルト`.
- The primary voice candidate is a user-initiated Realtime WebRTC session. iOS captures and plays audio through WebRTC; Azure creates the OpenAI Realtime call with the standard API key kept server-side. The iPhone never receives that key.
- Input-transcription delta events update the visible “あなた” caption while the user is still speaking. Output-audio-transcript delta events update Shannon's caption while her audio is playing. Server VAD creates responses automatically and permits natural interruption.
- A Realtime session receives the same bounded Shannon identity, committed shared state, today's interest, recent thread history, and live-voice behavior rules. It cannot claim that an external task was executed; visible work and approval continue in Talk.
- When both final transcripts for one turn arrive, iOS sends only those texts to `POST /v1/voice/realtime/turns`. The API stores the pair in the existing conversation thread, fixes Shannon's expression snapshot, and schedules the normal asynchronous emotion/memory update. Partial captions are not persisted.
- The Realtime client has an initial ten-minute session ceiling and a per-device call-creation limit. Voice remains a separate cost concern from chat and background work; durable usage metering and a server-authoritative daily Realtime allowance are required before general release.
- The Build 33 M4A → `POST /v1/voice/transcriptions` path remains a diagnostic fallback during the Realtime rollout. It uses `gpt-transcribe`, a 60-second/5-MiB limit, per-device rate limiting, and the existing `voice` cost lane. Temporary audio is deleted or held only in memory, and diagnostics never store audio, transcripts, messages, credentials, tokens, or file paths.
- The composer floats over the edge-to-edge conversation with a readability gradient. It stays as a compact single row when empty, then expands into a text-and-actions layout when focused or populated. The same text-input instance is retained while the custom layout moves it; keyboard focus never destroys and recreates the active UIKit text view. File/transcription actions, Realtime voice, and send remain distinct controls. The message list reserves dynamic visual clearance for multi-line input, voice status, failures, and task notices while remaining visible beneath the lower chrome during scrolling.

Live2D and animated widgets remain future work. Current dialogue mode and Realtime voice use a static character-stage asset with state-driven ambient motion.

Background voice activation remains deliberately later work. Realtime voice starts only from an explicit user tap and ends when dismissed, when the app leaves the active scene, or when the session ceiling is reached.

## macOS experience

- `apps/macos-app` is a separate native macOS application target inside the Shannon repository. It is another client for the same Shannon product, not a separate personality, backend, or data store.
- The Mac target uses the same `com.r41r41.shannon` bundle identifier as the iPhone target so App Store Connect can add macOS to the existing Shannon app record. It remains a separate Xcode target and may advance its platform-specific build number independently.
- `apps/ios` remains the shared Apple-client core. It already targets iOS 17 and macOS 14; networking, pairing, conversation state, thread operations, memory, Markdown parsing, artifact validation, expression assets, and durable agent-task projections are reused rather than reimplemented. Mac presentation, attachment loading, save-panel integration, keyboard commands, and native-window behavior stay in `apps/macos-app`.
- The default Mac layout is a `NavigationSplitView`: thread and destination sidebar, a neutral reading/work surface, and an inspector that opens only when work context is useful.
- Talk preserves the ChatGPT-like reading hierarchy: a wide Markdown response, quiet user messages, copy, multi-line composer, keyboard submission, search-ready thread navigation, and minimal permanent chrome.
- When a task is active, a compact `目的 / いま / 次` strip connects the conversation to the work state. The dedicated `作業全体` destination groups durable tasks into active, proposed, and finished work. Selecting one opens the `現在地` inspector with goal, current action, next action, emotion, plan, and approval controls.
- Shannon's blue is not a page fill or default selection color. It is reserved for a small presence signal, identity, and genuinely important attention. Native neutral macOS materials and semantic system colors carry most of the interface.
- Shannon may surface proactive proposals, but proposed work remains visibly distinct from active work and requires the user to start it. Approval-required operations remain explicit in the inspector.
- Mac Talk accepts up to four bounded UTF-8 text, Markdown, code, CSV, or JSON attachments. File contents are sent as separate non-trusted reference blocks and are not persisted in conversation history; only the user-visible file names remain with the turn.
- Web research is opt-in per turn. When selected, Azure enables the OpenAI Responses built-in web-search tool with a three-call ceiling and asks for source metadata. Safe unique HTTP(S) sources are appended to the Markdown reply and therefore remain visible in the shared conversation history. Ordinary turns do not enable search.
- Search results and attachments are both non-trusted evidence. Neither may override Shannon's system/developer instructions or authorize external operations.
- A chat reply may contain up to two bounded UTF-8 generated artifacts (plain text, Markdown, JSON, CSV, or source text). Artifacts are validated as non-executable data, returned with the reply, and persisted in assistant-message metadata so a reopened conversation keeps its previews.
- Mac Talk renders each generated artifact as a separate conversation card. Opening it shows Markdown or monospaced text in a modal preview. Export is available only from that preview and always opens the native macOS save panel; Shannon never chooses the destination, bypasses overwrite confirmation, or writes from model text alone.
- Generated artifact filenames are validated on the API and sanitized again on the client. Path separators and control characters cannot escape the user-selected save location.
- macOS uses its own Keychain pairing record on the device. A credential is never copied through source code, logs, or documentation.
- A restored credential is not treated as proof of current reachability. Shannon Desk performs an authenticated thread-list request on launch and after pairing, shows the result in Settings, and removes a server-revoked credential on HTTP 401. A network failure preserves the credential so the user can retry without pairing again.

## Explicit conversation organization and Voyager Phase 2

The exact standalone command `整理して` enters a separate, explicit organization lane instead of the ordinary chat model lane. The API freezes at most 100 messages after the last successfully applied organization cursor, extracts up to 12 bounded Voyager Task drafts, and stores them as a durable `OrganizeSession`. The command and Shannon's review prompt remain normal conversation messages, so both iPhone and Mac can restore the review card after leaving or relaunching the app.

An explicit bounded Voyager Task update request stays in this organization lane even if the ordinary chat model also classifies it as Shannon source-code work. The API suppresses that duplicate `agent_task_proposal` projection while preserving normal agent-work proposals for actual Shannon implementation requests. This prevents a second “作業を始める” card from competing with the authoritative OrganizeSession review card.

Each draft begins as `proposed`. The user can accept, edit and accept, reject, or defer each item. These review operations change only Shannon's `OrganizeSession`; they do not call Voyager. The user can keep a proposal as a new Task or search at most eight bounded existing Task projections, choose exactly one target, compare its stored title/details with the proposed values, and select only existing Project projections. Shannon never guesses among candidates. The final `反映` action sends only accepted items through the server-side Voyager adapter. A failed item remains retryable with its frozen request ID, idempotency key, creation time, target snapshot, expected revision, and command body.

An existing-Task proposal stores the search query separately from the fields to change. `title`, `details`, and `projectIds` are sent to Voyager only when that field is explicitly present in `updateFields`; an operation description is never reused as a replacement Task title. The unambiguous Japanese form `Voyagerにある「…」の詳細を「…」に更新` is parsed deterministically before model extraction, while other update requests use the same strict field-level schema. If the user asks to choose a fitting Project, review cannot be accepted or applied until at least one Project is explicitly selected. The review card labels unchanged fields as locked and shows the exact changed-field set.

Phase 1 remains byte-compatible as Syzygy contract `1.0`: a top-level `thinking` Task with no Project. Phase 2 uses contract `1.1` only when assigning Projects or updating an existing Task. Its read projection contains only Task ID, title, bounded details, status, Project IDs, revision and update time, or the corresponding bounded Project identity. An update requires the selected Task ID and captured `expectedRevision` and may change only title, details and Project IDs. Voyager rejects terminal Tasks, stale revisions, unknown Projects, status/deadline/priority/tag edits, deletion, subtree replacement and bulk operations without a partial write.

The iPhone and Mac call only Shannon's authenticated proxy endpoints. They never receive the Voyager destination credential or workspace credential. Shannon caps UI-facing task results at eight and Project results at twenty even though the destination contract permits a wider server-side maximum. Missing destination configuration fails closed; device credentials cannot substitute for the destination credential.

Successful final application shows the applied count, Task names, and Voyager Task References. The cursor advances only when the session is fully applied, including a session whose proposals were all rejected or deferred. Status changes, deadlines, priorities, tags, deletion, bulk operations, Aether writes, and automatic background organization remain outside Phase 2.

Runtime configuration uses all three of `SHANNON_VOYAGER_INTEGRATION_URL`, `SHANNON_VOYAGER_INTEGRATION_TOKEN`, and `SHANNON_VOYAGER_WORKSPACE_ID`. `SHANNON_ORGANIZE_MODEL` is optional and falls back to the normal Shannon model. The extractor hashes the owner scope before using it as a prompt-cache key; raw scope identifiers are not sent in that metadata.

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
| Explicit organization | `organize_sessions`, `organize_items`, `organize_thread_cursors` |
| Cost | `llm_usage_events` (`chat`, `sleep`, and `voice` lanes) |
| Pairing | device pairing records and device tokens |

## Code ownership

- `apps/ios-app/**`: iPhone-only presentation, gestures, app lifecycle, entitlements, signing, icons, and device operations.
- `apps/macos-app/**`: Mac-only presentation, attachment loading, save panels, keyboard commands, sandbox entitlements, application lifecycle, windows, and Mac tests.
- `apps/ios/Sources/ShannonAppCore/**`: shared Apple-client models, API client, cache, connection state, Markdown parsing, artifacts, and reusable assets. Changes are integrated by the Shannon main task rather than either platform-only task.
- `services/api/**`: contracts, authentication, persistence, chat orchestration, background workers, Agent Host protocol, Aether/world integrations. Changes are integrated by the Shannon main task.
- `docs/architecture.md`, `scripts/verify.sh`, database schema, and Shannon progress JSON are also Shannon main-task integration surfaces.
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
- background voice activation
