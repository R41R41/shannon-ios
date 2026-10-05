# Platform people contract (v1)

What the legacy platform runtime (Discord first; LINE, Minecraft and the others by the same contract) must send so that Shannon remembers the people she talks with there. The runtime lives in another repository; this document, the fixtures in `services/api/tests/fixtures/platform-people-v1/` and the contract test `services/api/tests/platformPeople.test.ts` are what it is built against.

Everything here is additive. A runtime that sends only today's requests keeps working unchanged: an owner-authored turn and a context request without the new fields are validated, hashed, stored and answered exactly as before.

## Transport

- `POST /v1/platform/turns` (body at most 64 KiB) and `POST /v1/platform/context` (body at most 16 KiB), JSON. `POST /v1/platform/reply` (64 KiB, off by default) is in [Replies](#replies-post-v1platformreply).
- `Authorization: Bearer <SHANNON_PLATFORM_BRIDGE_TOKEN>` — the existing service credential. Nothing else authenticates.
- The conversation must be bound in `SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON` (exact `conversationId`, or `conversationIdPrefix`). Unbound conversations are refused. The owner is the binding's `ownerUserId`; every other `sourceUserId` is another person.

## `POST /v1/platform/turns`

| Field | Type | Owner turn | Other person's turn | Notes |
| --- | --- | --- | --- | --- |
| `platform` | `discord` \| `line` \| `minecraft` \| `x` \| `youtube` | required | required | |
| `requestId` | string, 1–160 | required | required | Idempotency key, unique per platform message (e.g. `discord:<message id>`). |
| `conversationId` | string, 1–240 | required | required | The id the binding is written against. One conversation is one audience. |
| `sourceUserId` | string, 1–160 | required | required | The platform user id of the person who **actually wrote** the message. Never the owner's id for someone else's message. |
| `userMessage` | string, 1–8,000 | required | required | Plain text of the message. 600 characters are kept for another person's message. |
| `shannonReply` | string, 1–12,000 | required | optional | Shannon's reply to that message. Omit it (or send `""`) when she saw the message and did not answer. 300 characters are kept. |
| `observedAt` | ISO 8601 | required | required | When the message was written, inside the existing 30-day ingestion window. |
| `conversationKind` | `dm` \| `group` \| `channel` | optional, ignored | **required** | `dm`: one person and Shannon. `group` / `channel`: everyone in it is the audience. |
| `sourceDisplayName` | string, 1–80 | optional, ignored | **required** | The name shown in that conversation (server nickname, else global name). Becomes the person's name on first sight; a later change becomes an alias. |
| `sourceKind` | `person` \| `bot` \| `system` | optional, ignored | optional, default `person` | Set `bot` for bot and webhook authors, `system` for joins, pins, boosts and the like. Those are acknowledged and not stored. |

Owner turn, as sent today (`owner-turn.request.json`):

```json
{
  "platform": "discord",
  "requestId": "discord:1001",
  "conversationId": "discord:111:222",
  "sourceUserId": "900000000000000001",
  "userMessage": "今日はここまでにするね",
  "shannonReply": "お疲れさまでした、ライ氏。",
  "observedAt": "2026-10-02T03:00:00.000Z"
}
```

Another person's turn (`person-turn.request.json`):

```json
{
  "platform": "discord",
  "requestId": "discord:1002",
  "conversationId": "discord:111:222",
  "conversationKind": "channel",
  "sourceUserId": "900000000000000002",
  "sourceDisplayName": "ミキ",
  "sourceKind": "person",
  "userMessage": "私は辛いものが苦手。明日映画に行こうね",
  "shannonReply": "いいですね、楽しんできてください。",
  "observedAt": "2026-10-02T03:01:00.000Z"
}
```

A message Shannon saw without answering (`overheard-turn.request.json`) is the same without `shannonReply`. A DM is `dm-turn.request.json`.

### Response

`201` for a new request, `200` for a repeated one.

| Field | Type | Notes |
| --- | --- | --- |
| `duplicate` | boolean | `true` when this `requestId` was already received with the same content. |
| `threadId` | string | `platform:<platform>:<32 hex>`. |
| `experienceId` | string | The stored turn. `""` when the message was received and deliberately not stored. |
| `ignored` | string, optional | Only on another person's turn that was not stored: `bot`, `system`, `conversation_cap`, `daily_cap`, `forgotten_person`. Not an error; do not retry. |
| `personId` | string, optional | The person the message was attributed to, on a newly stored turn of another person. |

An owner turn answers with exactly `duplicate`, `threadId`, `experienceId`, as today.

### Idempotency

`platform` + `requestId` identify a turn. Repeating it with the same content answers `200` with `duplicate: true` and the same `experienceId` (and the same `ignored` reason, if any) and stores nothing again. Repeating it with different content (message, reply, author, time, display name, kind) is `409 PLATFORM_TURN_CONFLICT`. Retry on network failure and on `5xx` with the same `requestId`.

## `POST /v1/platform/context`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `platform` | as above | yes | |
| `conversationId` | string, 1–240 | yes | |
| `sourceUserId` | string, 1–160 | yes | Who wrote the message Shannon is about to answer. |
| `conversationKind` | `dm` \| `group` \| `channel` | when `sourceUserId` is not the owner | |
| `participants` | array of at most 50 platform user ids | no | The people taking part right now (recent authors are enough). The first 20 are used; the owner's id is ignored. |

`context.request.json`:

```json
{
  "platform": "discord",
  "conversationId": "discord:111:222",
  "conversationKind": "channel",
  "sourceUserId": "900000000000000001",
  "participants": [
    "900000000000000002",
    "900000000000000003"
  ]
}
```

Response, unchanged in shape: `{ "schemaVersion": 1, "stateVersion": number, "updatedAt": string, "projection": string }`. `projection` is at most 2,400 characters and goes into the model's instructions as it is.

- In a conversation other people can read, `projection` starts with the speak-time self-check, then `[この会話にいる人についての記憶]` with what Shannon remembers of the participants, then what she may know of the owner. A line that starts with `【機微:…】` is something the people present do not all know yet; the runtime passes it through untouched and must not strip the marker.
- What was said in a conversation is known to everyone in it, so it arrives unmarked there and marked anywhere else.
- A DM with someone else (`conversationKind: "dm"`, `sourceUserId` not the owner) is that person alone: only what they said in that DM and the owner's unprotected content. The reply route (and her Minecraft body's game chat) follows the same rule for what she remembers of people: in a turn with others, a person memory is given only when everyone in that conversation already heard it, so a friend's DM never reaches anyone else's turn or the owner's shared-conversation turn.
- **A message anyone other than the owner wrote** (owner decision 2026-10-06, S6), in a DM or in a shared conversation, gets only what may be shown to anyone: no line marked `【機微:…】` of the owner's (nor his recent interests), none of his intentions or current goal, no summary of the conversation (it has no label of its own), and no replayed message that was marked, and a header without the sentence that ライ氏 may release a protected line by asking (only he can). The owner's own message in a shared conversation is unchanged: marked lines and that sentence.
- A conversation bound `owner-private` answers only the owner.

## Replies: `POST /v1/platform/reply`

Added 2026-10-06 (Minecraft body phase 5a). Instead of answering with a model of its own and mirroring the turn, a runtime may ask Shannon's one mind for the reply. Off unless the API's `SHANNON_PLATFORM_REPLY` is `on` (also `true`, `1`, `enabled`): every new message is one call of the conversation model. Off, the route answers `503 PLATFORM_REPLY_DISABLED`. `/v1/platform/turns` and `/v1/platform/context` are unchanged and keep working.

**What the token can do once this is on** (review S8, 2026-10-06): whoever holds `SHANNON_PLATFORM_BRIDGE_TOKEN` can then write as the owner in any conversation bound `owner-private` and get a turn of the owner alone: his profile and memory in the prompt, her tools (writing her study and his PC folder, asking her Minecraft body), his feeling moved, his promises and memories stored from it. That is the power of one of his paired apps. Before switching it on, treat the token as an owner credential: only the runtime that holds it, never in a repository or a log, and rotated if it may have leaked. With `SHANNON_PLATFORM_REPLY` off the token keeps its old reach (mirroring turns, reading the bounded context).

Same transport, token and bindings as above; body at most 64 KiB.

| Field | Type | Owner | Other person | Notes |
| --- | --- | --- | --- | --- |
| `platform` | `discord` \| `line` \| `x` \| `youtube` | required | required | Not `minecraft`: her Minecraft body has its own route. |
| `requestId` | string, 1–160 | required | required | The same id the runtime would mirror the turn with (the platform message id). |
| `conversationId` | string, 1–240 | required | required | Must be bound. |
| `conversationKind` | `dm` \| `group` \| `channel` | optional | **required** | |
| `sourceUserId` | string, 1–160 | required | required | Who actually wrote the message. |
| `sourceDisplayName` | string, 1–80 | optional | **required** | |
| `participants` | up to 50 platform user ids | optional | optional | As for `/v1/platform/context`. |
| `userMessage` | string, 1–8,000 | required | required | Plain text. |
| `observedAt` | ISO 8601 | required | required | A new message more than 30 minutes old or more than 5 minutes ahead is `400`. |

No other field is accepted (`400 BAD_REQUEST`): no reply, attachments, `scopeKey` or audience.

The turn is a turn of the app's conversation kernel (`ShannonApiKernel.textTurn`) through the platform surface (`platformSurface.ts`) that her Minecraft body's game chat uses too, so who is present is decided by the same policy as `/v1/platform/context`:

| Speaker and conversation | Present | Tools | Kept as |
| --- | --- | --- | --- |
| Owner, conversation bound `owner-private` | the owner alone: the app's owner turn (his profile, memory, today's focus, `[マイクラの体で起きたこと]`, his feeling moves) | by the app's owner-alone rule, including `minecraft.request` while her Minecraft body is present (`docs/minecraft-body-contract.md`, phase 4) | his turn in the conversation's platform thread, owner-private |
| Owner, shared conversation | everyone in it: shared header, people lines, speak-time check, memory through the disclosure gate; no notes, tasks, Notion or calendar | none | his turn in the platform thread, audience the conversation, speaker verified owner |
| Anyone else | that conversation (or that person alone in a DM): her guest identity; in a DM and a shared conversation alike only what may be shown to anyone (no protected line of the owner's, none of her pursuits, no rule that he may release one; owner decision 2026-10-06) | none | person memory, as `/v1/platform/turns` keeps it |

A platform reply is never told what she did on her own to reach the owner (the `[ボクが自分からしたこと]` block of `/v1/chat`): the surface switch `TextTurnSurface.ownOutreach` is off for it (core owner recommendation, 2026-10-06). Her Minecraft body's game chat has it on, on the owner's own turns (`docs/minecraft-body-contract.md`). The `minecraft_body` capability line is in the owner's description of an `owner-private` conversation only while her Minecraft body is present.

Anyone else in an `owner-private` conversation, or without `conversationKind` / `sourceDisplayName`, is `403 PLATFORM_ACTOR_DENIED`, before any model call. The surface adds a short delivery note (which platform, who reads it, short replies, that nothing is promised there that she cannot do).

Response `201` (new) or `200` (repeated): `{ "reply": string ≤ 4,000, "threadId": string, "duplicate": boolean, "ignored"?: string }`. `ignored` as for `/v1/platform/turns`, plus `people_disabled` and `rate_limited`. A repeated `requestId` with the same content answers the stored reply (kept one day, longer than the 30 minutes a message is answered at all) without a second model call; with other content it is `409 PLATFORM_TURN_CONFLICT`. Retry on a network failure or `5xx` with the same `requestId`. New replies are counted per speaker right before the model is called, after the duplicate and age checks (second review, 2026-10-06; `minecraftTurnAllowance.ts`): the owner 20 a minute and 1,000 a day, apart from everyone else so he is never starved; each other person (`platform:sourceUserId`) 6 a minute and 100 a day; everyone else together 20 a minute and 400 a day. Over a limit: `429 RATE_LIMITED`, nothing answered; `502 MODEL_UNAVAILABLE` when the model could not answer.

The owner's turn is stored under the receipt `platform` + `requestId`, the one a mirror would use: a runtime that got its reply here must not mirror the turn as well (it would be `409`). A runtime that falls back to its own model after a failure here mirrors as before; if the reply here was stored but never delivered, that mirror is refused with `409` and the thread keeps her undelivered reply (known limit).

## Errors

Body: `{ "error": "<code>", "message": "…" }`.

| Status | `error` | Meaning | Retry |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | A field is missing, too long or not allowed (including `attachments`, `embeds`, `files`). | No |
| 401 | `PLATFORM_BRIDGE_UNAUTHORIZED` | Missing or wrong service credential. | No |
| 403 | `PLATFORM_CONVERSATION_DENIED` | The conversation is not bound. | No |
| 403 | `PLATFORM_ACTOR_DENIED` | Not the owner, and the people fields are missing, or the conversation is the owner's private one. | No |
| 403 | `PLATFORM_PEOPLE_DISABLED` | Turns of people other than the owner are switched off on the server. Keep sending owner turns. | No; drop the message |
| 409 | `PLATFORM_TURN_CONFLICT` | The `requestId` was used for different content. | No |
| 429 | `RATE_LIMITED` | More than 120 turns of other people in a minute. | After a minute, same `requestId` |
| 503 | `PLATFORM_BRIDGE_NOT_CONFIGURED` | The bridge is not configured. | Later |
| 503 | `PLATFORM_REPLY_DISABLED` | `/v1/platform/reply` only: `SHANNON_PLATFORM_REPLY` is not on. | Answer with the runtime's own path |

A refused or dropped turn must never stop the runtime from replying on the platform.

## What must not be sent

- The owner's `sourceUserId` for a message someone else wrote, or one person's id for another's. Identity is the platform user id and nothing else: no guessing from names, writing style or voice.
- Messages from conversations that are not bound, and messages Shannon was not part of.
- Attachments, images, files, embeds, stickers, or their URLs. Text only; a message with no text is not sent.
- Message edits and deletions as new turns under the same `requestId`.
- Bot, webhook and system messages without `sourceKind` (`bot` / `system`).
- Shannon's own messages as `userMessage`.
- Tokens, e-mail addresses, IP addresses or any platform profile data beyond the display name.
- `scopeKey` or an audience. The server decides both from the binding and `conversationKind`.

## Server bounds

- Stored turns of other people: 200 per conversation and day, 1,000 per day over all conversations (day in `Asia/Tokyo`). Beyond that the answer is `ignored: conversation_cap` / `daily_cap`.
- One summary per conversation and day, rewritten by the background worker inside the shared background budget, with a deterministic fallback. No model call happens on `/v1/platform/turns` or `/v1/platform/context`; `/v1/platform/reply` is one model call per new message.
- `SHANNON_PLATFORM_PEOPLE_INGEST=off` (also `false`, `0`, `disabled`) on the API stops accepting other people's turns and friend-authored context requests. It is an app setting: changing it needs a restart, not a deployment. Unset means on.
- A person the owner forgot in 人 is not stored again: `ignored: forgotten_person`.
