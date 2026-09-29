# Shannon current architecture

Status: implementation authority
Revision: 2026-09-28 / assembled voice turns, Jev routing contract, staged latency telemetry, and Gemini cascade speech

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
  ├─ allowlisted legacy-platform turn ingestion
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
3. Run one bounded, read-only relevance pass over prior experience using the current utterance and situation cues. This pure pass does not write shared state, call another model, or wait for the background worker.
4. Select one owner-visible active intention using current-turn evidence, thread affinity, priority, and recency. An explicitly stated goal in the current utterance participates provisionally so the same reply can honor it, but is persisted only after the turn succeeds.
5. Assemble the minimal identity prompt, prompt projection, turn-specific recalled memories, selected intention, relevant Aether context, active agent-task projection, and bounded conversation history.
6. Call the fixed chat model once with adaptive-depth response guidance: lead with the outcome, stay concise for simple questions, and preserve enough Markdown-structured detail for explanation, design, research, and implementation work.
7. Store the assistant reply and its selected expression, then persist the explicit intention and a bounded cognitive-cycle receipt containing only visible inputs, selected IDs, action class, outcome, and summary. It never stores hidden chain-of-thought.
8. Enqueue non-blocking emotion, durable memory, prospective-memory, and activity work.

For a newly created thread without an explicit title, the first successful user/assistant exchange also produces a short title in that same model call. The store commits the title and both messages in one transaction, rechecking title ownership after the model returns. Manual edits always win, including an explicit edit to `新しいトーク`. Missing or invalid title metadata falls back to a bounded excerpt of the user message without failing the reply. The chat response includes the committed thread so iOS can update and cache its list immediately; older responses still use the existing thread-list refresh.

SQLite schema v8 adds `conversation_threads.title_origin` (`pending`, `automatic`, or `manual`). Migration preserves all existing titles as manual because older rows have no edit provenance. Only newly created untitled threads are eligible for automatic naming. The migration is additive and runs inside the existing restart-safe migration transaction.

Emotion and memory updates affect the next reply after they commit. Prediction-error processing is not part of v1.

## Intention and cognitive-cycle lane

Text chat and owner-mode live voice share the same intention frame. Conservative Japanese rules capture only explicit owner goals such as a stated objective or a concrete request to build, improve, integrate, or finish something. Negated goals, vague continuation phrases, questions, and guest voice sessions do not create durable intentions. Matching active goals are deduplicated rather than multiplied by repeated wording.

When that same owner turn explicitly creates or refreshes a goal, the existing structured chat response may include one bounded plan proposal: one immediate next step and one to five verifiable stages. The server accepts this metadata only when its own deterministic intent extractor found an explicit goal, normalizes and bounds every stage, and persists it with the intention. Later text and owner-voice turns receive the saved plan in the intention frame. The plan is owner-visible guidance, not an action receipt; it cannot execute tools, complete a stage, or complete the goal.

`GET /v1/cognition` exposes the owner's intention ledger and recent bounded cycle receipts. `POST /v1/cognition/intents/status` can pause, reactivate, complete, or dismiss one exact intention. The prompt treats an intention as continuity evidence, never proof that work occurred; only the existing verified action or agent-task receipts can establish an external change.

This lane is the first durable perceive → recall → intend → plan → respond → record vertical slice. It now supports bounded initial decomposition but does not replan from verified execution progress, choose autonomous external actions, or mark plan stages or goals complete from model prose. Those remain later bounded extensions over the same owner-visible ledger.

## Legacy platform convergence

Discord, LINE, Minecraft, X, and YouTube remain transport/tool adapters in the
legacy Azure runtime during the first convergence phase. After that runtime has
successfully sent one owner-authored reply, it may mirror the completed turn to
`POST /v1/platform/turns` using a dedicated service credential. The endpoint
binds the canonical owner scope from server configuration, accepts only exact
external owners paired with either an exact platform conversation or one explicit
Discord guild prefix, derives an opaque hash-based
thread identifier, and idempotently records the turn before scheduling the same memory
refinement used by app chat. Unknown conversations, friends, group participants,
and caller-supplied scope keys are rejected rather than being learned as owner
facts. This makes the app API the gradual source of truth for Shannon's memory
without changing the legacy channel's response model or action tools in the same
release.

Later phases can move response generation and consented relationship memory onto
the shared core after the mirror path is observed in production. They must not
dual-write friend statements into owner memory or expose iPhone/device tokens to
the legacy runtime.

The next convergence slice adds a read-only `POST /v1/platform/context` route.
It authenticates with the same service credential and exact owner binding, then
returns only the bounded companion-state prompt projection; it never returns a
scope key, device credential, or conversation transcript. The legacy runtime may
use that projection for an owner-authored response, but an unavailable or invalid
projection must fall back to the legacy prompt without delaying community replies.

Phase 3 begins with an owner-managed person identity registry, not automatic
relationship learning. Paired owner clients may create a Discord identity as an
unconfirmed candidate, explicitly confirm it, correct it, revoke it, or delete the
person. Changing an external ID always resets the identity to candidate status and
requires confirmation again. Every mutation uses an expected revision. Deletion
removes the display name and raw external ID; the retained audit event contains only
an opaque internal person ID, action, platform, and timestamp. Candidate or confirmed
third-party identities do not enter owner memory or legacy prompts in this slice.

## State and sleep lanes

- Emotion is a continuous shared state updated after conversation events and decayed toward its baseline.
- Direct statements such as preferences and personal facts can update structured knowledge immediately, with evidence and confidence.
- Turn-specific recall ranking runs synchronously as a bounded, deterministic read before generation, so the current answer—not only the next answer—can use relevant experience. It does not mutate state or invoke an additional model.
- Durable active-memory replacement and interest changes remain outside the response path.
- Each recall pass replaces the complete active-memory set with one bounded state event. Pinned experiences are retained, and unchanged recall does not create another state version, event, or prompt projection.
- Explicit future intent such as “明日…しよう”, “あとで…したい”, or “忘れないで” becomes prospective memory in the normal turn-refinement worker. Individual records are bounded; authoritative commitments and user memory controls are not silently evicted at a collection limit. Only working projections are budgeted. Capture is conservative Japanese rule extraction, not unrestricted semantic understanding.
- Commitments retain their source experience, original observation time, time zone and normalized due date/time where unambiguous. Recovery jobs retain the original observation time instead of interpreting “tomorrow” at worker execution. Ambiguous times remain hints. Pending commitments receive a reserved prompt budget and appear in the existing Memory list with complete, cancel, correct, forget and restore controls.
- Memory mutations are atomic state transactions. A forgotten source suppresses derived commitments, prompt/history reuse and sleep re-extraction. Sleep outcomes are rechecked against the current controls inside their commit transaction. Forgetting excludes information from generation; it does not physically delete the auditable conversation. This evidence-based exclusion is not a general semantic erasure guarantee.
- Persisted companion snapshots are restored through the same per-field and working-set bounds as live updates. Older snapshots without newer optional collections remain readable, while malformed nested values are discarded or reset to safe defaults.
- Sleep consolidation reviews the day's evidence and cautiously updates user knowledge and personality projections. It does not fine-tune the LLM.
- Background jobs are leased, retryable, and resumable after process restarts.

## iOS experience

- Talk is the product root and uses a platform `NavigationStack`. The selected thread title is the standard inline navigation title; thread navigation, display switching, and new-thread creation use standard toolbar placements and SF Symbols.
- The standard thread-list sheet uses `NavigationStack`, `List`, `Section`, `searchable`, and toolbar dismissal/creation actions. It holds the thread list plus explicit destinations for “頭の中”, current agent work, and Settings. Talk and Memory are not presented as equally weighted tabs or a persistent segmented switcher.
- Settings opens from the thread-list sheet instead of behaving like a third content page.
- Talk supports multiple threads, scroll mode, and character-focused dialogue mode. Status, task notices, voice state, attachments, and the composer remain in a bottom `safeAreaInset` with system bar material, so content and controls respect the keyboard and home indicator.
- Live voice keeps microphone preference separate from the actual active route. The client persists only the semantic choice (automatic, built-in, or connected input), reapplies it after route/interruption changes, and displays the route iOS actually granted. A connected input disappearing never silently relabels the built-in microphone as the requested headset.
- The voice bottom-edge glow is decorative state feedback. Gemini samples only transient RMS envelopes from the existing microphone and synthesized playout; it does not retain or log PCM. Visible labels and the Waterlight Eye remain the semantic authority, and reduced-motion users receive a static state-specific glow.
- Voice accepts typed input without closing its Gemini recognition session. Typed input follows the same owner/guest persistence boundary as speech, and a send failure does not change the voice connection.
- The thread list has a visible leading toolbar button. Presentation and dismissal use the standard sheet interaction rather than a custom edge gesture.
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
- Voice remains user initiated. The waveform action opens the single cascade experience directly; recognition, delegation, and turn persistence use `/v1/voice/gemini/cascade/*`. Settings select Gemini or ElevenLabs v4 Turbo for response speech on the next call; the selected provider changes only the TTS stream and maps the same affect/delivery plan to provider-specific acting instructions. The former OpenAI WebRTC call, `/v1/voice/live/*`, voice-identity, preview, allowance, and realtime-turn endpoints return `410 VOICE_PROVIDER_RETIRED`. This does not change the provider used for ordinary text reasoning.
- `POST /v1/voice/gemini/cascade/sessions` requires a paired device, rate-limits session creation, and asks Google for a one-use ephemeral token fixed to `gemini-3.5-transcribe-live` with TEXT output and Japanese input transcription. The permanent Gemini key remains only in Azure's mode-0600 secret environment file. The client receives the selected server-side Gemini TTS voice and cost metadata, never the permanent key.
- The iPhone streams 16 kHz mono microphone PCM for continuous transcription. A value-typed turn assembler merges cumulative or incremental final segments without duplication, preserves raw and normalized text separately, records final-segment provenance and timestamps, links explicit corrections to the prior turn, and canonicalizes the registered product vocabulary before delegation. Gemini currently supplies neither alternatives nor confidence, so those envelope fields remain empty rather than fabricating certainty. End-of-turn delay remains punctuation- and connective-aware, while Gemini's explicit `turnComplete` closes immediately.
- Before generation, Jev independently scores every available voice capability (`current_web`, conversation memory, daily mind, Aether notes, Voyager tasks, agent status, and device context), reply necessity, concrete-solution need, conversation class, expected latency (`under_1s`, `under_3s`, `under_10s`, or `over_10s`), affect, affect intensity, and delivery. Every capability remains a separate Noul and every score at or above the live-calibrated `0.85` default threshold is selected. The configured chain is Jev, then minimal `gpt-5.6-luna` strict structured output, then conservative local rules; a Jev outage therefore no longer skips the lightweight model when its key is available. Deterministic safety floors preserve mandatory current-information and explicit capability routing including daily mind, contradictory no-response/class answers are normalized, standalone acknowledgements remain silent, and guest mode removes private capabilities.
- Owner cognition persists an expressive state independently from the small transport affect label: primary and optional secondary emotion, intensity, target, cause, arousal, valence, visibility, start time, decay, carryover, and override reason. Jev's bounded result is provisional so the first TTS sentence need not wait for full generation; completed reply cues reconcile the durable state for later sentences and the next turn. Safety, grief, and emergency overrides prevent jealousy, sulking, teasing, or performative anger from displacing support. The persona uses `ボク` and addresses the owner as `ライ氏`; emotion changes delivery and phrasing but never fabricates evidence or authorization.
- The reply classifier selects `no_response`, `greeting`, `direct`, `skill_simple`, or `skill_complex`. Silence is used only when both the class and the independent reply-required probability agree. Low solution-wanted probability explicitly tells generation to favor emotional presence and companionship instead of forcing a checklist. The server includes only selected capability projections, four to eight bounded history items, no web tool unless selected, and low reasoning only for complex skilled turns. Greetings and direct turns use smaller output ceilings, one or two short sentences, and no automatic trailing question. An explicitly stated new owner goal still uses the structured lane so its bounded durable intent plan is not lost.
- For ordinary voice turns, Azure consumes the OpenAI Responses SSE stream and emits only complete speakable sentences over authenticated NDJSON. Turns expected to exceed three seconds first emit one capability-specific waiting phrase, allowing its Gemini TTS request to overlap retrieval and model generation. The iPhone then starts final-answer TTS as soon as the first sentence closes, prefetches exactly one following sentence, and preserves FIFO playback. Display text retains expressive notation; a separate speech renderer removes emoji and kaomoji and maps product names to Japanese pronunciations before synthesis. Affect intensity joins affect and delivery in the bounded acting direction. Azure translates Gemini SSE audio into an authenticated unbuffered stream, and iOS buffers only 100 ms before queueing the first playable chunk.
- Voice diagnostics remain content-free and now separate turn assembly, Jev decision, context assembly, first model token, model completion, first streamed text, first TTS audio byte, first scheduled playback, and interruption latency. A 21-case live Jev evaluation catalog covers silence, greetings, casual and emotional conversation, all selectable capabilities, implementation/progress, friend introduction, Discord, Minecraft, and complex research; the paid run is opt-in through `test:llm-voice-router` and reports only case IDs, bounded decision metadata, pass rate, and latency percentiles without transcript content.
- Gemini voice uses simultaneous `AVAudioEngine` capture/playback with Voice Processing I/O, Bluetooth HFP, default speaker output, echo cancellation, and no local sidetone. A silent output source keeps the audio graph rendering before the first reply. With the default-on brightness setting, remote playout passes through `AVAudioUnitTimePitch` at the selected production value of +50 cents; disabling it restores dry playout. No robot texture or other timbre effect is applied. The microphone stays open during synthesis and playback. Local speech first ducks playout to 18%; a final transcript or 340 ms of confirmed speech discards queued audio and cancels reply generation, while an 850 ms false-positive window restores volume.
- A session-owned pending-input ledger retains every finalized utterance independently of response tasks. Barge-in cancels only output; the replacement request includes unfinished-generation input and additions/corrections in chronological order. A validated complete reply is displayed and acknowledges only its frozen input prefix immediately (or an intentional no-response decision), independently of audio delivery. Its owner history write is session-owned and cannot be cancelled by barge-in; the next generation waits for this write to settle so completed dialogue remains context, not another unanswered request. Full text remains available if TTS fails, and the notice explicitly distinguishes generation failure, interrupted generation after partial audio, and audio-only failure. Incomplete output never acknowledges input or becomes a complete history pair; a completed visible reply is not evidence that all audio was heard. The NDJSON completed event is terminal, without waiting for transport EOF. AVAudioPlayerNode dataPlayedBack callbacks drain playback instead of a duration estimate, with invalidated tickets on stop, cancellation-safe waiters and a 180-second stall watchdog. Generation IDs fence stale stream, playback, and error callbacks. Reconnect retains pending input; an explicit close or participant-mode switch clears it. Owner history preserves original ASR text in the same Talk thread; guest mode has no owner context or transcript persistence. Content-free response IDs, completion/interruption/failure stage, error category and pending-input counts distinguish playback from generation. Azure closes cancelled audio iterators and does not log caller cancellation as a provider failure; genuine provider failures still propagate.
- Jev evaluates semantic transcript reliability with original ASR and at most four same-thread, 600-character history entries. This is not an acoustic confidence estimate. Below the configurable default 0.85 threshold, or when assessment is missing for a speech-origin input, the answer model interprets context and answers in the same call (no extra serial model call). Consequential ambiguity requires confirmation; interpretation cannot create commands, intents, or task proposals. Typed/photo-origin input retains its explicit authorization contract. Original utterance identity remains separate from the aggregated answer input.
- Gemini voice controls are always labeled and visible (microphone, confirmed single-photo sharing, participant mode); accessibility text sizes stack them instead of hiding them in a nested menu. A native multiline composer lives in a keyboard-aware safe-area dock. A small microphone-level glyph replaces the wide progress-like line and bottom spotlight; it has no synthetic processing sweep and stays still under Reduce Motion. Operational phase text and the Waterlight Eye remain authoritative.
- Voice-identity iteration also has a private browser workbench that is deliberately outside the iPhone release cycle. A separate Azure service binds only to `127.0.0.1:4322`, is reached from the trusted Mac through an SSH local-forward, reuses only the existing mode-0600 `GEMINI_API_KEY`, and has no Nginx route or Shannon database access. TTS samples, source text, Live PCM, transcripts, and ephemeral tokens remain in memory and are not logged or persisted. Voice Design is the explicit exception: it requires an acknowledgement before Google stores the new Voice ID, and deletion requires the exact ID.
- The browser workbench remains the private place to create, compare, and tune stored Gemini Voice IDs and acting profiles without an Apple release. The comparison lane can generate the same script across up to four voices and both TTS models, then repeatedly audition 0–600 cents of pitch lift and a bounded 0–50% ring-modulation / short-comb robot texture entirely in browser memory without another Gemini request. Its default production preset is +50 cents with robot texture disabled, matching native playout; other values remain audition-only until separately selected and implemented. Its cascade mirrors the app architecture and measures transcript-final-to-text, text-to-first-audio, and combined latency. Text history, original PCM, and processed WAV stay in the tab, the permanent key stays on Azure, and the lab service has no Shannon database route.
- During an active owner voice session, the iPhone can open the system camera or photo library from an explicit button, select one still image, locally normalize its longest side to about 1280 pixels and its size to at most 2.8 MB, and require a visible preview confirmation before upload. Azure validates its declared format, limits snapshots per paired device and to one in flight per owner, sends the image to the fixed vision model with `store: false`, and returns only a bounded observation to the Gemini cascade. There is no continuous capture, background camera access, unknown-person identification, or sensitive-trait inference.
- Voice delegates exact time, location, weather, transit, notes/tasks, and fresh memory through the authenticated client lane. Each delegated turn includes the server clock rendered in the iPhone's time zone. Only a location-seeking utterance triggers a one-shot When-In-Use location request; the client sends rounded coordinates and accuracy only for that request. Existing confirmation and external-write boundaries remain unchanged.
- Interim and final Gemini input-transcription events update the visible participant caption while the user is speaking. The transcription session requests Japanese and supplies a bounded product-name vocabulary (`シャノン`, `ライ`, Aether, Voyager, Syzygy, Jev, Minebot, Codex, SwiftUI, and TestFlight). Shannon's visible reply grows sentence by sentence while separately normalized speech audio is generated and played.
- Explicit user goals may carry one exact `cognitiveIntentID` into an accepted Agent task. Host events, plan state and test results are then projected back as verified work; model prose and title similarity cannot mark progress. A completed task asks the owner to review and close the broader goal rather than silently completing it.
- The initiative loop may return a stale unlinked goal, pending approval, paused/failed task, or completed linked task to its originating conversation. It remains bounded by quiet hours, a 90-minute conversation cooldown, and one initiative per owner-local day; it proposes the next decision and never grants approval or performs a new external mutation by itself.
- A call starts in owner-only mode. The owner can explicitly reconnect it as a temporary guest session when a friend joins. That session uses a generic Shannon voice prompt with no owner state, memory, tasks, thread history, or speaker identification. Its transcript is labeled as participant speech on-device and is never committed to conversation or memory; camera sharing is unavailable until the call returns to owner-only mode. Ending and reopening voice resets the choice to owner-only.
- Each Gemini cascade start has its own transport/model lifetime; closing, switching participant mode, retrying, or leaving the active scene cancels outstanding recognition, reasoning, synthesis, and playback. Diagnostics contain timing, phase, route, and byte-count metadata only—not audio, transcripts, messages, credentials, tokens, or file paths.
- The composer floats over the edge-to-edge conversation with a readability gradient. It stays as a compact single row when empty, then expands into a text-and-actions layout when focused or populated. The same text-input instance is retained while the custom layout moves it; keyboard focus never destroys and recreates the active UIKit text view. File/transcription actions, Gemini voice, and send remain distinct controls. The message list reserves dynamic visual clearance for multi-line input, voice status, failures, and task notices while remaining visible beneath the lower chrome during scrolling.

Live2D and animated widgets remain future work. Current dialogue mode and Gemini voice use a static character-stage asset with state-driven ambient motion.

Background voice activation remains deliberately later work. Gemini voice starts only from an explicit user tap and ends when dismissed or when the app leaves the active scene.

## macOS experience

- `apps/macos-app` is a separate native macOS application target inside the Shannon repository. It is another client for the same Shannon product, not a separate personality, backend, or data store.
- The Mac target uses the same `com.r41r41.shannon` bundle identifier as the iPhone target so App Store Connect can add macOS to the existing Shannon app record. It remains a separate Xcode target and may advance its platform-specific build number independently.
- `apps/ios` remains the shared Apple-client core. It already targets iOS 17 and macOS 14; networking, pairing, conversation state, thread operations, memory, Markdown parsing, artifact validation, expression assets, and durable agent-task projections are reused rather than reimplemented. Mac presentation, attachment loading, save-panel integration, keyboard commands, and native-window behavior stay in `apps/macos-app`.
- The default Mac layout is a `NavigationSplitView`: thread and destination sidebar, a neutral reading/work surface, and an inspector that opens only when work context is useful.
- The root view owns the fixed 860×600 minimum window size. Scene-level content-driven minimum sizing is not combined with the restorable inspector, because adding or removing that inspector changes the content constraint tree during AppKit's window update pass.
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
- Mac and iPhone Settings identify Gemini as the voice provider. The active custom Voice ID is server-managed so every client receives the same Shannon voice on its next session.

## Explicit conversation organization and Voyager Phase 2

Text and owner voice use the same command executor for bounded explicit requests such as `写真整理をタスクにして`, note proposals and commitment lifecycle changes. The backend returns a durable task session; voice also receives its receipt. The same review card appears on iPhone and Mac even without an attached text message or completed spoken turn. Reloading the thread restores it. The voice utterance ID deduplicates retries across SQLite restarts; ordinary text sends retain their existing per-request behavior. Review and final destination application still use the existing explicit UI; a spoken proposal acknowledgement is not a completed Voyager write. Mere mentions, negations, quoted commands and conditional completion statements do not authorize commitment changes.

Owner text and voice also share a bounded SQLite-backed conversation execution state. It records one `pendingAction`, `awaitingConfirmation`, approved scope, added requirements, corrections, interruption time, stable resume token, and source references per thread. A follow-up such as an addition or correction updates the same visible proposal identity instead of producing a parallel task. Once an Agent task exists, only its durable event stream supplies execution receipts; generated prose cannot claim start, progress, failure, cancellation, or completion. Spoken steer, pause, resume, and cancel commands require one unambiguous current-thread task, preserve waiting approvals, and use the utterance ID as the idempotency key. Guest sessions cannot read or mutate this state.

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

Text and voice use the same bounded read projection. A supported explicit owner voice command can enqueue a note proposal. A durable request receipt prevents a retry from recreating the inbox file after Aether has consumed it; an ambiguous interrupted publication fails closed and asks the user to inspect the inbox. No consumer-side contract or canonical note format is changed.

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

Due, visible, pending commitments can also supply a candidate to that same loop. A date without a time becomes eligible after 09:00 in its stored time zone. Each commitment revision is delivered at most once, and status/forget controls are rechecked at insertion. Existing quiet hours, 90-minute conversation cooldown and daily limit still apply: this is a throttled conversational reminder, not an exact-time alarm or autonomous task execution. Sleep reports now audit pending/completed/canceled/undated/overdue commitments; they do not silently mark them completed or retrain model weights.

## Scope of the cognitive hardening

Turn recall now uses observed timestamps for recency, explicit location mentions, explicitly named registered participants and a matching current commitment. Retrieved items carry their evidence time. A small deterministic synonym map handles selected paraphrases; there is no embedding index or general semantic retrieval yet. Memory-sensitive voice questions are instructed to consult fresh backend state, but this remains provider tool-use behavior to evaluate on-device, not a guaranteed per-audio-frame shared-context update.

Waterlight consumes a native provider-neutral embodiment frame derived from actual speaking/listening/tool activity. This connects tool attention to the displayed state without changing audio processing. The TypeScript runtime types, durable intention ledger, bounded initial plan proposal, expressive state, and conversation execution state provide one response orchestrator, not a universal planner. Progress-aware replanning beyond the active request, Live2D rendering, cross-product autonomous action orchestration, and model-quality A/B evaluation remain separate work.

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
| Retired realtime voice allowance ledger (migration compatibility only) | `realtime_voice_session_reservations` |
| Legacy platform ingestion | `platform_turn_receipts` plus canonical conversation and background-job rows |
| Person identity registry | `people`, `person_platform_identities`, `person_identity_events` |
| Intention and cognitive audit | `cognitive_intents`, `cognitive_cycle_receipts` |
| Cost | `llm_usage_events` (`chat`, `sleep`, and `voice` lanes) |
| Pairing | device pairing records and device tokens |

## Cognitive Evaluation Harness v0

自己改善機能を本番経路へ導入する前段として、`packages/evaluation` に開発・CI専用の決定的評価Harnessを置く。合成scenarioを現在の `@shannon/cognition` 公開APIへ入力し、状態遷移、記憶境界、想起、感情、Intent選択、Prompt投影を再現・比較する。

- 通常会話とFCA応答経路からHarnessを呼ばない。
- SQLite、HTTP、LLM、Agent Hostへ接続せず、Runnerはファイルを書き込まない。
- 実会話、scope key、credential、忘却済み情報をfixtureへ複製しない。
- reportは評価証拠であり、`agent_tasks` の状態や昇格承認ではない。
- 評価通過だけでmerge、push、配布、Capability拡大を行わない。
- `scripts/verify.sh cognition-eval` は回帰、無効scenario、型不整合で非ゼロ終了する。

Phase -1ではSkill生成、独自NN、Fine-tuning、人格学習、Shadow/Canary、自動ロールバック、本番DB migration、API/UI変更を行わない。

## Code ownership

`Shannon.xcworkspace` is the sole interactive Xcode entry point. It owns the shared
package-resolution context for the iPhone and Mac projects, which both consume the
local `apps/ios` package and its `ShannonAppCore` product. The individual projects
remain buildable artifacts, but must not be opened concurrently as independent Xcode
workspaces. `scripts/xcode.sh` is the sole command-line entry point for Apple app
build profiles, and `scripts/check-xcode-workspace.mjs` owns the focused structural
guard instead of coupling Xcode rules to the general repository harness. Its guarded
`open` profile validates the workspace, resolves both schemes, and only then opens
Xcode; the Finder launcher delegates to that same path.

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
- `packages/evaluation`: synthetic, offline characterization and comparison over the public cognition boundary; it does not own production state or side effects.
- `deploy/macos`: launchd configuration for the local Agent Host.
- `deploy/azure`: production services, optional isolated cloud Agent Host, and configuration examples.

Production Swift and TypeScript source files have a 500-line ceiling. `scripts/check-architecture.mjs` also keeps WebRTC inside its transport adapter, Security inside the Keychain adapter, UI frameworks out of the HTTP adapter, retired monolith files absent, and every nested Mac source included in the generated project. `scripts/verify.sh` runs this guard before API and Apple-client verification.

## Production layout

```text
/home/azureuser/shannon-ios/                  # deployed source
/home/azureuser/shannon-ios-data/shannon.sqlite
/home/azureuser/.config/shannon-ios/api.env   # secrets and production settings
/home/azureuser/shannon-voice-lab/             # isolated private browser lab source
```

Systemd services:

- `shannon-ios.service`
- `shannon-ios-worker.service`
- `shannon-ios-world.service`
- `shannon-gemini-voice-lab.service` (optional, loopback/SSH only)

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
