# Minecraft body contract (phases 1, 4 and 5a)

Shannon has one mind: this server. Her Live2D body on the owner's PC is one body; a Minecraft bot (Minebot, in another repository) is her second. This document is what the Minebot is built against: talking in game chat as Shannon and reporting that her Minecraft body died (phase 1), and taking requests from her mind, wherever the owner asked for them, through a server-side queue (phase 4, [Requests](#requests-phase-4)). The contract tests are `services/api/tests/minecraftBody.test.ts` and `services/api/tests/minecraftBodyRequests.test.ts`; the bounds and codes are in `services/api/src/contracts/minecraftBodyContract.ts`, `services/api/src/contracts/minecraftBodyRequestContract.ts`, `services/api/src/contracts/bodyContract.ts` and `services/api/src/mind/memory/gameBodyMemory.ts`.

Everything here is additive. Without `SHANNON_MINECRAFT_BODY_JSON` the turn route answers `503` and every game event is ignored; nothing else changes.

## Configuration

`SHANNON_MINECRAFT_BODY_JSON` in the API's environment file (an app setting: changing it needs a restart, not a deployment):

```json
{
  "deviceId": "ea36ef7c26ff1e8d",
  "servers": [
    { "serverId": "lab-qywEbW", "ownerUuid": "b9191317-c52d-4d67-85fe-ab831e6db146", "title": "マイクラ実験ワールド", "onlineMode": true }
  ]
}
```

| Field | Notes |
| --- | --- |
| `deviceId` | The paired device that is her Minecraft body (`GET /v1/devices` lists device ids). Exactly one. |
| `servers` | 1–16 servers. `serverId`: `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`, the id the Minebot sends. |
| `ownerUuid` | The owner's Minecraft account UUID on that server. The owner is this UUID and nothing else: never a name in the chat. |
| `title` | 1–80 characters. How she names the world, and the label of the conversation in 人. |
| `onlineMode` | Required boolean. Only an online-mode server has Mojang prove a player's UUID. On an offline-mode server anyone can take any name and UUID, so there **nobody is the owner and nobody is remembered**. Set `true` only for a server that is online-mode **and enforces secure chat** (signed player chat), so that the body reads each speaker's UUID from the signed player-chat packet's sender (second review N-3, 2026-10-06); a server without secure chat is configured `false`. |

The owner's scope is `SHANNON_OWNER_SCOPE_KEY` (default `owner`). An invalid value stops the server from starting.

## Transport and authentication

- `POST /v1/body/minecraft/turns`, JSON, at most 64 KiB.
- `Authorization: Bearer <device token>` of the paired device named in `deviceId`. The platform bridge's service token (`SHANNON_PLATFORM_BRIDGE_TOKEN`) does **not** authenticate this route, and this route needs no platform-bridge configuration: its bindings are derived from `SHANNON_MINECRAFT_BODY_JSON`.
- Any other paired device: `403 MINECRAFT_BODY_DEVICE_DENIED`. The configured device in any scope other than the owner's: `403 MINECRAFT_BODY_SCOPE_DENIED`.
- Every new turn is one call of the conversation model, so turns are counted per speaker before the model is called, after the device, the turn and a repeated `requestId` were checked (a refused or replayed turn costs nothing; `minecraftTurnAllowance.ts`, review S3 and N3 of 2026-10-06): the owner 20 a minute and 1,000 a day, apart from everyone else, so other players never use up his turns; each other player 6 a minute and 100 a day; all other players together 20 a minute and 400 a day (below the bridge's 120 person turns a minute, so a turn that was answered is never refused memory afterwards). Over a limit: `429 RATE_LIMITED`, nothing answered. The counts are in memory and begin again at a restart. They are fixed windows (a minute, a day, each from the first turn counted in it): at a window's boundary up to twice a limit can pass in a short time, and a server clock that goes back starts a window afresh. Before any of that, a cheap guard takes at most 120 requests a minute from one device on the turn route, valid or not (second review N-5).
- **The device's token reaches nothing else** (review S1, 2026-10-06). The device of `SHANNON_MINECRAFT_BODY_JSON` may call only `/v1/body/minecraft/*`, `POST /v1/body/events` (game events) and `GET /v1/body/presence`. Every other route answers `403 GAME_BODY_DEVICE_DENIED` before anything is read (`serverMinecraftBodyWiring.ts`), so the body cannot talk as the owner in `/v1/chat`, use her study or folder, read his memory, or open the operations console (which treats its token as no device).

## `POST /v1/body/minecraft/turns`

One chat message to Shannon, in the server's chat or whispered to her.

```json
{
  "requestId": "lab-qywEbW-1728129600000-1",
  "serverId": "lab-qywEbW",
  "conversation": { "kind": "channel" },
  "speaker": { "uuid": "b9191317-c52d-4d67-85fe-ab831e6db146", "name": "Rai1241" },
  "message": "シャノン、木材集めといて",
  "observedAt": "2026-10-05T12:00:00.000Z",
  "body": {
    "busyWith": "campaign",
    "task": "エンドラを倒す → 今は鉄のツルハシ作り",
    "dimension": "overworld",
    "health": 18,
    "food": 17,
    "timeOfDay": "day",
    "recentAdvancements": ["minecraft:story/smelt_iron"]
  }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `requestId` | string, 1–120, `[A-Za-z0-9][A-Za-z0-9_.:-]*` | Idempotency key, unique per message across all servers. |
| `serverId` | string | One of the configured servers; otherwise `403 MINECRAFT_SERVER_DENIED`. |
| `conversation` | `{ "kind": "channel" \| "dm" }` | `channel`: the server's chat, read by everyone on it. `dm`: a whisper (`/msg`, `/tell`) between that player and her. |
| `speaker` | `{ "uuid", "name" }` | The player who **actually wrote** it: account UUID (with dashes) and current name (`[.A-Za-z0-9_]{1,17}`). The UUID must be the sender UUID of a signed player-chat packet as the body received it, never parsed from system chat, a disguised chat message or any other text (review S2, 2026-10-06). A server that does not enforce secure (signed) chat, or an offline-mode one, cannot prove who wrote: there everyone is a stranger (`onlineMode: false` in the configuration). |
| `message` | string, 1–600 | Plain text of the message, without the name prefix the game adds. |
| `observedAt` | ISO 8601 | When it was written. A new turn more than 30 minutes old or more than 5 minutes ahead is `400`. |
| `body` | object, optional (added in 1.5) | What her Minecraft body is doing right now. See [The body's present](#the-bodys-present-body). |

No other field is accepted (`400 BAD_REQUEST`), including `scopeKey` (the scope is the device's; review N4, 2026-10-06), audiences, attachments, or a reply.

How a turn is mapped:

| | Platform conversation | `sourceUserId` | Audience |
| --- | --- | --- | --- |
| `channel` | `minecraft:<serverId>` | `mc:<uuid>` | shared: everyone on the server |
| `dm` with the owner | `minecraft:<serverId>:dm:<ownerUuid>` | `mc:<ownerUuid>` | owner-private |
| `dm` with anyone else | `minecraft:<serverId>:dm:<uuid>` | `mc:<uuid>` | that conversation |

### One conversation kernel

A turn on an online-mode server is a turn of the app's own conversation kernel (`ShannonApiKernel.textTurn` in `apiKernel.ts`, the same function `POST /v1/chat` runs): replay of the conversation under forgetting and withholding (`conversationReplay`), deterministic, full-text and semantic recall, people recall, her identity and today's focus, the reply's feeling, her tools, storing, and the background work after it. Minecraft is one more surface of it; what differs is decided in two places:

- **Who is present** comes from the platform bridge's own policy for the mapped conversation (`PlatformBridgeService.audiencePolicy`, which `POST /v1/platform/context` uses too), turned into the kernel's audience policy by `platformSurface.ts` (the platform surface the platform reply route uses too, `docs/platform-people-contract.md`, Replies):

  | Speaker and conversation | Present | Her identity | Reads | Tools | Kept as |
  | --- | --- | --- | --- | --- | --- |
  | Owner, whisper | the owner alone | the app's owner turn: his profile, everything she may use with him alone | as in the app | offered, by the app's owner-alone rule | his turn in the whisper's platform thread, owner-private; his feeling moves |
  | Owner, chat | everyone on the server (the chat's group audience) | without his profile, with the shared header, the people lines and the speak-time privacy check | no notes, tasks, Notion or calendar; memory through the disclosure gate (what that audience may not hear is left out, protected lines are marked) | none | his turn in the chat's platform thread, audience the chat, speaker verified owner |
  | Anyone else, chat | everyone on the server | guest, with the shared header and speak-time check **without** the rule that ライ氏 may release a protected line by asking | only what may be shown to anyone: no notes, tasks, Notion or calendar, no protected (【機微】-marked) line of his, none of his intentions or current goal, no conversation summary, none of her notes or pursuits, nothing of what she did on her own | none | person memory (`docs/platform-people-contract.md`) |
  | Anyone else, whisper | that player alone | as the line above | as the line above | none | person memory |

  What she remembers of people (person memory) reaches a turn with others only when everyone in that conversation already heard it (`audienceCovers`), or the owner made it ordinary himself; one rule, `heardByEveryoneHere`, for game chat, the platform reply route and `POST /v1/platform/context`: one player's whisper never reaches another player's turn, nor the owner's turn in the chat; it reaches that player's own whisper. Owner decision 2026-10-06 (S6): only the owner himself may release a protected line of his, so a turn anyone else wrote, in the chat or a whisper, is given only what may be shown to anyone (`openOnly`), and its header and speak-time check leave out the sentence that he may ask for it. His own turn in the chat keeps both, with protected lines marked. The same holds for Discord (`docs/platform-people-contract.md`). This is decided where each part of the prompt is made (second review, 2026-10-06), not by filtering lines afterwards: the turn's cognitive context leaves out marked items, his intentions and current goal, and her notes (`openOnly` of `prepareTurnCognitiveContext`, also in semantic recall); the replay gives no summary and no marked message; today's focus and her pursuits are not given; `withoutGuardedEntries` stays as a second layer.

  The audience is decided by the conversation the message was written in, and by nothing else: the chat is bound `shared` and the owner's whisper `owner-private` (`minecraftBridgeConfiguration`, `minecraftBodyContract.ts`), and `PlatformBridgeService.audiencePolicy` (`platformBridge.ts`) and `platformAudienceTurn` (`platformSurface.ts`) turn that into the kernel's audience. A chat turn is the shared chat whether the owner is alone on the server or not: a turn carries no list of players, and none can be sent (`players`, `participants`, or a player count in `body`, refuse the turn). Only the owner's whisper (`dm` with `ownerUuid`) is the owner alone; another player's whisper is that player alone (unknown until remembered).

- **What she did on her own** (`ownOutreach.ts`, the `[ボクが自分からしたこと]` block; owner decision 2026-10-06): given to game chat by the app's audience rules, on the owner's own turns only. His whisper: everything, as in the app with him alone. His turn in the chat: times only, never the words of a message or what became of a call, as in the app with others present. A turn anyone else wrote (chat or whisper, guest identity) never gets it. The surface switch is `TextTurnSurface.ownOutreach` (on for game chat, off for `POST /v1/platform/reply`); because a shared platform conversation reads no upcoming items, the surface sets this selection itself (`ownOutreach` of the capability selection, `conversationCapabilities.ts`) instead of following `upcoming` as the app does.

- **The surface** (`TextTurnSurface`): no conversation commands, organizing, orchestration, looks, Live2D `[体に起きたこと]` block or agent-task proposals; the delivery note, the body's present and (owner only) the intent instructions are added after the audience's instructions; the conversation keeps the world's `title` (no automatic title); and the turn is kept where this surface keeps it: the owner's through `ingestPlatformTurn` with the platform receipt of `mc:<requestId>`, anyone else's through the bridge's `ingest`.

The delivery note says she is in Minecraft with the speaker right now, the reply goes to game chat, Japanese, one or two short sentences; whatever is asked in game chat is about Minecraft unless it is clearly not (「パンを作って」 is bread in the game; she does not ask whether it is real bread); when asked what she is doing she answers from the body's present, or says she does not know; moving her body is a separate mechanism, so the reply never says it already did something.

History: the platform thread of the conversation, replayed by the kernel's own rules. A follow-up (「パンを作って」 → 「マイクラで」) keeps its subject. Other players' lines are person memory, not thread messages, so a chat replays the owner's turns there (which everyone there read); a whisper and the chat never see each other's messages.

A platform thread (`platform:<platform>:<32 hex>`) is never the app's default Talk, and reading one creates nothing: it is created when its first turn is stored (`isPlatformThreadId`, `conversationStore.ts`). This holds for Discord's platform threads too.

Her tools stay with the app's rule: offered only while the owner alone reads the reply (his whisper). A Minecraft chat turn does not mark "others present" for the scope (`ToolAudienceWatch.noteOthers`), so it never withholds her tools in the owner's own app.

An offline-mode server, or someone else while people memory is off, does not reach the kernel: her guest identity, a line that the speaker cannot be told apart, the delivery note and (in the chat) the body's present; nothing read, nothing kept.

### The body's present (`body`)

Optional on every turn. Closed: any other field, or a value outside these, refuses the turn with `400 BAD_REQUEST`.

| Field | Type | Notes |
| --- | --- | --- |
| `busyWith` | `campaign` \| `request` \| `idle` | Working on her own goal, on something she was asked, or nothing. |
| `task` | string, 0–120 | The body's own short line about what it is working on, e.g. 「エンドラを倒す → 今は鉄のツルハシ作り」. Control characters become spaces. It must not carry the contents of a request (the owner's matter). Anyone else's turn gets it only while `busyWith` is `campaign` or `idle`; with `request`, or without `busyWith`, it is given to the owner's turns only (review S5 and N-2, 2026-10-06). |
| `dimension` | `overworld` \| `the_nether` \| `the_end` | |
| `health` | number, 0–20 | Half hearts; kept to one decimal. |
| `food` | integer, 0–20 | |
| `timeOfDay` | `day` \| `night` \| `dawn` \| `dusk` | |
| `recentAdvancements` | up to 5 namespaced ids, newest first | e.g. `minecraft:story/smelt_iron`. Common vanilla advancements are put in her words on the server (「鉄を精錬した」); an id it does not know is left out. |

- It becomes one short block in the prompt of that turn only, beside the delivery note, marked as the body's report and not an instruction: `[マイクラの体の今]` with lines such as 「いまの状態: 自分の目標の冒険を進めている」「取り組んでいること（体の報告）: …」「いる場所: オーバーワールド」「体力 18/20、満腹度 17/20」「ゲーム内の時間: 昼」「最近できたこと: 鉄を精錬した」.
- It is the body's present, not an experience: it is stored nowhere (not in the thread, not as an experience, not in the turn replay table).
- It is given for the owner's turns, and in the shared chat as game state everyone there can see. A whisper from anyone else is not given it.
- It is **not** part of the idempotency key: a retry may carry a newer `body` (it is read when the request is built) and still gets the answer already given, so a retry never conflicts or costs a second model call because the body moved.

### Response

`201` for a new turn, `200` for a repeated one.

```json
{
  "reply": "任せてください、オークの原木を集めてきます。",
  "intent": { "kind": "task", "goal": "オークの原木を16個集める" },
  "threadId": "platform:minecraft:0123456789abcdef0123456789abcdef",
  "duplicate": false
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `reply` | string, 1–600 | What she says. The Minebot splits it for the game's 256-character chat lines and sends it in the same conversation (chat, or a whisper back). |
| `intent` | object, owner's turns only | What she asks her Minecraft body to do: `kind` `task` (with `goal`, ≤120 characters, what and how much), `stop`, or `none` (`goal` empty). Absent on every turn that is not the owner's on an online-mode server. The Minebot decides whether and how to act on it. She is told to take a feasible request in the game without asking back, with a concrete goal (「パンを3個作る」; she picks a sensible amount when none is said), and never to say it is already done. Phase 4: while the body is claiming requests, a `task` is queued as a request and the intent carries `request: { "id": "<uuid>" }`; the body then takes it through its claim and does not act on the intent itself. Without `request` (no claim in the last 40 s) the body acts on it as before. A `stop` also asks every open request to stop. |
| `threadId` | string | The platform thread of the conversation. |
| `duplicate` | boolean | `true` when this `requestId` was already answered: the same `reply` and `intent` come back, and the model is not asked again. |
| `ignored` | string, optional | The turn was answered and deliberately not remembered: `offline_server`, `people_disabled` (people memory is off on the server), `rate_limited` (more than 120 turns of other people a minute), or a platform-people reason (`conversation_cap`, `daily_cap`, `forgotten_person`). Not an error. |

### Idempotency

`requestId` identifies a turn for one day (review N2, 2026-10-06: the stored answers are deleted at a later answer once a day old; a repeat after that is outside the 30-minute window and refused, never answered twice). The content is `serverId`, `conversation.kind`, `speaker`, `message` and `observedAt`; `body` is not part of it. The same `requestId` with the same content answers `200` with the stored answer, while it is kept. With different content (server, kind, speaker, message, time) it is `409 MINECRAFT_TURN_CONFLICT`. Two identical requests at once are one model call. Retry on a network failure or `5xx` with the same `requestId`.

## Body event `game.died`

Sent through the existing `POST /v1/body/events` of `docs/body-contract.md`, with the same device token.

```json
{
  "scopeKey": "owner",
  "events": [
    { "id": "lab-qywEbW-death-1728129700000", "type": "game.died", "audience": "others", "occurredAt": "2026-10-05T12:01:40.000Z", "cause": "minecraft:lava" }
  ]
}
```

- `cause` is required: the game's namespaced id of what killed her body (Minecraft's damage type, such as `minecraft:lava`, `minecraft:drown`, `minecraft:mob_attack`), `[a-z0-9_.-]{1,32}:[a-z0-9_./-]{1,64}`. There is no text field; any other field refuses the batch (`400`).
- `audience`: `others` when other players are on the server, otherwise `owner`. A game event never reaches the `[体に起きたこと]` block, and never stands in for who is at the PC.
- Only from the configured device, in the owner's scope. From any other device the event answers `ignored` with `reason: not_game_body`. Her Minecraft body reports nothing but game events: anything else it sends answers `ignored` with `reason: game_only`.
- **A game body, never a body that shows her** (core owner decision, 2026-10-06). 「ゲームの体」 is identified by the `deviceId` of `SHANNON_MINECRAFT_BODY_JSON` alone and never registers: `PUT /v1/body/capabilities` from that device answers `403 GAME_BODY_CAPABILITIES_DENIED`. Only `game.*` events are taken from it; everything else answers `game_only`. It is never counted in `othersPresent` (its game events are left out of the fallback, its presence reads note no audience, and it has no registration to stand in), never "the call elsewhere" of `ownerCallElsewhere`, never a full body a `409 OWNER_IN_CALL_ELSEWHERE` is for, and never a body that is touched or feels a touch, even if a registration for it was stored before this rule (`ShannonBody.isGameBody`). If more games or bodies need registering later, that is decided then by adding a `kind` to the registration.
- A stored death becomes one experience (`experience_events`, source `body.game`) in the server's own words, from a closed table of causes: 「ゲームの記憶: 10月5日の夜、マイクラで死んだ（溶岩）。」 An unknown cause is remembered without one. Like a touch, it has no conversation message and no words of the owner (`speaker: unknown`); recall, search, the Memory screen and forgetting treat it like any other experience. A repeated `id` answers `duplicate` and writes nothing again.
- Phase 1 moves no feeling.

## Requests (phase 4, retired)

Retired by Syzygy ADR-0009 stage 1 S9 (owner answer of 2026-10-12: the old Minecraft request path is removed at the end of stage 1). The owner's requests to her body (her `minecraft.request`, `minecraft.status` and `minecraft.cancel` tools, and his game-chat task intents) enter the common task tree and run through `/v1/body/minecraft/control` (see the common FCA section below). The phase-4 routes `POST /v1/body/minecraft/claim`, `GET /v1/body/minecraft/requests` and `POST /v1/body/minecraft/requests/{id}/progress|report|cancel` answer `503 MINECRAFT_BODY_NOT_CONFIGURED`, as they did once the common path was on. Their tables (`minecraft_body_requests`, `minecraft_body_presence`, `minecraft_execution_acknowledgements`, `minecraft_experience_outbox`) are kept as they are and no longer written; requests already remembered as experiences stay readable under `GAME_REQUEST_DISCLOSURE`.

The capability line `minecraft_body` (「マイクラの体: …ワールドに入っている時…」) is not in her fixed description (`SHANNON_CAPABILITIES`): it is `SHANNON_MINECRAFT_BODY_CAPABILITY` in `capabilities.ts`, added to the owner's description by `withMinecraftToolLine` (`shannonMinecraftTools.ts`) exactly when the turn offers `minecraft.request`, which the runner offers only while the turn's task context is open.

## Errors

Body: `{ "error": "<code>", "message": "…" }`.

| Status | `error` | Meaning | Retry |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | A field is missing, too long, not allowed, or `observedAt` is outside the window. | No |
| 401 | `PAIRING_REQUIRED` | Missing or unknown device token. | No |
| 403 | `MINECRAFT_BODY_DEVICE_DENIED` | Not the configured device. | No |
| 403 | `MINECRAFT_BODY_SCOPE_DENIED` | Not the owner's scope. | No |
| 403 | `MINECRAFT_SERVER_DENIED` | `serverId` is not configured. | No |
| 403 | `GAME_BODY_CAPABILITIES_DENIED` | `PUT /v1/body/capabilities` from her Minecraft body, which never registers. | No |
| 409 | `MINECRAFT_TURN_CONFLICT` | The `requestId` was used for a different turn. | No |
| 403 | `MINECRAFT_OWNER_ONLY` | Phase 4: the body called an owner's route (list, cancel). | No |
| 404 | `MINECRAFT_REQUEST_NOT_FOUND` | Phase 4: no such request handed to this device (or in this scope). | No |
| 409 | `MINECRAFT_REQUEST_FINISHED` | Phase 4: cancel of a request that already finished. | No |
| 429 | `RATE_LIMITED` | Over a speaker's limit (see Transport). | Later, same `requestId` |
| 403 | `GAME_BODY_DEVICE_DENIED` | Her Minecraft body's token on a route other than its own, game events and presence. | No |
| 502 | `MODEL_UNAVAILABLE` | The model could not answer. | Yes, same `requestId` |
| 503 | `MINECRAFT_BODY_NOT_CONFIGURED` | `SHANNON_MINECRAFT_BODY_JSON` is not set. | Later |

A refused turn must never stop the Minebot from playing; it may stay silent.

## Privacy rules

- Who the owner is comes from the configuration and the account UUID of an online-mode server. Never from a name, a skin, a writing style, or the Minebot's guess.
- Offline-mode servers: everyone is a stranger. No owner memory, no person memory, no intent, and nothing is stored (`ignored: offline_server`). She answers from her identity alone.
- The server's chat is shared: the bridge's speak-time check applies. On the owner's own turn there, owner content other players do not know is marked or left out exactly as on Discord and in the app with others present (`docs/architecture.md`, disclosure gate): what he said is secret or marked 機微 by hand never reaches such a request; ordinary items are open, as they are to anyone the owner talks with. On a turn anyone else wrote, in the chat or a whisper, nothing protected reaches the request at all (owner decision 2026-10-06). A whisper with the owner is his alone.
- Only the owner's turns become the owner's experiences and may carry an `intent`. Other players' words are person memory, never instructions to her body. Requests (phase 4) come only from the owner: his own game-chat turns and her tools in a conversation he alone reads.
- A request result is the owner's matter: its block is given only while he alone reads the reply. The body is handed the goal and the surface it was asked on, never the Talk or anything of the conversation. The `gained` counts are the only inventory facts the body sends, and only for a request.
- What reaches the server is text the player wrote to her, the facts above, and the body's present in its closed form. The Minebot sends no coordinates, inventories, screenshots, chat she was not part of, or her own messages as turns.
- The body's present is game state: given for the owner and in the shared chat, never in another player's whisper, and never stored.

## Planned phases

Decided direction. Phase 4 is built ([Requests](#requests-phase-4)) and phase 5a in dev; the rest is not.

2. **Other game events and feeling.** More closed event types (for example `game.respawned`, `game.advancement` with a namespaced id, `game.hurt` with a bounded amount, `game.slept`, `game.joined`/`game.left`), each with closed fields only. A small reducer turns them into her feeling through the one emotion entrance (as a touch does in `bodyTouch.ts`), and the important ones into experiences in fixed words. Deciding which events reach her feeling is an emotion-source change and needs the owner's approval.
3. **Friends by whisper.** Friends talk to her by whisper (`kind: dm`) as their own conversation, with her impressions and person memory of them, and the people screen showing where she met them; channel turns keep the shared rules. Joining players as `participants` for the context.
4. **Requests from anywhere** (built for the app and the game chat). Choices made: the game-chat `intent` became one entrance to the queue (the server enqueues it and the body claims it like any other) rather than the body acting and reporting separately, so there is one path for progress, cancel and results; she learns the result from the `[マイクラの体で起きたこと]` block and an experience, not by reaching out. The capability line `minecraft_body` was added now (with its evidence test), worded as conditional (「ワールドに入っている時」), because the tool exists; on 2026-10-06 it was made conditional in fact (only while the body is present; see [Her tools](#her-tools)), so that the default prompt stays as it was. Discord was built in phase 5a (below). Not built: her reaching out when a request finishes; the block in voice turns.
5. **Discord and production.** 5a (built in dev, 2026-10-06): the Discord bot (Shannon-dev, behind its own default-off `SHANNON_CORE_PLATFORM_REPLY=true`) asks `POST /v1/platform/reply` (off unless `SHANNON_PLATFORM_REPLY=on`) for the reply to a bound conversation instead of its own model, falling back to its own path on any failure. The owner's DM bound `owner-private` is the owner alone, so 「マイクラで木材集めといて」 there is her `minecraft.request` into this queue while the body is present, and a later 「何頼んだっけ？」 there reads `[マイクラの体で起きたこと]`. A shared channel and friends get no tools but, while Aether is configured, her Aether reading tools inside 「シャノン用フォルダ」 (owner decisions 2026-10-06; her game chat itself offers none). 5b (not built): the production rollout behind the default-off flags (the absent `SHANNON_MINECRAFT_BODY_JSON` is off today), with a backup, a paired production device, bindings for the owner's real DM, and a smoke test on the lab server first; her reaching out on Discord when a request finishes.


## Common-FCA execution adapter

See [the common FCA contract](fca-runtime-contract.md#minecraft-and-touch-connection-stage-4) for the new execution path. Since S9 a configured body always uses it (the `SHANNON_FCA_MINECRAFT` switch is retired); it runs in the common runtime, which is always on. It uses `/v1/body/minecraft/control`, a separate paired-body contract for world frames, skill catalogs, concrete candidates, commands and receipts; it does not extend the game-chat payload with images or exact coordinates. The Minebot adapter must separately opt into `MINEBOT_COMMON_FCA=on`. Both sides must agree; there is no fallback to the legacy campaign executor when the common control route is unavailable. The old request queue is not used for new work in common mode.

The normal planner is the same Task Hub/FCA used by other work. Minebot executes registered physical skills and bounded primitive actions under its existing local ownership, returning actual stop/quiescence receipts. Delivered commands are never replayed after uncertain delivery or restart. See the VM adapter's own checked-in runbook for its isolated renderer preparation and verification; no live Minecraft benchmark is implied by deterministic integration tests.

## Candidate lifecycle operator

[The lifecycle contract](minecraft-lifecycle-contract.md) adds an independent paired operator connection so a disconnected world can still be started and joined. The common FCA and native body remain the gameplay executor. This candidate is source-tested; it is not a deployed operator or a live-game acceptance.

## Skill duration, failure kinds and pace (Minebot lane agreement, 2026-10-14)

- A catalog skill may carry `maxDurationMs`. The API sets a skill command's `deadlineAt`, and waits for its receipt, that long: at most 600,000 ms, and 120,000 ms when the field is absent or not a number of at least 1,000 (`minecraftOutcome.ts`). The body runs a skill for min(`maxDurationMs`, `deadlineAt`).
- A receipt may carry `failureType` and `recoverable`. A failed skill's text then ends with a fixed hint the model reads, `［再試行の目安: <kind>｜…］`, and the result is retryable for `retry_same` (interrupted, timeout, movement_incomplete, position_verification_failed, placement_unconfirmed, not_ready, BODY_DEADLINE) and `change_situation` (no_path, no_route_from_here, target_not_found, distance_too_far, unsafe_*, threat_too_close, inventory_full, no_descent, descent_too_high, descent_blocked, and any other code), not for `need_material` (material_missing, missing_item, missing_tool, wrong_tool, tool_durability_low, tool_broke) or `invalid_input` (invalid_*, unsupported_target, protected_target). A failure without `failureType`, a `BODY_*` text among them, is not retryable and reads as the body wrote it.
- Each FCA decision of a body task carries `body.pace`: minutes since the task began, its latest tool results that worked and failed (at most six), its steps in a row whose actions all failed, and the latest `mc.goal-evidence` milestones (`dimension`, `netherReached`), read from the whole result and kept in the checkpoint (`minecraftMilestones`); and, once per replay epoch, `bodyInstructions` (time is limited; change the approach when steps bring no progress; never wait idle while nobody can answer).
- Minecraft run 9 (2026-10-14): for a body task (its body bound to it, or made from a Minecraft request) a reselection of her tools never leaves out every body tool while the catalog offers them; any other task keeps the selector's choice (the previous selection's body tools are kept, or all of them; `fcaToolState.ts`). When the body's state matches one of her readable skills' triggers (night, dark within a minute or a threat within 16 blocks: `mc-night-retreat`; health ≤ 10: `mc-low-health`; food ≤ 6, three failed steps in a row or two `mc.wait-time` calls among her latest six tool results: `mc-food-and-pace`; an iron or better pickaxe in the overworld before the Nether: `mc-nether-portal`; in the Nether: `mc-nether-travel`; a blaze within 48 blocks there: `mc-blaze-rods`), the decision's `body` carries `skillPointers` (at most three, name and trigger, safety and the Nether path before food and pace) and the fixed `skillPointerNote` (`minecraftSkillPointers.ts`); `body.pace.idleWaitSeconds` sums her `mc.wait-time` calls (kept in the checkpoint as `minecraftIdleWaitMs`). Only the volatile decision message changes; the instructions and their hashes do not.
- Skill gists (owner 2026-10-15: 「推奨の形で進める」; `SHANNON_FCA_SKILL_GIST`, default on; `minecraftSkillPointers.ts`, `wiring/fcaSkillGists.ts`, `skillGist` in `skillDocument.ts`): beside `skillPointers` the decision's `body` carries `skillGists` (`[{ skill, steps }]`, in the pointers' order) for each pointed skill that can be shown now, and then the fixed note `MINECRAFT_SKILL_GIST_NOTE` in place of the pointer note. A gist is code over the skill's stored text, no model call: the first numbered steps of `## 手順` (the first lines without numbered steps), the shared observe-first step (`minecraft.observe` and no `mc.*` tool) left out, at most 3 lines of at most 90 characters, fence markers neutralized. Each skill is opened through `skill.read`'s own port (its visibility, forgetting, withdrawal and secret checks at use time; only skills in the index, so the cap of 25 holds) and its exact revision is pinned as a read source of the task, with the owner alone, before any of its text is given; one that cannot be opened or pinned keeps its pointer alone. It is in the volatile decision message (inside `body`, which is never elided), never in the cached system prefix: the system text, `bodyInstructions` and the tool schemas are unchanged. A gist followed is a use of kind `gist` (`docs/skill-and-routing-contract.md`). Off: `body` is as before, byte for byte.
