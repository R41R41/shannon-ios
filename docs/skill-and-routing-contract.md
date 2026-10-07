# Skill and routing contract (v1, Syzygy ADR-0008 stage 2)

スキル記憶・難易度推定とモデルの段・Jev による道具の選択・木をたどる想起. Syzygy ADR-0008 (accepted 2026-10-07) puts Jev in front of the choices a turn makes: which tools the model is given, how hard the turn is and which model answers it, and (later in this stage) which headings recall walks. Stage 2 also gives her a procedural memory (skills). This file is the contract; the plan and the owner's answers are in the Syzygy hub (`notes/adr0008-stage2-plan.md`, until stage 2 ships).

**Nothing of stage 2 is deployed until the owner has approved it** (ADR-0002 core: response path, memory, the gate, deployment). The pure parts are in `packages/learning` (`@shannon/learning`); the service side in `services/api/src/mind/selectors/`, `services/api/src/mind/tools/`, `services/api/src/infra/models/jev/` and `services/api/src/wiring/`. Core areas: `autonomyCore.ts`.

**Model weights are never trained.** The competence table and the value table change which choice looks good from outcomes; the models stay fixed (`AGENTS.md`, product invariants).

## Status

| Step | Content | State |
| --- | --- | --- |
| 1 | This contract, the switches, the core map, the trace vocabulary, the registry's one-line summaries, the switched-off proof | in place (`packages/learning/src/switches.ts`; tests `switches.test.ts`, `shannonTools.test.ts`, `autonomyCore.test.ts`, `stage2SwitchedOff.test.ts`) |
| 2 | The Jev choice client, the tool menu and `tool_open`, text wiring, the parallel voice call | in place (`infra/models/jev/jevChoice.ts`, `mind/selectors/{toolMenu,turnChoices}.ts`, `mind/tools/shannonToolMenu.ts`, `wiring/skillRoutingWiring.ts`; tests `toolMenu.test.ts`, `stage2SwitchedOff.test.ts`) |
| 3 | Notion, Voyager tasks, the schedule and place search as gated registry tools; web as a capability entry | in place (`mind/tools/shannonReadTools.ts`, `readToolPlan` in `conversationCapabilities.ts`, `textToolStart` and `settleTextTools` in `apiTextTurn.ts`, `readToolPorts` in `wiring/skillRoutingWiring.ts`; tests `readTools.test.ts`, `shannonCapabilityEvidence.test.ts`) |
| 4 | Difficulty, the tier policy, `luna_plus`, the turn verifier, tier choices, the competence table, conversation choices in reward (I-3) | in place (`packages/learning/src/difficultyPolicy.ts`, `mind/selectors/{turnChoices,turnVerifier,tierCompetence}.ts`, `mind/action/respond/turnRouting.ts`, `infra/models/turnChecker.ts`, `wiring/turnRoutingWiring.ts`; tests `difficultyPolicy.test.ts`, `turnRouting.test.ts`, `stage2SwitchedOff.test.ts`) |
| 5 | The Anthropic adapter (`@anthropic-ai/sdk`, I-6), `TieredChatModel`, the `tier.*` scenario set | in place, inert until the key and `SHANNON_SONNET_ROUTING=on` (`infra/models/anthropic/`, `infra/models/tieredChatModel.ts`, `wiring/sonnetWiring.ts`, `packages/evaluation/src/reach/tierSet.ts`, `tests/reach/reachTier.ts`; tests `anthropicTier.test.ts`, `reachTier.test.ts`) |
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
| `SHANNON_CONVERSATION_REWARD` | her conversation choices stay stage 1's data-only records (owner answer I-3 off) | emotion |

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

## Read tools (step 3, `SHANNON_READ_TOOLS`)

The read capabilities that were projections only also become registry tools (one registry, one gate, one record), each with its own gate domain:

| Tool | Domain | Reads (the same read as) | Cost |
| --- | --- | --- | --- |
| `notion.read(query)` | `notion_read` | the Notion projection (`notionTurnProjection`) for one search word | none |
| `voyager.tasks(query?)` | `voyager_read` | the Voyager task read (`conversationCapabilityPrompt`, keyword search) | none |
| `schedule.upcoming(range)` | `schedule_read` | the owner's upcoming items as he alone hears them (`OwnerUpcoming.promptFor`, 48 hours or 8 days) | none |
| `places.search(query, area?)` | `places_search` | the place skill (`runPlaceDiscoverySkill`, a model with web search; no device location) | model |

- **Who.** The registry lists them for the owner alone, text and voice, never her own time; the gate (`authorizeToolCall`) refuses anyone else. They exist only while the wiring hands the runner their ports (`ShannonToolRunner.useReads`, `readToolPorts`); without them every offer, name and refusal is what it was (a call of `notion_read` is a name that does not exist). The self-diagnosis lists them only while the switch is on.
- **Audience rules unchanged.** A turn offers them only where its own projection rules would read the same thing (`conversationTools` option `reads`, fail closed): text, the owner alone in the app (`readToolPlan` of his selection: Notion, tasks and the schedule as he alone hears them; places); voice, the owner alone (`ownerAloneReads`). With the owner alone the turn's context is byte for byte what it was (`readTools.test.ts`); only the tools and their capability line are added. With anyone else present (text marked `others`, a companion, 「友人も一緒」, a platform conversation) no read tool is offered and every projection, guarded marks included, is exactly what it was (`readTools.test.ts`, the audience matrix). Jev's menu never lists a read tool in such a turn, because it lists only what the turn offers.
- **In addition, never instead (coordinator, 2026-10-07).** Every projection of every turn is exactly what it was: Notion with its source links, tasks, the schedule, and places with the device's location (`placeLocation` still runs the place skill and forces the web search, with no function tools). The read tools are offered beside them, for a deeper or another read than the projection made; their descriptions say not to call one when the same read is already in the turn's context, so what today's projection answers needs no extra model round. Voice likewise keeps its projections and offers the tools in a turn that offers tools.
- **Web** is a capability entry of the menu (`WEB_CAPABILITY_ENTRY`, text only, beside her read tools), not a function tool: choosing it sets the turn's `useWebSearch` (the provider's own search; no function tools that turn, as before).
- **Capability line.** `SHANNON_READ_TOOLS_CAPABILITY` (`packages/cognition`, conditional like Aether's and the Minecraft body's) is added after the Notion line only to a turn that offers a read tool (`withToolCapabilityLines`); with the switch off the description is what it was.
- **Record.** Each call is written to the activity record by name and outcome only (`会話の中でNotionの共有ページを読みました。`), never the query or what was read; a failure is `unavailable` and retryable.

## Difficulty and tiers (step 4, `SHANNON_DIFFICULTY`)

- **Jev's questions** (`mind/selectors/turnChoices.ts`), in the same call as the menu: `task_kind` (closed: `chat`, `feelings`, `recall`, `lookup`, `write`, `plan`, `analysis`, `code`, `action`), `needs_strong_model`, `needs_verification`, `multi_step` (`noul`), and, in a turn of the owner alone that follows a reply of hers in the same Talk within ten minutes, `retry_or_correction` (`noul`; Jev reads that reply as `previous_reply`, never in a turn with anyone else present). Text: in every model turn, in parallel with recall. Voice: in every turn the router routes (not an overheard guest turn), as the second Jev call beside the router's, whose questions are unchanged. One call, one trace (`difficulty`, with the menu's answers when there was a menu).
- **The policy** (`packages/learning/src/difficultyPolicy.ts`, pure, core **response path**: listed by name in the core map, so not emotion's). Luna first. `sonnet` when p(strong) ≥ 0.65, or when luna's learned success for the kind is below 0.6 over at least five outcomes; luna with one escalation allowed when 0.35 ≤ p < 0.65; `luna_plus` for multi-step (≥ 0.65); `jev_only` for small talk (served by luna); luna otherwise and whenever Jev could not answer. `verify` when p(verification) ≥ 0.5; `rethinks` (0–2) is recorded for step 5. `sonnet` is served as `luna_plus` unless Sonnet is available (the key **and** `SHANNON_SONNET_ROUTING=on`; never in step 4: there is no Anthropic client yet). On voice (I-2) an available Sonnet serves only when the turn's time left covers its first-token latency plus 6 s (`sonnetFirstTokenMs`, step 5's measured-latency hook; an estimate of 2.5 s until then), else luna.
- **Serving** (`infra/models`): `luna_plus` is luna with reasoning one step up (text `none` → `low`; voice `none` → `low`, `low` → `medium`). A request without a tier is byte for byte what it was. **Escalation** (`ShannonTierRequest.escalation`, `withToolRounds` option `escalate`): once a turn, at a round boundary after a tool failed (not a refused name) or after a round with tools ran out of time, and only while no word of hers has gone out (a streamed text round that wrote is the answer; on voice not once anything was said, a waiting phrase included): every later round is `luna_plus`. The result says `escalated`.
- **The turn verifier** (`SHANNON_TURN_VERIFY`, `mind/selectors/turnVerifier.ts`): in a turn that offered her a write (and could write), a sentence that claims she wrote, saved, made or sent something of hers must be matched by a write that worked; else her text reply gets one fixed line in her voice (`WRITE_CLAIM_CORRECTION`). On text, when the policy asked for verification and at least 15 s are left, a luna checker in its own context (`infra/models/turnChecker.ts`; her reply and the closed results of her tools; usage lane `chat`) may flag what the pattern missed. On voice her words were already spoken: the verdict is learned, the reply is not amended.
- **The competence table** (`shannon_tier_outcomes`, `mind/selectors/tierCompetence.ts`): one row per routed turn (tier served, kind, surface, Talk, G), settled by the owner's next turn in the Talk (`tierOutcome`: G ≥ ⅔ and S ≥ ½) or after 30 minutes from G alone; competence is the Beta(1, 1) fold per (tier, kind). Read for routing only; never reward, mood or the value table. Created by the API process; kept 90 days.

## The Sonnet tier (step 5; owner answers I-1, I-2, I-6)

- **Inert by default.** `configuredSonnet` (`wiring/sonnetWiring.ts`) builds the adapter only with the key (`SHANNON_ANTHROPIC_API_KEY`, else `ANTHROPIC_API_KEY`) **and** `SHANNON_SONNET_ROUTING=on` (default off, read only as `on`/`true`/`1`/`yes`) **and** stage 2's difficulty on. Without it the kernel's chat model is luna itself, every request is what it was, and the policy serves `sonnet` as `luna_plus`. The coordinator turns the switch on in production after a live `tier.*` run.
- **The tiered model** (`infra/models/tieredChatModel.ts`): a request with `tier: 'sonnet'` goes to Sonnet; every other request goes to luna unchanged. A Sonnet failure or refusal before any word went out and before any tool ran is answered by plain luna (no tier, no escalation), with one content-free log line; the caller's cancellation is not retried. After a tool ran or a word went out, a failure ends the turn with her fixed out-of-time line, as on luna, so no write runs twice.
- **The adapter** (`infra/models/anthropic/`, `@anthropic-ai/sdk` 0.131.0, model `SHANNON_SONNET_MODEL`, default `claude-sonnet-5-5`):
  - *Prompt.* Built from luna's own parts (`chatTurnRequestBody`, the voice payload's parts): her identity, the fixed instructions, the tool instructions and what she knows of the owner are one `system` block with `cache_control` (tools render before it: tools and system are the cached prefix); the turn's context is a mid-conversation `system` message after the owner's words; consecutive turns of one role are joined and a conversation that begins with her turn gets a user marker first. Only these lines are Sonnet's own: `SONNET_TEXT_LINES` (the JSON reply only, no prose in a calling turn), `SONNET_VOICE_LINES` (spoken words only), `SONNET_WEB_LINE` (search before answering). The registry's text is unchanged.
  - *Tools.* Her registry tools as `strict` tools with the same names and descriptions; the limits strict schemas do not support (`minLength`, `maxLength`, `minimum`, `maximum`) are written into the property's description. `tool_choice` is `auto`, and `none` for the answer without tools (forced use is a 400 on this model). The rounds (`anthropicRounds.ts`) are at parity with `withToolRounds`: the turn's one deadline, the six calls, `runToolStep` (the same session, gate, runner, parallel rule, refusal of names not offered, `tool_open`), all results in one user turn, the assistant turn appended whole (thinking blocks unchanged), a cut-off response or a timed-out round runs nothing and the answer comes without tools. A web search the server paused (`pause_turn`) is resumed at most three times.
  - *Web.* The server tool `web_search_20260209` (`max_uses` 3, voice 2 or 3) with `SONNET_WEB_LINE`, never a forced search; no function tool beside it, as on luna. Its pages become the reply's sources.
  - *Structured reply.* Text: luna's structured-turn schema through `output_config.format`, rewritten to the supported subset (`structuredSchema`: nullable types as `anyOf`, size limits in words), read with luna's `parsedChatTurn` and `chatTurnResult`. Voice: spoken text.
  - *Thinking.* Text `adaptive`, voice `between_tools`, at effort `low` (`SHANNON_SONNET_EFFORT`, `SHANNON_SONNET_TEXT_THINKING`, `SHANNON_SONNET_VOICE_THINKING` for tuning; `between_tools` is valid only at `high` or below, which is all the setting allows).
  - *Streaming.* Text: the `reply` field goes out as it is written (`ChatReplyStreamDecoder`); voice: every word, with her fixed waiting phrase before the first call of a turn in which she said nothing.
  - *Usage and price.* One `chat` row per response: input = uncached + cache write + cache read, cached = cache read; priced at 2 / 10 USD per million (cache write 2.5, cache read 0.20) and 0.01 USD per web search (`estimatedAnthropicCostUsd`).
  - *First-token latency.* On a streamed turn, the time from its first request to its first word or tool call; a rolling 80th percentile of the last 20 (at least 3) is `sonnetFirstTokenMs`, which the voice policy reads (I-2: Sonnet on voice only when the time left covers it plus 6 s; else luna).
- **Dependency.** `@anthropic-ai/sdk` is added to `services/api/package.json` and `pnpm-lock.yaml` (owner answer I-6, deployment core). The production install must fetch it once (the VM's offline store does not have it yet).
- **The `tier.*` set and the tuning harness** (`packages/evaluation/src/reach/tierSet.ts`, driver `services/api/tests/reach/reachTier.ts`): 25 owner turns (17 text, 8 voice) covering every tier, her study tools, the read tools, a web search, writes and a voice turn too short for Sonnet. Each runs through the real adapter (streamed) with stub tools and is judged on `policy.tier`, `request.accepted`, `answer.shape`, `tool.expected`, `claims.verified` and, on voice, `latency.first_token` (≤ 4 s); metrics keep first-token latency, tool calls and rounds, and the cost record keeps tokens, cache reads and yen. Model-free (`scripts/reach-measures.sh run --only tier.`) a script answers and the build is checked; live (`run --live --yes --only tier.`, with the key) it is the tuning harness: each record's inputs hold the model and the three tuning knobs, so `reach-measures.sh compare` compares only like with like. The model-free response shapes follow the SDK's types; the live run is what holds them against the API.

## Conversation choices in reward (owner answer I-3, `SHANNON_CONVERSATION_REWARD`)

This reverses stage 1's rule that a conversation's tool call is data only (`docs/cognition-ledger-contract.md`, the choice ledger).

- **Recorded at the end of the turn** (`recordTurn`, `wiring/turnRoutingWiring.ts`) in the stage-1 choice ledger: each tool call that ran (`tool.<name>`, source `tool_call`) and the turn's tier (`tier.<served>`, source `turn`), surface `text` or `voice`, context `<band>.<alone|others>`, subject `talk` (the Talk), pending. Stage 1's immediate data-only record of a conversation tool call is not made then (`server.ts`).
- **Closed signals.** G (reported as the choice's success, in [0, 1]): the mean of the signals that apply: the tool worked, the turn ended inside its deadline, the verifier found nothing (when it checked); for the tier, inside the deadline, the verifier, and every tool worked. S: the owner's next turn in the same Talk, Jev's `retry_or_correction`: < 0.35 → 1, ≥ 0.65 → 0, else ½ (settle code `next_turn`). No next turn in 30 minutes: S = ½, code `turn_expired`, which never moves her mood (`MOOD_INELIGIBLE_CODES`). W: 0 (no linked prediction yet). r = (W + S + G)/3 as for every choice.
- **Effects.** Settled conversation choices are folded into the value table with her own time's (same cells: `tool.study.search` learns from both), are claimed by the reward mood under the same warm-up (a cell that learned from three) and hourly cap (the stationary band) (`turnRouting.test.ts`, a chat burst of twenty calls), and may appear in her value facts (facts only, never with anyone else present, as before). Stage 1's data-only rows (no Talk) are never folded or claimed.

## Decision traces

The trace vocabulary (`contracts/decisionTraceContract.ts`, table `shannon_decision_traces`, unchanged) gains the surface `text` and three decisions:

| Decision | What it is | Answers (closed values only) |
| --- | --- | --- |
| `tool_menu` | Jev's choice of the tools whose schemas a turn sends | the chosen tool's name (or `none`), how many were offered, how many groups |
| `difficulty` | Jev's difficulty questions (and the menu, in the same call) | `kind`, `strong`, `verify`, `multi`, `retry` (−1 when not asked or not answered), and the menu's answers when there was one; the tier itself is recorded as the choice `tier.<served>` |
| `recall_beam` | one beam search of tree recall (step 8) | depth, width, leaves scored, stop reason |

A trace never holds the owner's words, a tool's input or a heading's text. Jev's cost per call follows stage 1 (`SHANNON_JEV_USD_PER_CALL`, unset: unknown).

## The core map

`coreAreaForRepositoryPath` (`autonomyCore.ts`) takes a file listed by name before a directory that contains it, and a deeper directory before a shallower one. Whether a path is core never changes; only a file listed by name inside another area's directory changes area (`CORE_AREA_OVERRIDES` in `autonomyCore.test.ts`, which checks every tracked file against the rule before stage 2). Stage 2 uses it for `packages/learning/src/difficultyPolicy.ts`, which is the response path's, not emotion's, although `packages/learning/` is emotion's.

## Structural refactoring (ADR-0008 §10)

Each stage's exit criteria include structural refactoring. For stage 2: `process.env` is read only in `infra/config/serverEnvironment.ts`, `wiring/` and the entry files (every other module's default is `serverEnvironment()`, the live `process.env`, so nothing changed: `serverEnvironment.test.ts`), and a part of the mind reaches another through its window, `ports.ts` or `<component>Ports.ts` (`mind/inhibition/inhibitionPorts.ts`: the budget and the gate; not the disclosure gate or the secrets, which her own time must not open). The folder-rule baseline (`scripts/api-layers-baseline.json`) went from 364 to 287 entries; `environment-in-config` has none.

## The switched-off proof

`services/api/tests/stage2SwitchedOff.test.ts` runs twelve scenarios (text: tools offered, the schedule, tasks and Notion projections, a forced web search, others present, two turns, a tool round; voice: a greeting, tools, the schedule, a companion present) through the API kernel with the real OpenAI adapter and the real Jev voice gateway over a capturing fetch, and digests every provider and Jev request with random ids taken out. The digests (`tests/fixtures/stage2-switched-off-v1.json`) were recorded on ca7cf519 itself, before any stage-2 code, and are never regenerated for a stage-2 change. Every later step runs the scenarios with the stage-2 wiring built from `SHANNON_ADR8_STAGE2=off` and must send the same bytes, and no other Jev request.
