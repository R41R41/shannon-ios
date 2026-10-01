# Platform people contract (v1)

What the legacy platform runtime (Discord first; LINE, Minecraft and the others by the same contract) must send so that Shannon remembers the people she talks with there. The runtime lives in another repository; this document, the fixtures in `services/api/tests/fixtures/platform-people-v1/` and the contract test `services/api/tests/platformPeople.test.ts` are what it is built against.

Everything here is additive. A runtime that sends only today's requests keeps working unchanged: an owner-authored turn and a context request without the new fields are validated, hashed, stored and answered exactly as before.

## Transport

- `POST /v1/platform/turns` (body at most 64 KiB) and `POST /v1/platform/context` (body at most 16 KiB), JSON.
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
- A DM with someone else (`conversationKind: "dm"`, `sourceUserId` not the owner) is that person alone: only what they said in that DM and the owner's unprotected content. Nothing marked is returned, because the owner is not there to release it.
- A conversation bound `owner-private` answers only the owner.

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
- One summary per conversation and day, rewritten by the background worker inside the shared background budget, with a deterministic fallback. No model call happens on these routes.
- `SHANNON_PLATFORM_PEOPLE_INGEST=off` (also `false`, `0`, `disabled`) on the API stops accepting other people's turns and friend-authored context requests. It is an app setting: changing it needs a restart, not a deployment. Unset means on.
- A person the owner forgot in 人 is not stored again: `ignored: forgotten_person`.
