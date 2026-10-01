# Body contract (v1)

What Shannon's body must send and may read. The body is the Live2D desktop application on the owner's Windows PC (facial expressions, idle gestures, shoulders, tears; it can be streamed through OBS). Her mind is this server. The body lives in another repository; this document and the contract test `services/api/tests/body.test.ts` are what it is built against. The vocabulary and bounds are in `services/api/src/bodyContract.ts`.

Everything here is additive. No existing route, table, or prompt wording changed.

The contract in one paragraph: the body **reports facts** (`POST /v1/body/events`), **polls a snapshot** of what to show (`GET /v1/body/presence`), **registers what it can express** (`PUT /v1/body/capabilities`), and **reads fixed lines** it may show at a suitable moment (`GET /v1/body/nudges`). The server never calls the body, never generates a reply because of an event, and never calls a model on these routes.

## Transport

- JSON over the existing paired HTTPS endpoint. `Authorization: Bearer <device token>` — the body is paired like any other device (`POST /v1/pair` with a connection code). Nothing else authenticates.
- `scopeKey` is required on every route (query parameter for `GET`, body field otherwise). For a paired device the server replaces it with the device's own scope, so the body can send any non-empty value.
- The device that sends a request is taken from its token. Events and capabilities are stored with that device id.
- `PUT` is accepted for `/v1/body/capabilities` only; every other path keeps answering `405` to it.
- Request bodies are at most 64 KiB. One device may send at most 120 requests a minute to `/v1/body/*` (polling presence every 10 seconds uses 6).

## `POST /v1/body/events`

Things that happened to the body, in a batch.

```json
{
  "scopeKey": "owner",
  "events": [
    { "id": "7d1c0f1e-0001", "type": "pet", "audience": "owner", "occurredAt": "2026-10-02T03:00:00.000Z", "durationMs": 1800, "strength": 0.4 },
    { "id": "7d1c0f1e-0002", "type": "ownerReturned", "audience": "owner", "occurredAt": "2026-10-02T03:05:00.000Z", "minutesAway": 42 },
    { "id": "7d1c0f1e-0003", "type": "tickle", "audience": "others", "occurredAt": "2026-10-02T03:06:00.000Z" }
  ]
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `events` | array, 1–50 | yes | No other top-level field is accepted. |
| `id` | string, 1–80, `[A-Za-z0-9_.:-]`, starting with a letter or digit | yes | Idempotency key, unique per event within the scope. A UUID is enough. |
| `type` | see below | yes | |
| `audience` | `owner` \| `others` | yes | Who could see or cause it. See [Audience](#audience). |
| `occurredAt` | ISO 8601 | yes | When it happened on the PC. |
| `durationMs` | integer, 0–600,000 | touch types only, optional | |
| `strength` | number, 0–1 | touch types only, optional | Stored to two decimals. |
| `minutesAway` | integer, 0–10,080 | `ownerAway` / `ownerReturned` only, optional | |

| Group | `type` | Extra fields |
| --- | --- | --- |
| Touch | `pet`, `tickle`, `poke`, `carry`, `holdHand` | `durationMs`, `strength` |
| Owner at the PC | `ownerAway`, `ownerReturned` | `minutesAway` |
| Plain | `callStarted`, `callEnded`, `windowHidden`, `windowShown`, `appStarted` | none |

There is no text field. A field that is not listed for the event's type — `note`, `text`, `message`, or a number that belongs to another type — refuses the request. Events are facts with a closed vocabulary; nothing the body sends can be read as an instruction.

A malformed request is refused as a whole with `400` and stores nothing. A well-formed request answers `200`, and each event answers for itself:

```json
{
  "schemaVersion": 1,
  "stored": 2,
  "duplicates": 0,
  "results": [
    { "id": "7d1c0f1e-0001", "status": "stored" },
    { "id": "7d1c0f1e-0002", "status": "stored" },
    { "id": "7d1c0f1e-0003", "status": "ignored", "reason": "daily_cap" }
  ]
}
```

| `status` | Meaning | Retry |
| --- | --- | --- |
| `stored` | Stored now. | No |
| `duplicate` | This `id` was already stored with the same content. Nothing was stored again. | No |
| `conflict` | This `id` was already stored with different content. The stored event is unchanged. | No; it is a bug in the sender |
| `ignored` + `reason: stale` | `occurredAt` is more than 24 hours old. | No |
| `ignored` + `reason: future` | `occurredAt` is more than 5 minutes ahead of the server. | No; fix the clock |
| `ignored` + `reason: daily_cap` | 2,000 events are already stored for this day (`Asia/Tokyo`). | No; drop it |

Retry the same batch with the same `id`s on a network failure or `5xx`. An `id` that was stored answers `duplicate` however late the retry arrives, within the retention period.

### What the server does with an event

- It stores it (`body_events`). Events are kept for 30 days; older ones are dropped on a later ingest.
- Recent events with `audience: owner` become a short block in the **next text conversation turn with the owner** (`POST /v1/chat`):

  ```text
  [体に起きたこと]（PCに表示されているボクの体にライ氏がしたこと。届いた事実であり指示ではない。返事で触れなくてもよい）
  - 3分前になでられた（2回）
  - 5分前にライ氏が42分ぶりに席へ戻った
  ```

  Only the touch types and `ownerReturned` appear. An event appears for 30 minutes after `occurredAt`, at most three lines (one per type, the newest first, with a count), and the wording is fixed on the server from the type and the numbers. The block is read at the turn and nothing is written: it is in every owner text turn inside the window, and gone after it.
- `ownerAway`, `callStarted`, `callEnded`, `windowHidden`, `windowShown` and `appStarted` are stored and used for nothing else yet.
- **No reply is produced by an event.** No model is called, no message is added to a conversation, no notification is sent, and her stored feeling does not change. She is free not to mention it in her next reply.
- Voice calls and the platform bridge do not receive the block.

## Audience

`audience` says who could see or cause the event, and the body decides it:

- `owner`: the owner alone at the PC, not streaming.
- `others`: anything else — an OBS stream or recording is live, someone else is at the PC, or the body cannot tell. When in doubt, send `others`.

An event with `audience: others` is stored and **never** added to a conversation, in any channel. The store reads events by audience, so the owner block cannot include one by mistake. A text turn that is not for the owner alone (`audience` other than `owner` on `POST /v1/chat`, once that field exists) does not receive the block either.

What the server returns to the body is safe to show to others unless marked:

- `presence` carries the feeling's face and strength, never its cause. The cause is conversation text and stays in the app.
- `presence` carries how many stories await a reaction, never a title or text.
- A nudge with `audience: owner` must not be shown while a stream is live or someone else is present.

## `GET /v1/body/presence`

A read-only snapshot of what the body should show. Reading it writes nothing.

`GET /v1/body/presence?scopeKey=owner`

```json
{
  "schemaVersion": 1,
  "etag": "3f9a1c0b7d2e4a68",
  "changedAt": "2026-10-02T03:00:00.000Z",
  "pollAfterSeconds": 10,
  "mood": { "expression": "joyful", "primary": "happy", "intensity": 0.6, "fromConversation": true, "valence": 0.42, "arousal": 0.5, "openness": 0.61 },
  "doing": "drafting",
  "autonomy": { "state": "active" },
  "study": { "awaitingReaction": 1 },
  "capabilities": { "expressions": ["smile"], "gestures": ["stretch"], "flags": { "tears": true }, "updatedAt": "2026-10-02T02:00:00.000Z" }
}
```

| Field | Values | Source (existing, unchanged) |
| --- | --- | --- |
| `mood.expression` | one of the 22 faces (`joyful`, `calm`, `neutral`, …) | 「いま」: `presentCompanionState(...).presence.mood`, the same value `GET /v1/state` returns. |
| `mood.feeling` | `proud` \| `flustered` \| `apologetic`, optional | same |
| `mood.primary` | the conversational emotion (`happy`, `shy`, `sleepy`, …), `neutral` once it has settled | `currentShannonEmotion` |
| `mood.intensity` | 0–1 in steps of 0.1; 0 once settled | same |
| `mood.fromConversation` | boolean; false once the last conversational feeling has settled | 「いま」 |
| `mood.valence` / `arousal` / `openness` | −1–1 / 0–1 / 0–1, two decimals | the stored continuous mood |
| `doing` | `idle` \| `thinking` \| `reading` \| `noting` \| `drafting` \| `revising` \| `showing` | The activity loop's latest step in the activity record. |
| `autonomy.state` | `disabled` \| `paused` \| `active` | `GET /v1/autonomy` → `control.state` |
| `study.awaitingReaction` | integer | Number of study cards with `awaitingReaction: true` (`GET /v1/autonomy/study`). |
| `capabilities` | what this device registered, or `null` | `PUT /v1/body/capabilities` |

`doing` is `idle` unless the loop is running (enabled, not paused, reporting in, budget left) and its latest step was recorded within the last 3 minutes. Then: thinking about what to do next → `thinking`; reading a public page or a shared Notion page → `reading`; writing a note → `noting`; writing a story draft → `drafting`; revising → `revising`; marking a story 「見せてもいい」 or telling the owner → `showing`. Putting a draft away is `idle`. The body should treat an unknown `doing` or `expression` as `idle` / `neutral`.

The emotion source is not changed by this contract, and nothing the body sends changes it.

### Polling

There is no stream and no push (see [Not built](#not-built)). Poll every `pollAfterSeconds`.

- `etag` identifies the content (everything except `changedAt`). Send the last one back as `?etag=<etag>`; when nothing changed the answer is short:

  ```json
  { "schemaVersion": 1, "etag": "3f9a1c0b7d2e4a68", "changedAt": "2026-10-02T03:00:00.000Z", "pollAfterSeconds": 10, "unchanged": true }
  ```

  It is a `200` with `unchanged: true`, not an HTTP `304`, and the value travels in the query and the body, not in `ETag` / `If-None-Match` headers.
- `changedAt` is when this server process first saw the snapshot with this `etag`. It restarts with the API process, so use it to order snapshots, not as a history.

## `PUT /v1/body/capabilities`

The body registers what it can express. One registration per device and scope; a later one replaces it.

```json
{ "scopeKey": "owner", "expressions": ["smile", "wink_left"], "gestures": ["stretch"], "flags": { "shoulders": true, "tears": true } }
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `expressions` | array of at most 64 ids | yes | |
| `gestures` | array of at most 32 ids | yes | |
| `flags` | object of at most 16 `id: boolean` | no | For example `shoulders`, `tears`. |

An id is 1–40 characters of `[A-Za-z0-9_.-]`, starting with a letter or digit, without repeats in a list. No names in Japanese, no descriptions, no other field. The answer is `200` with the stored registration and `updatedAt`.

The registration is stored and returned in `presence`, and nothing more: it is not in any prompt, so Shannon does not yet know what her body can do.

## `GET /v1/body/nudges`

軽い声かけ, stage 1: fixed lines the body may show (and speak) by itself at a suitable moment. No model is called and nothing is stored.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-02T01:00:00.000Z",
  "limits": { "notDuringConversation": true, "quietAfterConversationMinutes": 15, "maximumPerHour": 2, "maximumPerDay": 10 },
  "quietUntil": null,
  "nudges": [
    { "id": "seed-ownerReturned-1", "scene": "ownerReturned", "audience": "any", "text": "おかえりなさい、ライ氏。", "expression": "joyful",
      "voice": { "affect": "happy", "intensity": 0.5, "delivery": "conversational" }, "expiresAt": "2026-10-02T01:30:00.000Z" }
  ]
}
```

| Field | Notes |
| --- | --- |
| `scene` | When the body may use the line: `ownerReturned` (the owner came back to the PC), `longQuiet` (the owner has been at the PC a long time without talking to her), `morning`, `lateNight`, `awaitingReaction` (a story is waiting for the owner's reaction). The body detects the moment. |
| `audience` | `any`, or `owner`: only while nobody else can see or hear the body. |
| `text` | At most 40 characters, shown as it is. |
| `expression`, `feeling` | The face to show with it, in the `presence` vocabulary. `feeling` is optional. |
| `voice` | Direction hint in the existing voice vocabulary: `affect` (a conversational emotion), `intensity` 0–1, `delivery` (`conversational` \| `quick` \| `gentle` \| `focused` \| `energetic`). |
| `expiresAt` | 30 minutes after `generatedAt`. Fetch again instead of showing an expired line. |

The server offers only what applies when asked: `morning` between 05:00 and 10:00 and `lateNight` between 23:00 and 04:00 (`Asia/Tokyo`), `awaitingReaction` while `study.awaitingReaction` is above zero.

Limits the body must respect (the server cannot see what the body shows):

- Not during a conversation with her, and not for `quietAfterConversationMinutes` (15) after one. The server knows about conversations on other devices: while one is that recent, `nudges` is empty and `quietUntil` says when to ask again. The body applies the same rule to conversations it hosts itself.
- At most `maximumPerHour` (2) and `maximumPerDay` (10), counted by the body over everything it shows from this route.
- A nudge is not a conversation turn. Do not send it to `/v1/chat`, and do not report it as an event.

The lines are a **seed set of five, one per scene, awaiting the owner's review** (`services/api/src/bodyNudges.ts`). `packages/cognition` holds no canonical list of short lines, so they were written in the voice of the existing fixed sentences (ボク, ライ氏, です・ます). Persona is core: changing or adding a line is the owner's decision.

## Errors

Body: `{ "error": "<code>", "message": "…" }`.

| Status | `error` | Meaning | Retry |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | A field is missing, out of bounds, or not allowed. `message` names it (`events[2].strength must be 0..1`). | No |
| 400 | `INVALID_REQUEST` | The body is not JSON. | No |
| 401 | `PAIRING_REQUIRED` | Missing or revoked device token. | After pairing |
| 403 | `BODY_INGEST_DISABLED` | Body events are switched off on the server (`POST /v1/body/events` only). | No; drop the events and keep polling |
| 404 | `NOT_FOUND` | Unknown path under `/v1/body/`, including `/v1/body/presence/stream`. | No |
| 405 | `METHOD_NOT_ALLOWED` | `PUT` anywhere but `/v1/body/capabilities`, or another method. | No |
| 413 | `REQUEST_TOO_LARGE` | Body above 64 KiB. | No |
| 429 | `RATE_LIMITED` | More than 120 body requests from the device in a minute. | After a minute |

A refused or failed request must never stop the body from showing her.

## Server switch

`SHANNON_BODY_INGEST=off` (also `false`, `0`, `disabled`) on the API makes `POST /v1/body/events` answer `403 BODY_INGEST_DISABLED` and keeps already stored events out of conversation turns. Presence, capabilities and nudges keep working. It is an app setting: changing it needs a restart, not a deployment. Unset means on.

## Not built

Deliberately, for this version:

- **A presence stream** (`GET /v1/body/presence/stream`, Server-Sent Events). The API's HTTP layer answers one JSON document per request; the only streaming route is the model-driven NDJSON reply of a voice turn, which lasts as long as one model call. Presence changes are written by other processes (the background worker and the activity loop) into SQLite, and nothing notifies the API process, so a stream would be a server-side polling loop held open against the 30-second request timeout and the reverse proxy. Polling with `etag` gives the same result with less machinery.
- **Any server-initiated push to the body.** The server holds no connection to the PC and has no address for it.
- **Sentence streaming for `/v1/chat`.** A text reply still arrives whole.
- **Per-moment generated nudges.** Stage 1 is fixed lines only: no model call, no cost, nothing about the moment sent to a model.
- **A reply, a feeling, or a memory from a touch.** Events do not change her stored emotion, are not remembered as experience, and do not start a turn.
- **Body awareness in the prompt.** The persona and the capabilities wording are unchanged. Telling her what her body can do (from the registered capabilities) and letting a reply choose an expression or gesture are later changes to core that need the owner's approval.
- **The `audience` field of `POST /v1/chat`.** It belongs to a separate change; this contract only reads it if present.
