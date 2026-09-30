# Conversation regression audit

Status: investigation and test coverage; product fixes and distribution are not included.

Observed: 2026-09-29 JST. Source baseline: `00c210213662b4fbc3b3571128afe9e82dbccf61`.
Local work: `codex/shannon/regression-audit`. Use this report as a coverage map, not a release gate.

## Status at integration — 2026-09-30

Integrated onto `main` at `f294123` (Build 101 source). Findings below are dated to the
original baseline unless noted here.

| Finding | Current state on `f294123` |
| --- | --- |
| Suite identity and Japanese aliases | **Open.** The non-live audit (`LocalVoiceDecisionGateway`, no billable calls) still passes 0/7: no prompt contains explicit Aether/Voyager definitions; `エーテル…設計` and `ボイジャー…予定` select no internal skill and call no reader; the Japanese latest-status question selects only `current_web`. |
| Shared voice request budget | **Resolved by `5d6e9cf`.** Session/delegation requests now use a 30-per-minute control budget and sentence TTS a separate 60-per-minute speech budget (`VoiceRequestAllowances`). The audit script now characterizes those production budgets; the 11-request synthetic turn is fully admitted. |
| Automated result counts and UI smoke | Historical for `00c2102`; `main` has since added tests. Re-run the commands below for current totals. |

## Incident and root causes

Read-only production conversation inspection found a request mentioning the Japanese
names of Aether and Voyager followed by a reply treating them as unidentified products
and searching unrelated retail delivery information. The log contains text, not the
original audio. It cannot establish whether the recognized noun was what the speaker
actually said. The stored message metadata does not retain the original routing decision.

Independent synthetic reproduction with the configured Azure Jev and answer model
confirmed the same identity failure: the Japanese-name definition question prompted
the model to ask which game/product was intended. The Latin-name question produced a
mostly appropriate notes/tasks distinction. These are synthetic probes, not replays of
private production conversations.

Three code-level causes are independently visible:

1. `services/api/src/apiLiveVoice.ts` selects a slim persona prompt for owner turns
   without `conversation_memory`. Neither this prompt nor the core identity prompt
   guarantees definitions of the three suite products. Selecting an internal skill
   can incidentally provide a product name, but that is not a product identity contract.
2. `services/api/src/voiceDecisionContract.ts` mandatory patterns recognize
   `aether`/`voyager` and generic note/task words, but not `エーテル`/`ボイジャー`.
   `services/api/src/conversationCapabilities.ts` applies another Latin/task-word gate
   before reading Voyager. In the live audit, Jev correctly chose `voyager_tasks`
   for a Japanese-name schedule lookup, but the downstream task reader was never called.
3. The mandatory `最新` pattern selects `current_web`; `services/api/src/chatModel.ts`
   forces a web tool call for that selection. An internal development-status question
   can therefore go to external search before the app identity is resolved. In the
   synthetic latest-status probe, only `current_web` was selected and neither internal
   reader ran. The audit suppressed actual web execution; the unrelated search itself
   is evidenced by the production reply, not by a synthetic web call.

The intended definitions come from Syzygy's suite operating model: Aether owns
documents/notes/thinking and plans; Voyager owns task status/priorities/deadlines/next
actions; Shannon owns conversation, support, and user-directed execution. Knowing
these public roles does not authorize reading private notes or starting a task.

## Automated results

| Gate | Result | What it establishes |
| --- | --- | --- |
| API baseline regression | 437/437 passed on initial and reduced-concurrency runs, 59 files | Auth, durable stores, routing, cross-app fixtures, commands, streaming, memory, task lifecycle |
| Swift package | 178 XCTest + 36 Swift Testing passed | Shared client/model/protocol tests; includes the added repetition test |
| Cognition/evaluation | 58/58 passed, 6 files | Pure state, prompts, and synthetic evaluation harness |
| Release Runner | 8/8 passed | Release orchestration fixtures, not a new distribution |
| Fast/typecheck | Passed | Workspace, icons, semantic roles, labs, architecture boundaries, TypeScript |
| Live Jev classifier | 19/21 matched expectations | Actual Azure-configured Jev, threshold 0.85; p50 175 ms, p95 207 ms |
| Live memory extraction | 27/27 | Synthetic preferences/profile/relationship inputs and facts that must not become memory |
| Live agent-task proposal classification | 6/7 | Actual model proposal decisions; no task execution |
| Live daily-mind generation | 1/1 | Bounded synthetic reflection and usage recording; no production save |
| New suite-context audit | 0/7 | All inspected prompts lack explicit suite definitions; specific routing/read failures below |

The deterministic total is **717 distinct tests**, excluding duplicate reruns and fast
checks. A simultaneous rerun with the Simulator/Swift workload produced six 5-second
timeouts in three API files (`agentWorkspaceSnapshot`, `dailyMind`, `geminiSpeech`),
with no assertion mismatch. The complete rerun with `--maxWorkers=1` passed 437/437
without changing the 5-second timeout or any production code (161.67 seconds wall
time). This supports test-environment contention as the timeout explanation, but is
not a production load benchmark. The timeout run remains recorded. A green regression
run alone does not mean every UI/audio scenario is covered.

The Jev mismatches are latency-bin prediction for `memory` (the memory skill was
correctly selected), and `greeting` versus `direct` for `discord`. These do not prove
memory read failure or Discord integration failure. The proposal mismatch is
`prior-failed-dialogue`: a capability question was classified as `propose` rather than
`clarify`. The generated proposal was never applied or dispatched. The test's substring
checks are an evaluation approximation, not a complete natural-language safety proof.

### Suite audit details

`services/api/tests/voiceSuiteContextAudit.ts` uses an in-memory API kernel and fake,
read-only note/task adapters. All seven cases inspected the actual constructed voice
prompt. Two definition questions also generated real model answers in live mode.

| Probe | Live route/read observation |
| --- | --- |
| Latin names, role question | Both internal skills selected; both readers called; no explicit definition block |
| Japanese names, role question | No internal skill; no reader; reply asked which game/product was meant |
| Japanese Aether name, design lookup | Jev selected notes; note reader called |
| Japanese Voyager name, schedule lookup | Jev selected tasks; downstream reader **not** called |
| Japanese Aether name + `ノート` | Note reader called |
| Japanese Voyager name + `タスク` | Task reader called |
| Japanese names + latest development status | Only web selected; no internal reader |

A role-definition question may legitimately need no private-data skill. The failure
for that question is absent grounding/wrong identity, not absence of a private read.
Lookups separately check required skills and actual reader invocation. Definition
checks are bounded string probes and should be supplemented by semantic answer checks
when fixing this path. Exit code 1 currently signals the detected product-contract
failure, not an inability to run the audit.

## Scenario coverage and remaining checks

| Scenario | Executed safely by the agent | Not established by those tests |
| --- | --- | --- |
| Greeting, acknowledge/no response, ordinary chat, emotion/delivery, multiple skills | Jev live classifier plus `voiceDecision` and API fixtures | Actual voice naturalness, emotional performance, end-to-end audible latency |
| Registered vocabulary and context-sensitive recognition | `voiceTranscription`, `voiceTranscriptContext`, transcript-assembler/client tests; suite alias audit | Acoustic accuracy against original audio; noisy room, accents, Bluetooth microphones |
| Additional conditions, correction, barge-in | Pending-turn ledger, orchestration, stream reader, delivery and playback-callback tests | Real microphone echo cancellation and timing under overlapping speech |
| Completed answer versus partial speech/error carryover | Complete/partial/invalid response tests, stale batch and callback tests | Device audio output failures and provider/network failures on a live call |
| Repeated interruptions/recovery | New deterministic 1,000-cycle test of request/correction, completion, stale acknowledgements, late callbacks | A 10–15-minute live audio/network endurance test; this is state-machine repetition, not real-time acoustic endurance |
| Implementation request, additions, task approval/progress/failure | Live proposal classification; kernel/orchestration/agent-store/bridge fixtures and Swift task models | Starting a real Codex job, changing a repository, deploying, or completing a production Voyager task |
| Text chat, histories, threads, failed send/retry, cache reconciliation, Markdown | API and Swift conversation/model tests | Every production screen operation or restart on a physical phone |
| Aether/Voyager read/write review | Bounded read and organize/proposal fixtures; new live routing audit | Production note/task writes or full content synchronization; the live alias failure is unresolved |
| Memory, forget/correct/privacy, guest isolation | Memory extraction live; transparency/trust/restart and guest fixtures | Real friends' speech identification; no owner history was shared for live evaluation |
| Photo/camera conversation | Vision and protocol fixtures; photo-menu/picker smoke below | Capturing a real photo, camera permission flow, uploading user photos |
| Settings, pairing, voice choice, route changes, delivery projections | Swift models and API fixtures | TestFlight install, all appearance/accessibility/Bluetooth settings on the physical device |
| Discord/Minebot | Classifier/bridge fixtures only | Sending to a real channel or issuing a live Minecraft command; neither was done |

### UI smoke provenance and limits

Used the dedicated `Shannon Visual Audit` Simulator (iOS 26.5), with the already
installed Debug app launched with `-ShannonDesignPreview`. Its bundle reports version
0.1.0 / Build 55, not the distributed Build 92. This run does not establish binary-to-
source identity or serve as a smoke gate for Build 92. No new app was built/installed.

Verified by returned UI state/screenshots: ordinary conversation displays, voice sheet
opens/closes, microphone menu opens, participant menu opens with its privacy warning,
photo menu opens, library picker loads, cancelling returns without sharing a photo,
and the composer accessibility value accepts two lines of synthetic draft text.
Participant/input settings were not changed. A full keyboard-layout check was not
completed; setting an accessibility value is not equivalent to typing through the
keyboard. The unpaired Simulator voice sheet reports a connection error; this does
not establish the cause of the user's paired-phone connection incident.

The tool initially timed out/returned incomplete accessibility snapshots; later
Device Hub access by its installed full path worked. UI testing then stopped when
the Mac locked. Sidebar/work/memory/settings navigation and remaining current-build
UI/audio checks are **unverified**, not failed or passed. Do not infer an app defect
from this automation/environment blocker.
The dedicated Simulator was shut down and its temporary resource claim released
after the UI run stopped; no shared signing/device/ASC lane was taken.

## Separate request-budget finding

Resolved after this audit by `5d6e9cf` (see the status table above). The original
observation is retained for provenance: at the baseline, `services/api/src/server.ts` shared one `deviceVoiceUsage` map, maximum 10 requests
per minute, among session creation, delegation and speech routes. Each sentence
speech request consumed the same allowance. The baseline audit called the actual
`consumeDeviceAllowance` function with synthetic in-memory request counts: one
session plus two delegation requests plus eight sentence-TTS requests totals 11,
and the final request was rejected. Route code converts rejection to HTTP 429.

This was a confirmed request-accounting risk, **not** proof that a particular live
connection failure or audio gap was caused by rate limiting. Permanent correction
should keep abuse/cost/concurrency protection while distinguishing turn/session
admission from sentence requests; do not remove streaming or disable protections
as a supposed fix. Obtain content-free status/stage/request evidence before tying
an incident to this risk.

## Repeat the investigation safely

```sh
scripts/verify.sh api
scripts/verify.sh cognition-eval
scripts/verify.sh ios
scripts/verify.sh release-runner
node node_modules/vitest/vitest.mjs run services/api/tests --maxWorkers=1
SHANNON_AUDIT_BASELINE="$(git rev-parse HEAD)" \
  node --import tsx services/api/tests/voiceSuiteContextAudit.ts
```

Use the repository's bundled Node fallback when needed; SQLite audits require a
runtime with `node:sqlite`. Azure's system Node v20 lacks that module, while the
API runtime at `/home/azureuser/shannon-ios-runtime/bin/node` supports it.

Live opt-in: `SHANNON_AUDIT_LIVE=1`, with credentials deliberately supplied on the
server. The suite audit makes seven Jev calls and two billable answer-model calls,
uses synthetic scope/history/adapters and suppresses web tools. It opens no production
database and performs no external writes. Existing live helpers similarly evaluated
synthetic inputs only. Keys stayed in Azure's existing protected environment file
and process memory; do not copy them into this repository or reports. Do not print
the complete environment or actual conversation transcripts.

## Fix acceptance and reusable knowledge

No product fix has been made in this investigation. Required follow-up acceptance:

- Every relevant response/router receives a small, stable product-role dictionary,
  independent of optional/private memory skills; role questions need no private read.
- Latin and Japanese aliases share a maintained entity contract across selection,
  mandatory fallback, downstream readers and query construction, while retaining the
  original transcript for confidence/authority handling.
- Internal task/development freshness is not automatically treated as public web
  freshness; external search remains available when genuinely needed.
- Empty/unavailable internal data produces an honest bounded explanation, not an
  invented read, unrelated product search, or implicit task execution.
- Add dictionary/alias/current-status cases to deterministic and live evaluation;
  rerun owner/guest isolation and explicit-action approval tests.
- Validate request-budget changes against several sentence lengths and repeated
  turns without weakening the existing protections.

`TI-KNOWLEDGE-SHANNON-SUITE-IDENTITY`: Prompt slimming must preserve stable product
identity and ownership boundaries. Skill selection and downstream capability gates
need the same alias contract; a correct classifier score alone does not prove that
the capability ran. Generalize only after another app verifies the proposed contract.
This item is returned as a focused candidate; shared product policy was not changed.
