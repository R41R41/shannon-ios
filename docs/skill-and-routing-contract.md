# Skill and routing contract (v1, Syzygy ADR-0008 stage 2)

スキル記憶・難易度推定とモデルの段・Jev による道具の選択・木をたどる想起. Syzygy ADR-0008 (accepted 2026-10-07) puts Jev in front of the choices a turn makes: which tools the model is given, how hard the turn is and which model answers it, and (later in this stage) which headings recall walks. Stage 2 also gives her a procedural memory (skills). This file is the contract; the plan and the owner's answers are in the Syzygy hub (`notes/adr0008-stage2-plan.md`, until stage 2 ships).

**Nothing of stage 2 is deployed until the owner has approved it** (ADR-0002 core: response path, memory, the gate, deployment). The pure parts are in `packages/learning` (`@shannon/learning`); the service side in `services/api/src/mind/selectors/`, `services/api/src/mind/tools/`, `services/api/src/infra/models/jev/` and `services/api/src/wiring/`. Core areas: `autonomyCore.ts`.

**Model weights are never trained.** The competence table and the value table change which choice looks good from outcomes; the models stay fixed (`AGENTS.md`, product invariants).

## Status

| Step | Content | State |
| --- | --- | --- |
| 1 | This contract, the switches, the core map, the trace vocabulary, the registry's one-line summaries, the switched-off proof | in place (`packages/learning/src/switches.ts`; tests `switches.test.ts`, `shannonTools.test.ts`, `autonomyCore.test.ts`, `stage2SwitchedOff.test.ts`) |
| 2 | The Jev choice client, the tool menu and `tool_open`, text wiring, the parallel voice call | in place (`infra/models/jev/jevChoice.ts`, `mind/selectors/{toolMenu,turnChoices}.ts`, `mind/tools/shannonToolMenu.ts`, `wiring/skillRoutingWiring.ts`; tests `toolMenu.test.ts`, `stage2SwitchedOff.test.ts`) |
| 3 | Notion, Voyager tasks, the schedule and place search as gated registry tools; web as a capability entry | not yet |
| 4 | Difficulty, the tier policy, `luna_plus`, the turn verifier, tier choices, the competence table, conversation choices in reward (I-3) | not yet |
| 5 | The Anthropic adapter (`@anthropic-ai/sdk`, I-6), `TieredChatModel`, the `tier.*` scenario set | not yet (inert until the key and the switch) |
| 6–7 | Skill memory and its copies in Aether | not yet (another branch) |
| 8 | Tree recall | not yet (another branch) |
| 9 | Scenario suite v2, shown to the owner, deployment | not yet |

## Owner answers (2026-10-07)

- **Plan approved; deploy after an independent review.** Turning on Sonnet routing is separate (I-1).
- **Stage-1 safeguards unchanged:** the warm-up (n ≥ 3) and the hourly cap (0.15) of the reward mood.
- **I-1 / I-2 「声も含めて」.** Sonnet may serve text and voice turns when the difficulty is high, once the owner has placed the Anthropic key, and only with `SHANNON_SONNET_ROUTING=on`, which the coordinator turns on after the `tier.*` scenario set and a voice-latency check. Voice falls back to luna when Sonnet's first token would miss the voice deadline.
- **I-3 「報酬にも入れる」 (overrides the recommendation and stage 1's rule that a conversation's tool calls are data only).** Outcomes of conversation choices (her tool calls and her tier choices in a chat) go into reward, mood and the value table like her own-time choices, under the same warm-up and hourly cap. The per-(tier, task kind) competence table is still kept, for routing. Value facts may include cells learned in conversations; they stay facts and are never shown with others present.
- **I-4 / I-5 「全部置く」.** Every skill gets a readable copy in Aether's シャノン用フォルダ. What the owner called 内緒 is never written into a skill (the check runs when the body is built). An owner's edit to a copy is adopted at the next sleep; she never overwrites an edited copy.
- **I-6:** `@anthropic-ai/sdk` is added (step 5).
- **I-7:** in tree recall Jev sees heading paths and previews of up to 200 characters, and the owner's documents only in owner-alone turns.

## Switches

All default on, except `SHANNON_SONNET_ROUTING` (off unless `on`, `true`, `1` or `yes`). `off`, `false`, `0`, `disabled`, `no` or `none` switches one off. **`SHANNON_ADR8_STAGE2=off` restores ca7cf519 byte for byte**: no Jev call beyond the voice router's, no table, every request, prompt, reply and state as it was (proof below). A restart applies a change. The implications are in one place, `skillRoutingSwitches` (`packages/learning/src/switches.ts`).

| Switch | Off gives | Core area |
| --- | --- | --- |
| `SHANNON_ADR8_STAGE2` | all of the below off | — |
| `SHANNON_TOOL_MENU` | every offered schema goes to the model, as before | response path |
| `SHANNON_READ_TOOLS` | Notion, tasks, the schedule and places only as today's projections | guard, response path |
| `SHANNON_DIFFICULTY` | no difficulty questions, every turn on luna as before; implies the luna checker and Sonnet routing off | response path |
| `SHANNON_TURN_VERIFY` | no turn verifier | response path |
| `SHANNON_SKILLS` | no skill memory; implies the export off | memory |
| `SHANNON_SKILL_EXPORT` | skills stay in the database only | memory |
| `SHANNON_TREE_RECALL` | recall as before (luna's `selectSections`) | memory, response path |
| `SHANNON_SONNET_ROUTING` | (default) `sonnet` is served as `luna_plus`; nothing leaves for Anthropic | response path |

The stage-1 switches (`docs/cognition-ledger-contract.md`) are independent of these.

## The registry's summaries

Every tool of the registry (`shannonTools.ts`) has a summary (`TOOL_SUMMARIES`, `toolSummary`): one line of at most 60 characters, in her words, that tells it apart from the others (`shannonTools.test.ts`). It is what Jev's menu chooses from and what the model reads of a tool whose schema it was not given. It is kept beside the registry, not in a definition, so nothing that carries a definition (a provider request, a turn's session, a test's trace) changes with it.

## The Jev client (step 2)

`infra/models/jev/jevChoice.ts` is the one Jev client. `JevChoiceClient.ask` sends `{ model, state, questions }` with the headers, the timeout (900 ms unless `SHANNON_JEV_TIMEOUT_MS`) and the order of reading of the voice router, which now asks through it (its bytes are unchanged: the Jev digests of the switched-off proof). `JevChooser.decide` adds what the voice gateway has around its call: the caller's fallback on a timeout, a failure or an answer off the menu (never an exception), and one decision trace per call, the call counted by `countedJevFetch` (stage 1). One Jev call is one trace, so the usage summary's call count from the traces stays right.

## The tool menu (step 2, `SHANNON_TOOL_MENU`)

ADR-0008 §8 「道具は名前と短い説明だけを毎回渡し、使うときに定義を取り寄せる」.

- **What Jev is asked** (`mind/selectors/toolMenu.ts`): one `choice` question `tool` over the provider names of the tools the turn offers, each with its summary, plus `none`. At most 64 entries a menu; beyond 63 tools they are grouped by area (`tool__<area>__<part>`), all in the same call, and every group's answer that is not `none` is chosen. Jev's state is the turn's words (at most 2,000 characters; the voice router already reads them) and the surface: never a schema, a description, a tool result or anything the turn's audience would withhold. The candidates are exactly what `conversationTools` would offer (`toolMenuCandidates`, which opens nothing), so an audience with others present gets a menu of her Aether reading tools only.
- **When.** Text: in every turn that would offer tools (not a fixed command, an organizing turn, a forced web search or a place search), started before recall and awaited after the offer, so it runs in parallel with recall. Voice: only when the turn's words would offer tools, as a second Jev call started beside the router's (whose questions are unchanged); its answer is used only if the turn does offer tools in the end.
- **What the model gets** (`mind/tools/shannonToolMenu.ts`, `withToolMenu`): the schemas of the chosen tools (only those the turn offers) plus `tool_open(name)`, whose `name` is an enum of the tools the turn offers. Its instructions list every offered tool by provider name and summary (`[ボクの道具・献立]`); the capability lines (Aether, her Minecraft body) and the instruction lines follow every offered tool, not only the schemas sent. `tool_open` is answered by the session: it runs nothing, is not counted against the turn's six calls, takes no time and is not written to the activity record or the turn's trace; the opened tool's schema is in the request from the next round (`withToolRounds`). A call of an offered tool that was not opened is refused like a name the turn does not offer, and runs nothing. The offer, the audience, the gate and the runner are unchanged.
- **Fallback.** When Jev times out, fails or answers off the menu, the turn's session is not narrowed: every offered schema goes, as before.
- **Trace.** `tool_menu` with `tool` (the first chosen name, `none`, or `all` for the fallback), `chosen` (how many; −1 for the fallback), `offered`, `groups`.

## Decision traces

The trace vocabulary (`contracts/decisionTraceContract.ts`, table `shannon_decision_traces`, unchanged) gains the surface `text` and three decisions:

| Decision | What it is | Answers (closed values only) |
| --- | --- | --- |
| `tool_menu` | Jev's choice of the tools whose schemas a turn sends | the chosen tool's name (or `none`), how many were offered, how many groups |
| `difficulty` | Jev's difficulty questions and the tier the policy chose | `task_kind`, the three probabilities, the tier, whether it was mapped down, rethinks, verify |
| `recall_beam` | one beam search of tree recall (step 8) | depth, width, leaves scored, stop reason |

A trace never holds the owner's words, a tool's input or a heading's text. Jev's cost per call follows stage 1 (`SHANNON_JEV_USD_PER_CALL`, unset: unknown).

## The core map

`coreAreaForRepositoryPath` (`autonomyCore.ts`) takes a file listed by name before a directory that contains it, and a deeper directory before a shallower one. Whether a path is core never changes; only a file listed by name inside another area's directory changes area (`CORE_AREA_OVERRIDES` in `autonomyCore.test.ts`, which checks every tracked file against the rule before stage 2). Stage 2 uses it for `packages/learning/src/difficultyPolicy.ts`, which is the response path's, not emotion's, although `packages/learning/` is emotion's.

## Structural refactoring (ADR-0008 §10)

Each stage's exit criteria include structural refactoring. For stage 2: `process.env` is read only in `infra/config/serverEnvironment.ts`, `wiring/` and the entry files (every other module's default is `serverEnvironment()`, the live `process.env`, so nothing changed: `serverEnvironment.test.ts`), and a part of the mind reaches another through its window, `ports.ts` or `<component>Ports.ts` (`mind/inhibition/inhibitionPorts.ts`: the budget and the gate; not the disclosure gate or the secrets, which her own time must not open). The folder-rule baseline (`scripts/api-layers-baseline.json`) went from 364 to 287 entries; `environment-in-config` has none.

## The switched-off proof

`services/api/tests/stage2SwitchedOff.test.ts` runs twelve scenarios (text: tools offered, the schedule, tasks and Notion projections, a forced web search, others present, two turns, a tool round; voice: a greeting, tools, the schedule, a companion present) through the API kernel with the real OpenAI adapter and the real Jev voice gateway over a capturing fetch, and digests every provider and Jev request with random ids taken out. The digests (`tests/fixtures/stage2-switched-off-v1.json`) were recorded on ca7cf519 itself, before any stage-2 code, and are never regenerated for a stage-2 change. Every later step runs the scenarios with the stage-2 wiring built from `SHANNON_ADR8_STAGE2=off` and must send the same bytes, and no other Jev request.
