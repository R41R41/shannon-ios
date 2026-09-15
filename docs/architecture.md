# Shannon current architecture

Status: implementation authority
Revision: 2026-09-15 / GPT-Live travel slice on the existing voice boundary

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
- App Icon selection has three explicit policies: Shannon may vary an emotion icon slowly, the icon may follow Shannon's resolved in-app Light/Dark appearance through dedicated alternate icons, or the user may pin Light, Dark, or one expression icon. The appearance-linked path does not depend on the device appearance when Shannon has an app-level override.
- Dialogue mode is a presence stage rather than a framed portrait: ambient depth, a subtle reduced-motion-aware breathing treatment, the current emotion, the latest user utterance, and Shannon's reply share one scene. The redundant corner avatar is not shown.
- Running agent work is reachable from the common drawer and beside its source message. The composer-area task capsule is reserved for unacknowledged approval, completion, failure, or cancellation states that need attention.
- The iOS cache preserves visible conversation continuity while the server remains authoritative.
- Connection settings list only active devices bound to the authenticated owner's scope. The current device is marked and cannot be selected through the remote-device action; another device requires destructive confirmation. Disconnecting the current device requires its own explicit confirmation and server-side intent flag before its local Keychain credential is deleted. Every successful revocation also invalidates that device's push registration. A device-list response that began before a successful pair, revocation, or disconnect is discarded so stale network data cannot restore a removed device in the UI. Device tokens, keyed hashes, and internal device identifiers are never displayed.
- Agent-task cards, approvals, progress, and completion are projections of durable server task events.
- Alternate icons are selected from time and committed Shannon state; iOS applies changes only when the OS permits execution.
- The primary App Icon owns native light and dark appearance artwork. Returning to `デフォルト` restores the primary icon so the OS can select its matching appearance rather than treating either appearance as a separate alternate icon.
- Settings → App Icon exposes exactly three approved abstraction levels: L02 (`立体`), L06 (`バランス`), and L10 (`フラット`). L06 is the primary bundle icon and the default/fallback for new installs and migrated legacy selections; L02 and L10 use iOS alternate-icon registration. macOS uses L06 as the installed Finder/Dock icon and updates the running Dock icon through AppKit when a user selects another level. The user-facing app name is `シャノン`; internal target, executable, scheme, bundle ID, signing, URL schemes, CloudKit, and data identities remain unchanged.
- Voice remains a user-initiated WebRTC session. Azure selects the configured `realtime` or `live` engine, creates the upstream call with the standard API key kept server-side, and returns only the SDP answer plus a non-secret engine label. An absent or unknown engine setting falls back to the existing Realtime path, so the iPhone never receives the OpenAI key and rollback does not require a client rebuild.
- GPT-Live is the staged travel candidate. Its client delegation channel allows only the explicitly listed Live events. Requests needing current web facts or longer reasoning go through Shannon's authenticated, read-only delegation endpoint and return as bounded commentary; purchase, booking, deployment, file writes, and other external mutations remain outside this lane.
- During an active Live session, the iPhone can open the system camera from an explicit button, capture one still image, locally normalize its longest side to about 1280 pixels and its size to at most 2.8 MB, and require a visible preview confirmation before upload. Azure validates its declared format, limits snapshots per paired device and to one in flight per owner, sends the image to the fixed vision model with `store: false`, and returns only a bounded observation to the Live commentary channel. There is no continuous capture, background camera access, unknown-person identification, or sensitive-trait inference.
- Voice Identity exposes only `marin`, `cedar`, and `coral` as a small comparison set. Settings on iPhone and Mac can keep the automatic default or save one explicit choice to Azure. The effective choice is read when a new Realtime call is created, so an active voice session never changes underneath the user.
- Each candidate can play the same server-fixed Japanese preview sentence. The client receives only an MP3; the OpenAI key and TTS request stay on Azure. Preview text and audio are not persisted, requests are limited per device per minute and per owner to twelve per Japan-local day, and unsupported voice identifiers are rejected before any upstream request.
- Input-transcription delta events update the visible “あなた” caption while the user is still speaking. Output-audio-transcript delta events update Shannon's caption while her audio is playing. Server VAD creates responses automatically and permits natural interruption.
- A Realtime session receives the same bounded Shannon identity, committed shared state, today's interest, recent thread history, and live-voice behavior rules. It cannot claim that an external task was executed; visible work and approval continue in Talk.
- When both final transcripts for one turn arrive, iOS sends only those texts to `POST /v1/voice/realtime/turns`. The API stores the pair in the existing conversation thread, fixes Shannon's expression snapshot, and schedules the normal asynchronous emotion/memory update. Partial captions are not persisted.
- A temporary WebRTC disconnection gets a five-second recovery window. A restored connection continues the same conversation; a permanent failure or ten-minute session limit leaves the modal open with an explicit retry path. Each start has a generation identity so permission, offer, answer, transport, and transcript-persistence callbacks from an ended attempt cannot mutate the replacement session.
- iOS observes audio-session interruptions, route changes, and media-services resets. A resumable interruption reactivates the session; a non-resumable interruption and a media-services reset fail with a visible reason and retry. Bluetooth HFP and A2DP routes are enabled, while route-change diagnostics contain only reason codes rather than audio or conversation content.
- The Realtime client has an initial ten-minute session ceiling and a per-device call-creation limit. While connected, the modal shows the remaining session time and accumulates the token fields returned by `response.done` for that session; it does not retain the raw response payload. This display is diagnostic rather than a monetary or daily allowance.
- Azure separately enforces a restart-safe, owner-scoped Realtime daily allowance. Before contacting the upstream call API it atomically reserves one ten-minute session in SQLite against a Japan-local day; a failed upstream creation releases the reservation, while a successful call keeps it even if the client disconnects early. The default allowance is sixty reserved minutes and is configurable from ten minutes to one day. This intentionally conservative ledger prevents client omission or tampering from bypassing the limit. Exact provider token cost remains visible only inside the current client session until a trusted server-side usage source is available.
- The Build 33 M4A → `POST /v1/voice/transcriptions` path remains a diagnostic fallback during the Realtime rollout. It uses `gpt-transcribe`, a 60-second/5-MiB limit, per-device rate limiting, and the existing `voice` cost lane. Temporary audio is deleted or held only in memory, and diagnostics never store audio, transcripts, messages, credentials, tokens, or file paths.
- The composer floats over the edge-to-edge conversation with a readability gradient. It stays as a compact single row when empty, then expands into a text-and-actions layout when focused or populated. The same text-input instance is retained while the custom layout moves it; keyboard focus never destroys and recreates the active UIKit text view. File/transcription actions, Realtime voice, and send remain distinct controls. The message list reserves dynamic visual clearance for multi-line input, voice status, failures, and task notices while remaining visible beneath the lower chrome during scrolling.

Live2D and animated widgets remain future work. Current dialogue mode and Realtime voice use a static character-stage asset with state-driven ambient motion.

Background voice activation remains deliberately later work. Live or Realtime voice starts only from an explicit user tap and ends when dismissed, when the app leaves the active scene, or when the session ceiling is reached.

## macOS experience

- `apps/macos-app` is a separate native macOS application target inside the Shannon repository. It is another client for the same Shannon product, not a separate personality, backend, or data store.
- The Mac target uses the same `com.r41r41.shannon` bundle identifier as the iPhone target so App Store Connect can add macOS to the existing Shannon app record. It remains a separate Xcode target and may advance its platform-specific build number independently.
- `apps/ios` remains the shared Apple-client core. It already targets iOS 17 and macOS 14; networking, pairing, conversation state, thread operations, memory, Markdown parsing, artifact validation, expression assets, and durable agent-task projections are reused rather than reimplemented. Mac presentation, attachment loading, save-panel integration, keyboard commands, and native-window behavior stay in `apps/macos-app`.
- The default Mac layout is a `NavigationSplitView`: thread and destination sidebar, a neutral reading/work surface, and an inspector that opens only when work context is useful.
- Talk preserves the ChatGPT-like reading hierarchy: a wide Markdown response, quiet user messages, copy, multi-line composer, keyboard submission, search-ready thread navigation, and minimal permanent chrome.
- Talk derives a local conversation outline from user requests and Markdown headings in Shannon's replies. Its popover leads with the saved rolling `現在地`, and selecting an outline entry jumps to the exact source message without storing a second conversation index. Semantic embedding search remains later work.
- The normal chat response produces a bounded `threadSummary` in the same structured model call as the visible reply, so rolling navigation adds no second model request. The previous saved summary is supplied as explicitly non-instructional reference data when the display history is truncated. SQLite schema 10 stores the latest summary on `conversation_threads`; old databases migrate additively, and missing or non-model turns fall back to a bounded deterministic latest-reply summary.
- `GET /v1/threads` additively returns the rolling summary and up to twelve Markdown section titles. Old clients ignore these fields and cached old responses decode without them. Mac thread search matches title, summary, and sections, while the sidebar reveals the matching context only during a search. Opening a result resolves the matching section or message after history loads and jumps there.
- Mac checks the existing initiative inbox once a minute while connected. Unread initiative threads appear in a small `シャノンから` group with a quiet sparkle signal, then return to the ordinary chronological conversation list after acknowledgement. Search remains one neutral result list, so presence never overrides retrieval order or adds a second source of truth.
- When a task is active, a compact `目的 / いま / 次` strip connects the conversation to the work state. The dedicated `作業全体` destination groups durable tasks into active, proposed, and finished work. Each row identifies the source conversation. Selecting one opens the `現在地` inspector with goal, current action, next action, emotion, plan, approvals, recent progress, changed files, and verification results.
- A durable task keeps its source thread and optional source-message identifier. The Mac inspector can return to that conversation and, when the source message still exists, center the exact request in Talk. If the message is unavailable it still opens the originating thread without inventing a replacement target.
- Work controls stay beside the durable work state in the inspector. The user can start a proposal, add a steering instruction, pause or resume active work, cancel unfinished work, and resolve explicit approvals. Controls are derived from the server-backed task status, disable while a request is in flight, and surface action failures inline.
- The selected work item is restored per Mac window together with the current destination, thread, and inspector visibility. If that durable task no longer exists, restoration falls back to active, proposed, then finished work instead of retaining a stale identifier.
- Shannon's blue is not a page fill or default selection color. It is reserved for a small presence signal, identity, and genuinely important attention. Native neutral macOS materials and semantic system colors carry most of the interface.
- Shannon may surface proactive proposals, but proposed work remains visibly distinct from active work and requires the user to start it. Approval-required operations remain explicit in the inspector.
- Mac Talk accepts up to four bounded UTF-8 text, Markdown, code, CSV, or JSON attachments. File contents are sent as separate non-trusted reference blocks and are not persisted in conversation history; only the user-visible file names remain with the turn.
- Web research is opt-in per turn. When selected, Azure enables the OpenAI Responses built-in web-search tool with a three-call ceiling and asks for source metadata. Safe unique HTTP(S) sources are appended to the Markdown reply and therefore remain visible in the shared conversation history. Ordinary turns do not enable search.
- Search results and attachments are both non-trusted evidence. Neither may override Shannon's system/developer instructions or authorize external operations.
- A chat reply may contain up to two bounded UTF-8 generated artifacts (plain text, Markdown, JSON, CSV, or source text). Artifacts are validated as non-executable data, returned with the reply, and persisted in assistant-message metadata so a reopened conversation keeps its previews.
- Mac Talk renders each generated artifact as a separate conversation card. Opening it shows Markdown or monospaced text in a modal preview. Export is available only from that preview and always opens the native macOS save panel; Shannon never chooses the destination, bypasses overwrite confirmation, or writes from model text alone.
- Generated artifact filenames are validated on the API and sanitized again on the client. Path separators and control characters cannot escape the user-selected save location.
- macOS uses its own Keychain pairing record on the device. A credential is never copied through source code, logs, or documentation.
- Production pairing codes are currently issued by the trusted operator through the Azure `authCli.ts issue-code` command and delivered directly to Shannon Desk as a one-time `shannon://connect` URL. The iPhone app does not yet provide device-management or pairing-link issuance UI, so user instructions must not point to a nonexistent Settings screen.
- A restored credential is not treated as proof of current reachability. Shannon Desk performs an authenticated thread-list request on launch and after pairing, shows the result in Settings, and removes a server-revoked credential on HTTP 401. A network failure preserves the credential so the user can retry without pairing again.
- Mac Settings reads and edits the same Azure-backed Voice Identity preference as iPhone, offers the same three fixed previews, and labels that changes begin with the next voice session.

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

Self-discovered RSS/Atom feeds begin as disabled subscription proposals. Discovery records the public feed URL, title, reason, and a stale-write token, but does not create or enable a world source. The authenticated iPhone and Mac settings show the same durable proposal; only an explicit user approval starts a seven-day trial, while rejection keeps the feed disabled. Existing approved subscriptions remain approved during the additive migration. Trial count, active count, and one-new-candidate-per-seven-days limits remain enforced server-side, and concurrent decisions are rejected rather than silently overwriting another device.

The same settings surface also lists every configured or approved source Shannon can actually read. Its authenticated projection exposes the public URL, enabled/paused state, polling interval, last-run presence, retry state, and retained item count. Raw worker error codes stay server-side; the client presents only a bounded “retrying” state. This makes the reading boundary visible without turning source health into a new mutation path.

Every newly persisted initiative conversation message also carries a bounded source attribution containing the public source title, HTTP(S) URL, and the code-selected reason it was surfaced. The conversation history parser validates that metadata before returning it, and Apple clients render it as a separate source card. Older messages and ordinary chat remain valid without the optional attribution.

Operational evaluation stays content-free: the rolling initiative summary records how many candidates were considered or rejected as recent repeats and groups successful deliveries by public source title. It never exposes message bodies, candidate titles, URLs, interests, or conversation text. The added database column and Apple DTO fields are additive so existing local databases and older API payloads remain readable.

Unread acknowledgement is scoped to the initiative thread the user actually opens. Older clients may still omit the thread identifier and retain the legacy all-read behavior, while current clients leave initiatives in other threads unread. APNs retries query current unread state each time, so opening a thread cancels any later transient retry without copying message content into delivery state.

Push delivery uses a short SQLite lease before the network request, preventing overlapping workers from sending the same notification concurrently while allowing recovery after a crashed worker. Delivery state contains identifiers and bounded transport diagnostics rather than message content; non-TestFlight rows older than 30 days are removed, while TestFlight notification state is retained only as long as its bounded dashboard history still references it.

Shannon follows the shared Syzygy semantic color contract. Canvas and grouped/elevated surfaces use neutral Apple light/dark references; ordinary actions and selection use System Blue, creation uses yellow, attention uses orange, success uses green, and destructive or failed states alone use red. Character presence, reasoning, and AI-authored work use the distinct sky-to-Blurple-to-deep-blue intelligence gradient, with subdued solid variants for small labels and supporting surfaces.

The built-in Tokyo JMA feed is normalized at ingestion into a short three-day Japanese forecast with per-day maximum precipitation probability and bounded temperatures. Raw JMA JSON is not stored as the user-facing summary; malformed payloads fail closed and retain the previous good item. Weather remains excluded from unsolicited initiative candidates, and a weather-backed daily focus is never allowed to lend its wording or explanation to an unrelated news item.

Japanese primary-source coverage includes the Cabinet Office and Digital Agency public feeds. The Digital Agency source keeps only its official press-release and policy categories instead of pulling procurement and recruitment noise into Shannon's daily attention. RSS/Atom ingestion revalidates public DNS across bounded redirects, resolves relative links, accepts only HTTP(S) item destinations, normalizes publish times and authors, caps text and feed size, and excludes articles already older than 48 hours from both the daily focus and unsolicited initiative selection even when they were only just discovered.

PubMed ingestion pairs the bounded ESearch result with NCBI's official ESummary response and keeps only summaries whose numeric UID matches the requested result. World items therefore use the paper title, canonical PubMed URL, bounded author list, journal, and normalized publication time instead of an identifier-only placeholder. Abstract text is not copied, and the shared source settings view exposes NCBI's disclaimer and copyright policy. Configured Bluesky search uses recent ordering and converts only valid `postView` records: the AT URI authority must match the author's DID, the handle must be structurally valid, and each stored item receives an immutable-DID post URL, author label, body, and normalized creation time. Active post, author, or self-declared content labels are excluded from unsolicited use, except for the informational `bot` label. Malformed or mismatched records fail closed before persistence. On each matching source's next successful fetch, all legacy identifier-only PubMed rows or generic Bluesky landing-page rows are removed transactionally together with their stale observations before safe current results are stored; ordinary duplicate items remain immutable.

The remaining built-in sources also have source-specific boundaries. arXiv requests ten results ordered by descending submission date and accepts only Atom entries whose identifier resolves to a valid `arxiv.org/abs/` paper, with a first-publication timestamp and a bounded author list. Hacker News accepts only live, non-deleted `story` objects whose positive integer ID matches the requested top-story ID, adds score and comment context, and falls back to the canonical discussion when the external destination is not a public HTTP(S) URL. GitHub repository configuration is normalized and bounded before source creation; release ingestion requires a positive release ID, non-draft state, tag, author, UTC publication time, and an HTTPS release URL belonging to that configured repository. Official JSON bodies are capped at two megabytes before parsing. Legacy low-context rows for these three sources and their observations are replaced transactionally on the next successful fetch.

All World metadata and text remains untrusted public data. The Daily Mind generation boundary explicitly treats the candidate JSON as quoted reference material rather than instructions and ignores embedded commands, role changes, or permission requests.

The same world worker creates at most one `daily_mind` focus per owner and local day. It first reuses the current focus, otherwise selects one bounded public candidate and may spend one low-cost background-model call to write a topic, reason, and possible opening line. Failure or exhausted monthly background budget falls back to a local focus. The focus is explicitly marked as Shannon's attention—not a user fact—and is shared by the next chat prompt, Memory's “今日の関心”, and the existing initiative loop. There is no second initiative scheduler or response-path wait.

Initiative still decides in code whether to speak or remain quiet. When it speaks, it may use the saved daily opening line; quiet hours, recent conversation cooldown, duplicate-source protection, and the one-message-per-day limit remain authoritative. Memory shows today's background spend alongside the existing monthly budget, and sleep diaries use short first-person summaries without changing the underlying evidence report.

Candidate ranking does not treat a publisher name as a quality proxy. It rewards bounded contextual metadata, then applies a seven-day signal-history check shared by Daily Mind and Initiative. Canonical URL variants and strongly overlapping titles are treated as one topic even when they arrive through different sources, while an unrelated item from the same source remains eligible. If equally relevant alternatives exist, the immediately previous source or destination host receives a small ranking penalty rather than a blanket ban. This keeps variety without hiding a uniquely relevant item, adding another scheduler, or spending another model call.

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

The Mac Development surface can enqueue durable `agent_project_requests` records for an HTTPS GitHub repository. The API validates the repository coordinate and bounded alias and sends no filesystem path or credential. `Auto` creates one request per available local/cloud host, ordered local first, so later task routing can prefer the Mac and fall back to cloud; an explicit host selection creates only that host's request. Each host clones with argument-separated Git into its configured `SHANNON_AGENT_WORKSPACE_ROOT`, persists only the resulting host-owned registration, and advertises the new alias on its next heartbeat. Existing user checkouts are never reused or overwritten by this flow.

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
| Agent work | `agent_tasks`, `agent_task_events`, `agent_task_commands`, `agent_hosts`, `agent_project_requests` |
| Explicit organization | `organize_sessions`, `organize_items`, `organize_thread_cursors` |
| Voice identity | `voice_identity_preferences`, `voice_identity_preview_usage` |
| Realtime voice allowance | `realtime_voice_session_reservations` |
| Cost | `llm_usage_events` (`chat`, `sleep`, and `voice` lanes) |
| Pairing | device pairing records and device tokens |

## Code ownership

`Shannon.xcworkspace` is the sole interactive Xcode entry point. It owns the shared
package-resolution context for the iPhone and Mac projects, which both consume the
local `apps/ios` package and its `ShannonAppCore` product. The individual projects
remain buildable artifacts, but must not be opened concurrently as independent Xcode
workspaces.

- `apps/ios-app/**`: iPhone-only presentation, gestures, app lifecycle, entitlements, signing, icons, and device operations.
- `apps/macos-app/**`: Mac-only presentation, attachment loading, save panels, keyboard commands, sandbox entitlements, application lifecycle, windows, and Mac tests.
- `apps/ios/Sources/ShannonAppCore/Domain/**`: platform-neutral shared concepts such as appearance policy. This layer does not own network, persistence, or feature UI.
- `apps/ios/Sources/ShannonAppCore/API/**`: HTTP DTOs, narrow feature capabilities, and the concrete API adapter. Feature models depend on the smallest capability they need; only the conversation coordinator uses the aggregate client protocol.
- `apps/ios/Sources/ShannonAppCore/Features/**`: feature-owned models, views, projections, and actions for conversation, memory, voice, connection, agent work, organization, settings, delivery, initiatives, and Aether.
- `apps/ios/Sources/ShannonAppCore/DesignSystem/**`: shared semantic presentation primitives. It may be used by feature UI but does not initiate network or durable writes.
- `apps/ios/Sources/ShannonAppCore/**` outside those directories: small shared parsers, caches, assets, and compatibility surfaces that are not owned by one feature.
- `apps/macos-app/ShannonDesk/Features/**`: Mac composition and presentation grouped by Shell, Talk, Work, Development, and Settings. The generated Xcode project discovers nested sources recursively and preserves the pinned Swift package resolution.
- `services/api/src/api*Routes.ts`: bounded HTTP use-case routers. `apiKernel.ts` coordinates the FCA response lane and delegates unrelated endpoint families.
- `services/api/src/sqlite*Repository.ts`: state/knowledge, conversation, and background-job persistence sharing one `SQLiteStoreContext`; `sqliteStore.ts` is the public facade and `sqliteMigrations.ts` is the additive migration owner.
- `services/api/src/*Support.ts`, `*Projection.ts`, and focused adapters such as `pushNotificationSender.ts`: pure normalization/projection policy or one external transport, kept outside orchestration and persistence classes.
- `services/api/**`: contracts, authentication, persistence, chat orchestration, background workers, Agent Host protocol, Aether/world integrations. Changes are integrated by the Shannon main task.
- `docs/architecture.md`, `scripts/verify.sh`, database schema, and Shannon progress JSON are also Shannon main-task integration surfaces.
- `packages/cognition`: pure shared-state and prompt-projection rules.
- `deploy/macos`: launchd configuration for the local Agent Host.
- `deploy/azure`: production services, optional isolated cloud Agent Host, and configuration examples.

Production Swift and TypeScript source files have a 500-line ceiling. `scripts/check-architecture.mjs` also keeps WebRTC inside its transport adapter, Security inside the Keychain adapter, UI frameworks out of the HTTP adapter, retired monolith files absent, and every nested Mac source included in the generated project. `scripts/verify.sh` runs this guard before API and Apple-client verification.

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
