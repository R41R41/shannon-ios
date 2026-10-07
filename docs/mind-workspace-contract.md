# Mind workspace contract (v1, Syzygy ADR-0008 stage 3)

知覚・注意・共有の場・記憶の書き手・人の事実. Stage 3 of Syzygy ADR-0008 gives the mind the parts it has had only as names: every surface hands what it perceived to the mind as one event, attention orders those events, a shared place (the workspace) holds what a turn should know of the moment, one writer applies every memory proposal, people facts carry the time they were true, and the replay summary becomes a template rendered by code. This file is the contract; the plan and the owner's answers are in the Syzygy hub (`notes/adr0008-stage3-plan.md` until stage 3 ships, then ADR-0008 §15).

**Nothing of stage 3 is deployed until the owner has approved it** (ADR-0002 core: response path, memory, the gate, deployment). The pure parts are in `packages/mind` (`@shannon/mind`); the service side in `services/api/src/mind/perception/`, `mind/attention/`, `mind/workspace/`, `mind/memory/` and `services/api/src/wiring/`. Core areas: `autonomyCore.ts`.

**Model weights are never trained.** Salience, the gate, decay and the identity tiers are fixed formulas over closed inputs; no model learns from her outcomes (`AGENTS.md`, product invariants).

## Status

| Step | Content | State |
| --- | --- | --- |
| 0 | This contract, the switches, the core map, `packages/mind`, the switched-off proof recorded on afb38c28 | in place (`packages/mind/src/switches.ts`; tests `switches.test.ts`, `autonomyCore.test.ts`, `stage3SwitchedOff.test.ts`) |
| F1 | Pure `packages/mind`: envelope, salience, proactive gate, MinHash and topics, evidence decay, identity tiers, temporal rules, compaction, trust fold | in place, not wired (`packages/mind/src/{envelope,salience,minhash,proactiveGate,evidenceDecay,identityTiers,temporalFacts,compaction,trustFold}.ts`; tests beside each; the perception and attention windows re-export them) |
| S1 | Ports of every part, the types-only rule, the baseline shrunk | in place: windows `memoryPorts` (extended), `disclosurePorts`, `emotionPorts`, `respondPorts`, `recallPorts`, `ownTimePorts`, `agentTasksPorts`, `selfPorts`, `sleepPorts`, `predictionPorts`, `toolsPorts`, `selectorsPorts` and `inhibitionPorts` (extended); rule `ports-types-only-from-stores`; the baseline 287 → 175 (see "Structure") |
| F5 | The memory outbox, its codec and the one writer; the phase-3a writers propose | in place, behind `SHANNON_MEMORY_OUTBOX` (`mind/memory/{memoryOpCodec,memoryOps,memoryWriter}.ts`, `mind/memory/store/memoryOutboxStore.ts`, `wiring/memoryOutboxWiring.ts`; tests `outboxCodec`, `memoryWriterReplay`, `memoryWriterContention`, `memoryOutboxWriters`, `memScenarios` (`mem.cas-forget`), `stage3MemoryOutbox`) |
| S2, F2, F7 | sqlite splits; perception and the audience matrix; compaction | not yet |
| F3, F4, F6 | the workspace host; the proactive gate at the delivery points; people facts, tiers, decay, the trust ledger | not yet |
| S3, F8 | surface decisions out of the surfaces; suite v3, latency, review, owner preview, deployment | not yet |

## Owner answers (2026-10-07, ADR-0008 §15)

1. **Where the mind runs:** inside the API process in stage 3, behind a `MindHost` interface (`mind/workspace/workspacePorts.ts`) built from the start so that it can move to another process; it moves to `mindWorker.ts` with the action threads in stage 4.
2. **Proactive spacing stays at 5 minutes.** The 15-minute gap of the plan is not adopted. Added on top: the same intent is not repeated within 30 minutes; intents expire after 30, 75 or 150 minutes by reason; topic reuse is damped (blocked for 5 hours, then a half-life of 3 days, blocked at a similarity of 0.9 or more). The existing 10-minute owner-active hold stays. Every hold is a withheld fact she can see.
3. **Identity tiers 3 and 4 only suggest; the owner merges.** The owner is pinned and is never matched by tiers 2 to 4.
4. **Two-clock decay** (support half-life 30 days, contra 180 days) replaces the fading and retirement of impressions. The owner sees a dry-run of what changes **before** the switch is turned on. The recurrence rule stays; facts about the owner are excluded.
5. **Coordinator decisions:** a surface's store may import `infra/sqlite` (a clarification of the layer rules); the replay summary is at most 900 characters for text and 400 for voice.

## Switches

All default on, except `SHANNON_EVIDENCE_DECAY` (off unless `on`, `true`, `1` or `yes`, until the owner has seen the dry-run). `off`, `false`, `0`, `disabled`, `no` or `none` switches one off. **`SHANNON_ADR8_STAGE3=off` restores afb38c28 byte for byte**: every provider and Jev request, every prompt and every state as it was (proof below). A restart applies a change. The implications are in one place, `mindSwitches` (`packages/mind/src/switches.ts`).

| Switch | Off gives | Core area |
| --- | --- | --- |
| `SHANNON_ADR8_STAGE3` | all of the below off | — |
| `SHANNON_MIND_EVENTS` | no event is perceived; implies attention and the workspace off | response path |
| `SHANNON_ATTENTION` | nothing is ordered or held in mind; implies the workspace off | response path |
| `SHANNON_WORKSPACE` | no `[いまの場]`, no notices: the prompt is afb38c28's | response path |
| `SHANNON_DATA_FRAMES` | untrusted text reaches a prompt as it did | response path, guard |
| `SHANNON_PROACTIVE_GATE` | her messages are held only by today's spacing and owner-active hold | guard |
| `SHANNON_MEMORY_OUTBOX` | every writer writes where it did; implies the temporal facts off | memory |
| `SHANNON_TEMPORAL_FACTS` | people facts without validity; a contradiction is not closed | memory |
| `SHANNON_EVIDENCE_DECAY` | (default) impressions fade and retire as they do | memory |
| `SHANNON_IDENTITY_TIERS` | identity by exact name, alias or link only, as today | memory |
| `SHANNON_TRUST_LEDGER` | no trust rows | memory |
| `SHANNON_STRUCTURED_COMPACTION` | the 600-character replay summary as it is | memory, response path |

The switches of stages 1 and 2 (`docs/cognition-ledger-contract.md`, `docs/skill-and-routing-contract.md`) are independent of these.

## The event (`mind.event.v1`)

`packages/mind/src/envelope.ts`. One closed shape for everything a surface perceived:

- `kind` (closed: utterance, touch, presence, game, platform message, task outcome, promise due, own-time step, notice), `surface` (text, voice, body, minecraft, platform, outreach, own time), `body` (which body, when one).
- `audience`: the existing `MemoryAudience`, **copied** from the surface's own decision, never recomputed (`perceptionAudienceMatrix.test.ts` holds deep equality with the legacy paths). `presence { openOnly, othersMayHear }`.
- `speaker { kind, personId, verified, tier }`, `people`, `time`.
- `salienceInputs` (closed numbers), `provenance { source, sourceId, trust, episodeIds }`.
- `content`: text kept in memory only, or a reference that is re-read through `MemoryWithholding` and `DisclosureGate` when rendered, so a forget applies also after a restart.

One normalizer per surface lives in `mind/perception/`. Other processes (the worker, her own time) write closed-field rows into `mind_inbox`, tailed every 2 seconds and at the start of a turn; her own time is handed one function, `emitMindEvent`, and nothing else of the mind.

## Attention (`SALIENCE_V1`)

`packages/mind/src/salience.ts`. Salience is a noisy-OR, s₀ = 1 − Π(1 − wᵢxᵢ), xᵢ ∈ [0, 1]:

| Input | Weight |
| --- | --- |
| Verified owner speech | 0.9 |
| Her name called, or addressed to her | 0.8 |
| Touch (press 1, hover 0.5) | 0.7 |
| Promise due: exp(−\|Δmin\|/10) within ±30 minutes | 0.8 |
| Prediction error: min(1, \|δ\|/2σ) | 0.6 |
| Her own task's outcome | 0.5 |
| Others' speech (×2 when addressed, capped at 1) | 0.3 |
| Novelty: 1 − the highest trigram similarity over 30 minutes | 0.4 |

It decays as s(t) = s₀·exp(−Δt/τ) with τ = 10 minutes for ambient items and 60 minutes for promise and task items. An item enters at s ≥ 0.5; at most K = 12 are held and the lowest is evicted to a summary queue rendered as one `[ほか]` line and flushed at sleep. **Attention orders; it never silences.** `voiceSilence` stays the only silencer.

## The proactive gate

`packages/mind/src/proactiveGate.ts`, enforced at the delivery points (`reachOuts.say`, `sayAgain`, `sayByPhone`, the initiative insert, `incomingCallRequests`). In order:

1. **Owner active** (`owner_active`): held while the owner wrote or spoke within max(2 minutes, the existing 10 minutes).
2. **Spacing** stays today's 5 minutes, under today's code; there is no new spacing code.
3. **Intent repeat** (`intent_repeat`): the same intent (reason and subject) not again within 30 minutes.
4. **Intent expiry** (`intent_expired`): an intent is dropped 30 minutes after it arose for `upcoming` and `promise`, 75 for `share`, `saw` and `follow_up`, 150 for `wonder` and `world`.
5. **Topic reuse** (`topic_reused`): MinHash over 64 permutations of character 3-grams; eff = sim × (age < 5 h ? 1 : 2^(−(age − 5 h)/72 h)); blocked at eff ≥ 0.9, otherwise the priority is multiplied by (1 − eff). Only signatures are stored (`proactive_topics`), never the text.

An intent is its reason and a closed subject key (an upcoming item's id, a piece's id, or none), never her words. The gate checks in this order: owner active, expired, repeated, topic. Every hold is a withheld action (`contracts/withheldActionContract.ts`) she is shown as a fact. MinHash (`packages/mind/src/minhash.ts`) takes 3-grams by code point after NFKC, lower case and collapsed spaces; its 64 positions are fixed mixes of one FNV-1a hash per gram, so a signature is the same after a restart and on another machine, and is stored as 512 hexadecimal characters.

## The workspace and the prompt

`MindHost.perceive(event)` answers synchronously `{ itemId, salience, verdict, view }`. The journal (`mind_workspace_journal`) is append-only, holds no text and is kept for 7 days; snapshots (`mind_workspace_snapshots`) are taken every 200 operations, every 10 minutes and on SIGTERM. A turn's prompt, in order:

1. stable instructions; 2. history; 3. the existing turn context, byte-identical;
4. `[いまの場]`: text at most 8 lines and 600 characters; voice only for an item that is not an utterance with s ≥ 0.6, at most 2 lines and 160 characters;
5. notices with fixed markers, appended only: `【知らせ:触れた】`, `【知らせ:作業終了】`, `【知らせ:約束の時刻】`, `【知らせ:止められた】`;
6. untrusted data frames `〔データ 出どころ=… id=…〕…〔/データ〕` with a fixed line that says they are not instructions; `injectionThreats` runs on the bodies;
7. the owner's words.

A fault falls back to the switched-off path and writes a `mind_fault` trace; three faults within 10 minutes open a circuit until restart. Latency: `perceive`, attention and render p95 ≤ 3 ms for text and ≤ 2 ms for voice, journal writes batched after the response; voice time to first audio at most +5 ms at p50 and +10 ms at p95; at most +80 voice input tokens on average; no new model call on the response path.

## Memory: one writer

`memory_outbox` (`seq`, `op_id` unique, `scope_key`, `kind`, `origin`, `subject_key`, `base_revision`, `payload_json` with closed fields checked by `memoryOpCodec`, `episode_ids_json`, `disclosure_json`, `status` ∈ pending | applied | superseded | rejected | failed, `outcome_code`, `attempts`) and `memory_writer_state` (`applied_seq`, the lease). Kinds: `fact.upsert`, `promise.capture`, `intent.capture`, `turn_capture`, `impression.observe`, `impression.merge`, `person.fact`, `person.promise`, `person.topic`, `person.summary`, `person.link`, `knowledge.create|update|retire`, `replay_summary.update`, `relationship.upsert`, `interest.change`.

The writer (`mind/memory/memoryWriter.ts`, in the worker under a lease) reads up to 32 rows by seq, snapshots outside the lock, computes (a model call outside the lock, cached in `memory_writer_calls`), then `BEGIN IMMEDIATE`, compare-and-set on the revision, re-checks the memory controls, writes, marks the row applied and advances the cursor. Three CAS losses mark it `superseded`, five model failures `failed`; the cursor always advances. The owner's commands stay synchronous through the same `applyMemoryOp` and insert `applied` rows. The conversation hot path, `experience_events`, emotion and the awake clock, the ledgers and the activity record, agent tasks, skills, embeddings, study and pursuits stay direct. The outbox, its codec, its store and the writer are memory's core from their first file.

As built (F5):
- **The codec** (`memoryOpCodec.ts`): `encode` keeps only the fields a kind names, `decode` refuses any other; every text is bounded and refused when `looksSecret` or `injectionThreats` finds something. A refused proposal is kept as `rejected` with its closed code and the payload `{}` (never the text).
- **Revisions** (`memoryOps.ts`, `subjectRevision`): a short digest of what the op would change and the owner's controls on it (a fact and its control; a person's impressions and the controls on them; a call's items and its people; a knowledge note's version and status; a thread's summary row). `base_revision` is what the proposer saw (knowledge: the note's version); a mismatch counts as one lost compare-and-set and the op is tried from a new snapshot.
- **The owner's controls again, under the lock**: an episode the op came from that he forgot, a forgotten fact, relationship, interest or promise, a forgotten person or item, a discarded call (「今回は残さない」), a summary a forget now withholds: the op is `superseded` with `forgotten` or `discarded`.
- **Ordering**: rows of one subject are applied in seq order; a row waiting for a model retry (after attempts × 30 s) holds back the later rows of its subject only; the cursor stays before it and moves over every final row after it once it ends.
- **Where it runs**: the API process proposes (people memory saves, the platform's people, Minecraft) and runs the owner's commands (people rename and merge, `person.link`) on its store's connection; the worker proposes (a turn's refinement, sleep, knowledge, impressions, the platform summaries, the replay summary) and runs the writer between jobs on its own connection; the people store can share that connection so the lock covers every write of an op. The local kernel drains an in-process writer after each proposal.
- **The phase-3a writers**: a turn's refinement proposes `fact.upsert`, `relationship.upsert`, `interest.change`, `promise.capture`, `intent.capture` and `turn_capture` (emotion, the recalled memories and shared time stay direct); sleep proposes its facts, relationships and interests inside its job's transaction and the writer writes the profile again after each; knowledge proposes `knowledge.create|update|retire` (op id from the operation's digest); impressions propose the model's analysis (`impression.observe`) and the writer applies it to the rows as they are then; people memory proposes a call's period (`person.summary`, replacing), topics, facts and promises; the platform proposes an exchange with the period's summary, facts and promises, and a written summary; the replay summary proposes `replay_summary.update` and the writer makes the model calls (`ConversationReplaySummarizer.planned`). `impression.merge` is a closed kind with its write path and no proposer yet.
- **Proof**: with the outbox built from the environment (`stage3MemoryHook`), `SHANNON_ADR8_STAGE3=off` and `SHANNON_MEMORY_OUTBOX=off` keep every digest of afb38c28; switched on, every provider and Jev request and every answer and prompt of the thirteen scenarios is still afb38c28's (only the state shows the outbox).
- **Lock waits** are measured on the outbox's connection (`LockWaitMeter('memory writer')`, one line a day). In `memoryWriterContention` (five processes proposing and writing at once on one file) no process saw SQLITE_BUSY; p99 per process stayed under about 120 ms there.

## People facts

- **Temporal rows** (`packages/mind/src/temporalFacts.ts`; a fact holds at t when it is not expired by t and t is inside [`valid_at`, `invalid_at`); when the contradicting fact tells of an earlier time than the row it contradicts, the new fact is the one closed, at the row's `valid_at`; at most 32 episodes are kept per fact): `person_memory_items` gains `valid_at`, `invalid_at`, `expired_at`, `episode_ids_json`, `fact_revision` (additive, with a backfill); impressions gain the same in `data_json`. Recall leaves out invalid and expired rows. A contradicted row gets `invalid_at = new.valid_at` and `expired_at = now`; it is never deleted. A duplicate appends its episode and changes no text.
- **Identity tiers** (`packages/mind/src/identityTiers.ts`): (1) the exact normalized name, alias or platform link, automatic; (2) the entropy gate (below 1.5 bits per character, or fewer than 6 Latin characters, stops fuzzy matching; CJK fails closed to tier 4); (3) MinHash Jaccard ≥ 0.9; (4) a choice over at most 15 candidates (cosine ≥ 0.6) plus "new person", in the 0.9/0.1 band, in the background only. Tiers 3 and 4 only suggest (`person_identity_candidates` → `mergeSuggestions`). Tier 4 asks one probability per candidate and one for "new person": exactly one candidate at ≥ 0.9 is suggested; "new person" at ≥ 0.9, or every candidate at ≤ 0.1, is new; anything else is left to the rules. Two people with the same exact key are not joined to either. The owner is pinned by the device token, the online-mode uuid and the platform owner id, and is matched only by those pins: never by a name or an alias at any tier, and never on a tier-4 menu.
- **Evidence decay** (`packages/mind/src/evidenceDecay.ts`): net = Σ support·2^(−Δt/30 d) − Σ contra·2^(−Δt/180 d); weights: the owner confirmed +1 (support) or denied 1 (contra), an indirect support in a turn +0.5, ignored 0.2 (contra). The run below 0 is found exactly: between two pieces of evidence the net crosses 0 at most once (support fades faster), at t = log₂(S/C)/(1/30 d − 1/180 d). `decayTransitions` lists for the dry-run every item whose handling would change (today's active, faded or retired against the new status). Net ≥ 1 is usable, ≥ 2 promoted, ≤ −2 a retirement candidate; below 0 for 14 days, put away. Off until the owner has seen the dry-run.
- **Trust** (structure only): `shannon_trust_ledger` with closed kinds (`promise_kept`, `promise_broken`, `owner_confirmed`, `owner_corrected`), settled once per conversation. Its parameters are unset, so the fold answers null and nothing reaches a prompt; setting them is an owner approval.

## Compaction

The replay summary becomes a JSON template (`packages/mind/src/compaction.ts`) with 目的・制約・済み・途中・詰まり・決めたこと・次・重要な文脈, each at most 5 items of 80 characters, rendered by code: at most 900 characters for text, and 目的・途中・次・重要な文脈 in at most 400 for voice. It renders as `[ここまでの要約]` and one line per section (`目的: …／…`); when it is too long, items leave in the order 済み, 制約, 詰まり, 決めたこと, 重要な文脈, 途中, 次, 目的, the oldest of a section first. It is updated incrementally (a section the summarizer names replaces the previous one, the others stay); a tool call and its result are never split, and the oldest tool outputs are replaced by a fixed line first. `covers_from_id`/`covers_to_id` let recall open the raw range. The summarizer stays luna.

## Structure (S1)

Every part of the mind has a window (`<part>Ports.ts`), and the other parts and the integrations import a part through it (`mind-via-ports`, `integrations-outside-mind`). A window re-exports only types from a `store/` folder (`ports-types-only-from-stores`, read from the syntax: `export type`, `import type`, or every name marked `type`); a store is handed by wiring. The disclosure gate, the conversation's secrets, what Aether text may be shown to others and who is present for a tool are `disclosurePorts.ts`, apart from `inhibitionPorts.ts`, because her own time must not open them.

The move was mechanical and changed no behaviour: an import was routed through a window only when (1) no process loads a module it did not load before (the run-time import closure of every entry file is the same, the windows aside), (2) no window joins an import cycle and no two modules join one cycle that were apart, and (3) the importer is not a module of her loop or the reader of the owner's context, whose imports are pinned (`autonomyLoopPrivacy.test.ts`; her other modules use `selfPorts`, `agentTasksPorts` and types of `inhibitionPorts`). What stays in the baseline (175 entries: `mind-via-ports` 67, `surfaces-without-stores` 52, `surfaces-apart` 37, `sqlite-in-stores` 15, `own-time-without-private-stores` 3, `integrations-outside-mind` 1) is a value from a store (S2 splits those), an import whose window would load more or close a cycle (S2 and S3 split those parts), her own time's pinned imports (stage 4), and the surfaces (S3).

## Privacy

- Her own time is handed `emitMindEvent` and nothing else of the mind. The rule `own-time-without-private-stores` (`scripts/api-layers.json`) forbids it the memory part (the outbox and the writer among it), `disclosurePorts`, perception and the workspace; `autonomyLoopPrivacy.test.ts` and the kill-switch digests hold.
- The journal, the inbox, the topics table and the trust ledger hold closed symbols, ids, numbers and signatures, never a word of the owner's.
- What the owner asked to forget is gone from a rendered workspace at once, because text is re-read through the withholding and the disclosure gate when rendered.

## The switched-off proof

`services/api/tests/stage3SwitchedOff.test.ts` digests, for text, voice, body touch, platform, Minecraft and her own reach-out, every provider and Jev request, every prompt the model was given and the state each scenario leaves (`tests/support/stage3Scenarios.ts`). The digests (`tests/fixtures/stage3-switched-off-v1.json`) were recorded on afb38c28 itself, in a detached work tree, and are never regenerated for a stage-3 change: `SHANNON_WRITE_STAGE3_OFF=1` writes the file only where it does not exist. Every later step runs the proof with `SHANNON_ADR8_STAGE3=off` and with each switch off alone.
