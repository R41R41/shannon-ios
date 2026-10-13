# Shannon signal observer

Status: the original Observer is deployed. The common-FCA map and timing revision is implemented on `codex/shannon/fca-observer`, based on accepted main `eaf6b84f`; production reflection is a separate gate. The foreground stable-cache change is included from `codex/shannon/stable-foreground-cache`.

## Owner redesign (2026-10-13)

The owner chose, from side-by-side mocks, a per-turn **timeline as the main view** with a switch to the **layered map**, both with a 「現状 / 目指す姿」 switch. This supersedes the compact seven-lane map and the nine route buttons described below; the transport, pairing, credential, audience, receipt and bounds rules below are unchanged.

- **Timeline (時間割).** The selected run (or FCA task/step) is laid out from observed `startedAt` and measured `elapsedMs` only, one lane per subsystem block, parallel spans on separate rows, never summed. The run root is a header bar; when its terminal output carries turn steps, a 「モデルへ N ms」 marker is drawn. Running spans grow as a browser lower bound since receipt. Client spans keep their own clock and scale. A failed span is red and shows `errorKind`; a 「失敗 N」 button jumps to the latest failure. Spans whose start was not observed are listed, not placed.
- **Detail.** Clicking a bar or box shows the observed input/output as rows (key, Japanese gloss, value), ids, origin, model, timing provenance, the catalog location/coverage, the turn steps with 「段の外」 for the run root, the base steps with the unmeasured gap for 記憶の土台, concurrent spans, and the tool registry/evidence for tool-related boxes.
- **Map (地図).** Blocks are processes/subsystems (端末, 会話の経路 = api, 共通 FCA = api・worker, 声の出力, 心の後処理 = mind・worker, 自分の時間 = autonomy worker, 共有 SQLite, 外の体と反射 = world・agent-host). Semantic zoom: blocks → boxes → each box's first input/output fields and last duration. Dots move only for received explicit handoffs (block connectors at the block level); receipts glow for three seconds; reduced motion keeps the glow only. Block chips replace the route buttons and focus a lane/block.
- **View boxes are a projection, not new events.** `observerMap.js` maps contract nodes to current-architecture boxes using explicit payload fields only: `turn` → 受付; `recall` with the turn's deterministic input (`message` without `semantic`, `strategy: deterministic`, `phase: task_deterministic`) → 記憶の土台, otherwise → 意味で想起; `jevt` with `selector: fca`/`phase: fca_selection*` → FCA 道具選択, `selector: reflex*` → 反射の判断, otherwise (and `jevv`) → Jev ルーター; `llm` with `provider: jev|openai_decisions` → Jev 呼び出し, otherwise → Haiku 道具ループ. 自己とできること, Executive and 共有 SQLite are display-only boxes without events. Every contract node still has a box, so events from older native clients (`pcm/stt/join/play`) and rarely used producers (reflex, perception, workspace, voice plan, autonomy) stay visible.
- **目指す姿.** The ADR-0009 view (きっかけ → Executive → 能力カタログ → 一つの依頼 → FCA/手順 → 証拠 → 報酬 r2 → 価値表・目標 → 次の選択; one budget; the conversation fast path) is animated locally from fixed dummy data in `observerMap.js`, labelled 「ダミーの動き」 everywhere. It creates no observer event, reads nothing and is not stored; live polling continues underneath.
- **Turn steps on the event.** The turn's terminal event (`run.completed`, or the root `span.failed`) now carries `output.steps` (closed `TURN_STEPS` names → rounded milliseconds) and `output.modelStartMs` when the turn measured a step; the `Shannon turn steps` log line is unchanged. Runs without steps keep `{ status }` only.
- The page still uses exactly the five allowlisted assets (`index.html`, `observer.css`, `observer.js`, `observerAnalysis.js`, `observerMap.js`), no inline style attribute, script or external font (the page CSP is unchanged), so the Windows bundle list is unchanged. Light and dark follow the device; phone width has no horizontal page scroll (the map pans inside its own stage).

## Owner experience (2026-10-09, superseded in layout by the redesign above)

`GET /observer` is a detailed dark architecture map. Each converter, voice and tool Jev selector, actual provider call, tool gate/executor, voice sentence/plan/TTS stage and worker has a separate box. Selecting a box shows actual observed input/output projections, model, duration, run, span, parent, implementation path and server/client provenance. TOOL expands the canonical registry including `tool.open`; filters distinguish definitions, offered, selected and executed names. Registry presence grants no permission.

The graph polls authenticated events every 400 ms. A 240 ms dot depicts receipt of an **explicit handoff**, not transport speed or the time the original transfer occurred. Boxes remain active until their own terminal event. Overlapping spans are independent. Initial history is still. Gaps, server restarts and publisher/client losses clear uncertain state; transport loss marks unfinished spans unknown. Hidden pages stop polling and clear private projections. Reduced motion suppresses moving dots. The product generates no demonstration events or paid calls.

Role colours remain stable across states: gold input/perception, coral Jev/context/LLM, mint tools/control/execution, blue reply/audio, lavender memory/learning. Wires, arrowheads and packets use their sending node's role. Newly received selected-run events add a three-second, opacity-only receipt glow to their observed node; explicit handoffs also light their two endpoints and wire. Repeated receipts renew the three-second window, bounded to one animation per box/wire and 96 trails globally. These trails show recently observed passage, not ongoing work or elapsed transport time. Initial history/gaps/loss/restarts never replay them. Changing runs, disconnection, audience hold, hiding and relayout clear them. Reduced Motion retains fading glow while suppressing moving dots. State symbols/text and the role legend remain readable without relying on colour alone.

Open the API's HTTPS path (for example `/companion/observer`), then pair using the existing code flow or enter a paired token. By the owner's explicit reload-retention request (2026-10-09), the token and its expiry are kept in this tab's `sessionStorage`, scoped to the API base path. Reload restores the connection and revalidates it through the same owner-only endpoints. Codes and observed payloads are never saved; neither token nor code enters a URL or log. Explicit disconnect and 401/403 clear the saved credential; expiry/malformed storage also clear it. Unavailable storage retains the original memory-only flow. Page hiding/reload aborts polling and clears the private DOM while retaining this tab credential; ordinary tab closure ends the storage session (browser session-restore behaviour is browser-controlled). `/observer/` redirects to `/observer`. Static assets are public and contain no data. Data endpoints require a paired principal in the exact configured owner scope, exclude Minecraft credentials, and recheck owner-alone presence at delivery. Unknown/other audience holds and clears the view. Fixed/dev bearer, bridge and Host tokens cannot read it.

Receipt effects remain suppressed across every 200-event history page until a short page drains the backlog. The same fence resets after loss, gap, changed server instance, held state, pause or reconnection. There is no inference of a fresh handoff from timestamps or from merely being on page two.

## Event and correlation contract

Version 1: `contracts/observerContract.ts`. `GET /v1/observer/events?after=<sequence>&limit=1..200` returns bounded ordered events, cursor, oldest cursor, gap, server instance, availability, generated time and loss count. `GET /v1/observer/catalog` returns actual definitions, locations and coverage. Capacity: 300 requests/device/minute. Scope overrides are ignored.

Events have run/span/parent IDs, node, kind, origin and timestamps; spans have optional model/input/output/elapsed time. Explicit handoffs name source/destination and source span when known. AsyncLocalStorage separates turns and copies each branch's source map; neighboring timestamps do not establish causation. An explicit different scope/run gets a separate run; a nested shared audience cannot enable private capture. Helpers call the original operation once, preserve its result/error and ignore observation failures. Each actual provider request round is recorded. A cached Jev decision has a cached selector outcome and no fabricated provider request.

Common-FCA events additionally carry optional opaque `taskId`, `parentTaskId`, `stepId` and `actionId` fields. A task can span several runs and segments; a run is not a new task. The tree uses only explicit producer relationships and labels missing/conflicting parents. Existing foreground generation remains under its respond lease (`foreground_generation`, `existing_respond`), independently of background admission. TaskHub observations describe canonical method returns, which can occur inside a caller-owned transaction; they are not execution receipts or proof of an outer commit. Publisher failures never change the durable operation.

The compact map has 38 separate processors in seven lanes. Task selection combines only explicitly correlated events; step selection narrows a task to a segment. Possible-path buttons dim unrelated wiring without generating events. State and outputs still require observations. Admission, FCA segments, history compaction, recall, shared affect/evidence, reflex entry/choice, body observation/acknowledgement and common sleep phases join the existing provider/tool/audio instrumentation. External Minebot and Agent Host interiors remain unmeasured.

Duration is measured using the producer's monotonic clock. Completed `elapsedMs` samples alone enter median and nearest-rank p95, with sample/total counts; running, failed, unknown and unmeasured counts remain separate. Processor, model and origin are separate groups. Parallel spans are shown as overlapping timeline rows and never summed into wall latency. Server and client timestamp domains are displayed separately. While active, `≥ N ms · 受信後` is only a browser monotonic lower bound since receipt. WAIT is a recorded state checkpoint, not a measured dormant waiting interval. Queue measurement covers the actual admission call, not unobserved queue residence. Body control duration ends at server acknowledgement, not at an independently measured physical operation.

Native streamed LLM outputs can include `firstVisibleOutputAfterMs` (first nonempty decoded reply accepted by the server callback) and `finalUsageAfterMs` (final provider usage receipt). Tool-only, withheld and nonstreamed rounds omit the first-visible measurement. These are per-request measurements; they do not separate prefill, reasoning or provider queue time and do not establish device display or acoustic onset. Cache read/write counts retain independent reported denominators; absent counts remain absent, not zero. Local fixture model durations are explicitly labeled and cannot establish provider latency or cache performance.

The Apple cascade reports transmitted PCM counts, item-ID-bound transcription start/final counts, normalized utterance IDs, delegation handoffs and actual `.dataPlayedBack` completion/cancellation. No PCM buffers, transcript text or images are sent. Capture session UUIDs and utterance UUIDs stay distinct. Join events reference source capture/STT spans. The voice request's `deviceContext.userUtterance.id` seeds the server run; the originating reply UUID travels through TaskLocal and `x-shannon-observer-run` to TTS. Waiting speech and a final utterance need not share a run. No timestamp-based join is invented.

`POST /v1/observer/client-events` accepts max 16 events/32 KiB, timestamps within two minutes, UUID IDs, native nodes `pcm/stt/join/play`, restricted handoff endpoints and forced client origin. It cannot report server root lifecycle, Jev, LLM or tool execution. Optional `droppedEvents` is integer 0..4096 alongside real events, or as a loss-only batch. Native queue cap 64, tracking caps 32, one-second batches, one attempt per event batch/no payload replay. Failed sends discard payloads and carry only a bounded loss count. Automatic draining permits one loss-only report attempt, then waits for the next real batch if still offline. Audience is checked at enqueue/send. The viewer rejects node/origin changes to an existing span ID. Authenticated client telemetry is an observation, never an execution receipt or action command.

## Data and performance boundaries

This is an owner tool, separate from cognition ledgers and activity authority. Projections contain visible reply/sentence text, closed decisions, names, counts, cache usage and executor outcome fields. They exclude system/profile prompts, hidden reasoning, signed thinking blocks, private recall/knowledge/draft contents, credentials, audio and images. Arbitrary tool arguments/results are not copied. The final guard bounds strings to 2000 characters, arrays to 64, objects to 32 keys, depth to five and projected JSON to 12,000 characters. Values are bounded projections, not complete prompt/provider bodies.

Each API/worker installs a non-awaiting publisher: queue cap 512, batches 64 on `setImmediate`. A single bounded sidecar counter makes worker loss visible to the API reader; expired cursors clear even if every retained event has expired. Failure/overflow cannot change chat, action gates, receipts, provider requests, signed prefixes, caches or budgets. Separate `<SHANNON_DATABASE_PATH>.observer` SQLite stores at most 2000 events globally and a 15-minute read window. Startup and an unref'ed minute timer prune expired rows even when no new event arrives. Permissions 0600, secure-delete and passive WAL checkpoint are used. Logical retention is not a forensic-erasure guarantee for filesystem/backups. No conversation database migration is needed. A sidecar startup failure leaves the API alive and the viewer unavailable. Instrumented coverage is not proof a process is online.

## Coverage and limits

Native Haiku/Sonnet Messages rounds and native Responses conversion, Jev voice/tool choices, tool permission/execution/commit, text/voice recall/context, workspace **projection**, reply decode, emitted voice sentences, TTS, memory outbox, sleep/refinement, embedding batches, autonomy steps and world-source/focus work are instrumented. Workspace scheduler/lease internals, external Minebot execution and Agent Host internals lack an end-to-end span bridge. Deliberate legacy OpenAI/Gemini response overrides are not universally instrumented. External/unobserved boundaries are explicit. Inactive boxes are not assumed busy or complete.

Workers have separate runs: existing queues/IPC do not carry the originating turn run ID. Scheduled experience IDs are recorded without invented background parentage. PCM/STT is a capture-session run; an utterance links explicit source spans, not every audio chunk. Native events require the changed Apple build to be installed. Deterministic tests prove contracts and behavior preservation; they do not establish a live-device/production connection before distribution.

## Verification

Backend tests cover request equivalence ON/OFF, caching/no extra calls, signed prefixes, withholding/commit outcomes, source isolation, bounds/retention, loss/cursor/restart, actual HTTP auth/audience and client forgery controls. Frontend tests cover overlap, deduplication, tool evidence, provenance, transport races and clearing. Swift tests cover bounds, IDs, audience, TaskLocal and playback callbacks.

`pnpm exec tsx scripts/observer-ui-smoke.ts` starts an **isolated UI fixture** using real assets, pairing/auth, routes and publisher with in-memory storage and controlled deterministic operations. It contacts no model or production/external data. Commands exercise concurrent runs, handoffs, completion and audience changes. [Browser evidence](observer-ui-validation.md) is fixture evidence, not production/device evidence. Final verification follows `AGENTS.md`.

### Local verification record (2026-10-08)

- `scripts/verify.sh all`: fast guards, API typecheck/272 files/3575 tests and cognition/evaluation/learning/mind typechecks/39 files/425 tests passed. The Apple phase reported one failure in the unchanged `theWatchdogBoundsAStallNotTheLengthOfATalk` timing test.
- Without code changes, `scripts/verify.sh ios` reran the complete Apple suite: 777 XCTest and 175 Swift Testing tests passed (952 total), including all nine observer tests and the previously failed watchdog test. No test was removed, skipped or relaxed.
- Browser fixture verification includes desktop/compact, keyboard/tool expansion, packet receipt, disconnection/audience erasure and explicit cross-run client references. See the linked UI record and safe screenshots.
- `scripts/verify.sh app`, `scripts/verify.sh mac`, and `scripts/verify.sh release-runner` completed in sequence with exit 0: unsigned iOS app build, Mac debug build/28 tests, seven restored-inspector launch cases (12 seconds each), and eight release-runner tests passed. Physical-device installation, TestFlight and production are unverified for this branch.
- After rebasing onto main `59e83f20`, `scripts/verify.sh api` passed with API typecheck, all fast guards, and 272 files/3585 tests. Both the fallback lazy-tool-menu behavior and the observer were retained at the overlapping native request boundary. Apple/shared-package code did not change in that rebase.


## Compact lane layout and Windows transport (2026-10-09)

The owner selected the compact processing lanes. The main tool loop is arranged
as MODEL I/O → LLM → TOOL GATE → TOOL → MODEL I/O, with related processors grouped
in seven lanes. Orthogonal wires avoid processor boxes; route highlighting and
actual receipt motion remain independent. Layout does not create processing events.

The Windows viewer uses the same allowlisted static viewer assets, bundled with
the desktop app. A dedicated sandboxed window receives a narrow preload bridge
for `catalog` and `events` reads and content-free connection state. The existing
paired desktop credential stays in the main process and its encrypted store;
no token or pairing code reaches the observer page, URL or session storage.
Connection replacement advances an epoch, clears prior observations and rejects
late responses. Pause/hidden states stop polling. Owner/audience and server
projection checks remain unchanged. Observer refusal does not revoke the shared
desktop connection. Browser pairing and tab-scoped credential retention remain
available through the existing HTTPS viewer.

Source integration, package generation, Windows installation and real Windows
runtime acceptance are separate evidence gates. Importing a dated source handoff
cannot establish which executable is currently running on the owner's computer.


Each bound task branch owns a copied source-span map. The initial binding of an
untagged foreground run can retain its actual caller ancestry. Switching an
already known task or step clears source/active-span provenance and resumes only
under the run root; an older outbox outcome cannot claim the current task's
prediction as its source. Visible-output timing includes awaited server callback
backpressure, rather than using the earlier provider delta arrival timestamp.
