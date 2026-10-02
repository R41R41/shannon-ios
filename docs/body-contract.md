# Body contract (v1)

What Shannon's body must send and may read. The body is the Live2D desktop application on the owner's Windows PC (facial expressions, idle gestures, shoulders, tears; it can be streamed through OBS). Her mind is this server. The body lives in another repository; this document and the contract test `services/api/tests/body.test.ts` are what it is built against. The vocabulary and bounds are in `services/api/src/bodyContract.ts`.

Everything here is additive. No existing route, table, or prompt wording changed.

The contract in one paragraph: the body **reports facts** (`POST /v1/body/events`), **polls a snapshot** of what to show (`GET /v1/body/presence`), **registers what it can express** (`PUT /v1/body/capabilities`), **reads fixed lines** it may show at a suitable moment (`GET /v1/body/nudges`), **answers one look at the room** when the snapshot asks for it (`POST /v1/body/looks/{id}`), and **says what it did with a message she started on her own** (`POST /v1/body/reach-outs/{id}/delivery`). The server never calls the body and never generates a reply because of an event. Only the answer to a look calls a model; no other route here does.

## Transport

- JSON over the existing paired HTTPS endpoint. `Authorization: Bearer <device token>` — the body is paired like any other device (`POST /v1/pair` with a connection code). Nothing else authenticates.
- `scopeKey` is required on every route (query parameter for `GET`, body field otherwise). For a paired device the server replaces it with the device's own scope, so the body can send any non-empty value.
- The device that sends a request is taken from its token. Events and capabilities are stored with that device id.
- `PUT` is accepted for `/v1/body/capabilities` only; every other path keeps answering `405` to it.
- Request bodies are at most 64 KiB, except `POST /v1/body/looks/{id}` (535,384 bytes; see [Looking at the room](#looking-at-the-room)). One device may send at most 120 requests a minute to `/v1/body/*` (polling presence every 10 seconds uses 6).

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
- `ownerAway` and `ownerReturned` are also read by her activity loop after a message of hers, as "he is away" / "he is back" (the newest of the last hour, whatever its `audience`). `callStarted`, `callEnded`, `windowHidden`, `windowShown` and `appStarted` are stored and used for nothing else yet.
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

A read-only snapshot of what the body should show. Reading it changes nothing of her state. The server notes when each device last read it (in memory, and for a device that registered capabilities also as one timestamp per device in the database, at most every ten seconds), which is how it knows her window is showing.

`GET /v1/body/presence?scopeKey=owner[&etag=…][&audience=owner|others]`

`audience` is optional (added 2026-10-02): who can see or hear the body right now, decided as for events. The server keeps the latest value per device for 90 seconds and uses it for one thing: how guarded a message she starts on her own is. Send it on every read when you can tell; a body that does not send it is treated as before (the audience of its newest event of the last 30 minutes stands in). Any other value is answered `400`. It is not part of the snapshot and does not change the `etag`.

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
  "capabilities": { "expressions": ["smile"], "gestures": ["stretch"], "flags": { "tears": true }, "updatedAt": "2026-10-02T02:00:00.000Z" },
  "look": null,
  "reachOut": { "pending": 1, "latestId": "0b6f…" }
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
| `look` | `{ id, requestedAt, expiresAt }` \| `null`; absent while looks are switched off | A look this device is asked to take now. See [Looking at the room](#looking-at-the-room). |
| `reachOut` | `{ pending, latestId? }`; absent on a server that does not deliver them | Unread messages she started on her own. See [A message she starts on her own](#a-message-she-starts-on-her-own). |

`doing` is `idle` unless the loop is running (enabled, not paused, reporting in, budget left) and its latest step was recorded within the last 3 minutes. Then: thinking about what to do next → `thinking`; reading a public page or a shared Notion page → `reading`; writing a note → `noting`; writing a story draft → `drafting`; revising → `revising`; marking a story 「見せてもいい」 or telling the owner → `showing`. Putting a draft away is `idle`. The body should treat an unknown `doing` or `expression` as `idle` / `neutral`.

The emotion source is not changed by this contract, and nothing the body sends changes it.

### Polling

There is no stream and no push (see [Not built](#not-built)). Poll every `pollAfterSeconds`: 10, or 3 for a minute after a text turn and while a look is open.

- `etag` identifies the content (everything except `changedAt`). Send the last one back as `?etag=<etag>`; when nothing changed the answer is short:

  ```json
  { "schemaVersion": 1, "etag": "3f9a1c0b7d2e4a68", "changedAt": "2026-10-02T03:00:00.000Z", "pollAfterSeconds": 10, "unchanged": true }
  ```

  It is a `200` with `unchanged: true`, not an HTTP `304`, and the value travels in the query and the body, not in `ETag` / `If-None-Match` headers.
- `changedAt` is when this server process first saw the snapshot with this `etag`. It restarts with the API process, so use it to order snapshots, not as a history.

## A message she starts on her own

Owner decision 2026-10-02 (話しかける): in her own time she may write the owner a short message, up to three times an owner-local day, for one of four reasons — `share` (something she read or wrote), `wonder` (what he is doing), `upcoming` (something near in his calendar, promises or tasks), `saw` (what she saw in a look she just took). She does not do it while a conversation is in progress (a turn in the last 10 minutes). There are no quiet hours.

It reaches the body through what already exists:

1. `presence.reachOut.pending` goes up and `latestId` changes, which changes the `etag`. The body sees it within one poll (10 seconds).
2. `GET /v1/initiatives?scopeKey=…` returns the unread messages; a reach-out has `kind: "reach_out"` and `reason`:

   ```json
   { "unreadCount": 1, "messages": [ { "id": "0b6f…", "threadId": "…", "content": "ライ氏、いま何をしていますか。", "expression": "curious",
     "sourceTitle": "シャノンから", "sourceURL": "", "createdAt": "2026-10-02T04:00:00.000Z", "kind": "reach_out", "reason": "wonder" } ] }
   ```

   `expression` is `excited` for `share`, `curious` for `wonder` and `saw`, `thinking` for `upcoming`. Other initiatives (a due promise, a story she shows, a look the owner asked for) have no `kind`.

What the body must do:

- When `latestId` is one it has not shown, read `/v1/initiatives`, and show a bubble and speak `content` for each `kind: "reach_out"` message it has not shown. Remember shown ids locally (the list keeps a message until the owner reads it in an app).
- **Do not call `POST /v1/initiatives/read`.** Reading belongs to the apps; marking it there would clear the iPhone's badge for a message the owner may not have seen.
- She speaks even while other people are present ("that situation is fun too"). The server has already worded the message for that when it knew: send `audience=others` on presence reads while a stream is live or 「友人も一緒」 is on. The body does not filter the text.
- A message older than a few minutes when the body first sees it (the PC was asleep) is better shown silently or skipped; `createdAt` says how old it is.
- `saw` messages are about the owner's room. The server sends them like the others; the phone's lock screen shows only a fixed line for them.
- After showing a message, or deciding not to, report what happened once: see [What the body did with her message](#what-the-body-did-with-her-message).

### A second call (`follow_up`)

Added 2026-10-02. After a message of hers she waits a few minutes (three by default) and observes: did the owner write or speak, and what did the body do with the message. If no answer came she thinks again and may, entirely as her own decision, call **once more**, in words she writes then — or look at the room first, or let it go.

- A second call arrives **exactly like a first one**: `presence.reachOut` changes, and `GET /v1/initiatives` returns it with `kind: "reach_out"` and `reason: "follow_up"`, `expression: "curious"`. Show and speak it by the same rules as any reach-out, and report its delivery the same way.
- There is at most one per message and at most three an owner-local day; it is not made once the owner has written or spoken.
- **Do not speak into an empty room on the server's account.** The body is not asked to treat a `follow_up` differently when the PC looks idle: it applies its own rule (for example showing the bubble silently, or not showing it), and reports `away`. She is told that, and decides what to do next herself.
- A look she takes between the two messages is an ordinary [look in her own time](#a-look-in-her-own-time).

## What the body did with her message

`POST /v1/body/reach-outs/{id}/delivery` (added 2026-10-02). `{id}` is the message's `id` from `GET /v1/initiatives` (the same value as `presence.reachOut.latestId`).

```json
{ "scopeKey": "owner", "outcome": "shown_spoken" }
```

| `outcome` | The body sends it when |
| --- | --- |
| `shown_spoken` | It showed the bubble and spoke `content`. |
| `shown` | It showed the bubble and did not speak (sound off, or it chose to show silently). |
| `away` | It did not show it because the owner is away from the PC (idle). |
| `hidden` | It did not show it because her window is hidden or minimised. |
| `muted` | It did not show it because 「話しかける」 is switched off on the body. |

- Send it **once per message, as soon as the body knows** — ideally within a few seconds of seeing the message, and in any case inside her wait (three minutes by default). A report that arrives later is stored but she has by then thought without it: no report in time means she knows only that the body said nothing (`unknown`): it may be off, not connected, or not showing her window.
- No other field is accepted: there is no text field, and the request is refused with `400` if one is sent. `outcome` outside the five values is `400`.
- Only a device that has registered with `PUT /v1/body/capabilities` may report (`403 REACH_OUT_NOT_A_BODY` otherwise). The device is taken from its token.
- Idempotent per device: the first report is stored (`"status": "stored"`); the same outcome again answers `200` with `"status": "duplicate"`; a different outcome from the same device answers `409 REACH_OUT_ALREADY_REPORTED` and changes nothing. If the body first shows silently and speaks later, report what it had done when it first reported. Two bodies may each report; the one that got furthest stands (`shown_spoken` over `shown` over `away` over `hidden` over `muted`).
- The answer is `200`: `{ "schemaVersion": 1, "id": "0b6f…", "status": "stored" }`. Nothing is said in return, no model is called, and nothing is added to a conversation.

| Status | `error` | Meaning | Retry |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | `outcome` missing or not one of the five; another field present; `scopeKey` missing. | With a corrected body |
| 403 | `REACH_OUT_NOT_A_BODY` | The device has not registered capabilities. | After `PUT /v1/body/capabilities` |
| 403 | `BODY_INGEST_DISABLED` | Body events are switched off on the server. | No |
| 403 | `REACH_OUT_REPORTS_DISABLED` | The server has her second calls and observing switched off (`SHANNON_AUTONOMY_MAX_FOLLOW_UPS=0`); nothing is stored. | No; keep showing messages |
| 404 | `REACH_OUT_NOT_FOUND` | Unknown id, or an initiative that is not a message she started on her own. | No |
| 404 | `NOT_FOUND` | A server that does not take delivery reports, or a malformed path. | No |
| 409 | `REACH_OUT_ALREADY_REPORTED` | This device reported another outcome for this message. | No |
| 410 | `REACH_OUT_EXPIRED` | The message is more than 24 hours old. | No |

What the server does with it: it stores the outcome (`reach_out_deliveries`: scope, message id, device id, outcome, time). Her activity loop reads it once, after its wait, as one of a few facts she may think about — together with whether her window is showing (a registered body read presence in the last 30 seconds), the newest `ownerAway` / `ownerReturned` event of the last hour, and whether others are present. So keep sending `ownerAway` and `ownerReturned` events and keep polling presence only while her window is visible: these are what tell her whether he is there. A body that never reports works as before; she then knows less.

## `PUT /v1/body/capabilities`

The body registers what it can express. One registration per device and scope; a later one replaces it.

```json
{ "scopeKey": "owner", "expressions": ["smile", "wink_left"], "gestures": ["stretch"], "flags": { "shoulders": true, "tears": true } }
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `expressions` | array of at most 64 ids | yes | |
| `gestures` | array of at most 32 ids | yes | |
| `flags` | object of at most 16 `id: boolean` | no | For example `shoulders`, `tears`. `camera: true` says the owner has switched the camera on. |

An id is 1–40 characters of `[A-Za-z0-9_.-]`, starting with a letter or digit, without repeats in a list. No names in Japanese, no descriptions, no other field. The answer is `200` with the stored registration and `updatedAt`.

The registration is stored and returned in `presence`. One flag is read by the server: `camera`. Nothing else of the registration is in any prompt, so Shannon does not yet know which expressions and gestures her body has.

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

## Looking at the room

Owner decision (Syzygy ADR-0002 addendum, 2026-10-02). Shannon may take **one look** at the room through the body's camera: one JPEG frame, only while her window is visible. Stage 1: in a conversation with the owner alone, by text or, since 2026-10-02, by voice (see [A look in a voice call](#a-look-in-a-voice-call)). Stage 2: also in her own time, a few times a day (see [A look in her own time](#a-look-in-her-own-time)). The server asks through `presence`; the body answers with `POST /v1/body/looks/{id}`. `services/api/src/bodyLookContract.ts` holds the bounds, `bodyLook.ts` the rules.

### Order of one look

1. The body registers `flags.camera: true` with `PUT /v1/body/capabilities` while the owner has the camera switched on, and `flags.camera: false` (or no `camera` flag) when it is off. It reads `GET /v1/body/presence` **only while her window is visible**: the server takes a presence read in the last 75 seconds as "the window is showing" for a look in conversation (it was 30 until 2026-10-02; `SHANNON_BODY_LOOK_PRESENCE_FRESH_SECONDS`, 10–300), and in the last 30 seconds for a look in her own time. **Keep polling presence during a voice call**: a body that stops reading presence while a call is running reads as "her window is not showing", and she will say so. Because the window is now wider than one missed poll, the body's own refusal with `window_hidden` is what keeps a hidden window from being looked through.
2. In a `POST /v1/chat` turn whose applied `audience` is `owner`, the conversation model is offered the look and may choose it. The chat reply returns at once (she may say she will take a look). No keyword starts a look, and a look the model asks for without the offer is ignored. In a voice turn the choice is made differently; the body sees the same `look`.
3. The next presence read **of the device with the camera** carries `look`:

   ```json
   { "look": { "id": "0b6c1f0e-5a47-4d0c-9d1c-7a2f6f1f0a11", "requestedAt": "2026-10-02T03:00:00.000Z", "expiresAt": "2026-10-02T03:00:30.000Z" } }
   ```

   `look` is part of the snapshot, so it changes the `etag`. It is `null` when nothing is asked, for every other device, and again once the look is answered or expired. The field is absent while looks are switched off on the server.
4. The body shows its badge, takes one frame, and answers before `expiresAt` (30 seconds after `requestedAt`). It keeps no copy of the frame.
5. The server shows the frame to the conversation model once and drops it. What she says arrives as her next message in the same Talk (see [How her message reaches a client](#how-her-message-reaches-a-client)).

There is at most one open look per scope. While a text or voice turn happened in the last 60 seconds, or a look is open, `pollAfterSeconds` is **3** instead of 10; the body should accept 3–10.

### A look in a voice call

Added 2026-10-02 (owner: 「カメラ使っていいよ、自由に」). **Nothing new is on the wire**: the look appears in `presence` and is answered with `POST /v1/body/looks/{id}` exactly as above. What differs is when it appears and what the body is doing at that moment.

- It is opened by a voice turn (`POST /v1/voice/…/delegations` with `participantMode: "owner"` and nobody else listening) in which the owner asks her to look (「僕のこと見れる?」「カメラ使っていいよ」「部屋を見て」) or the decision gateway judges that a look is welcome. Her spoken reply to that turn only says that she will look (「見てみますね」). The look is opened when that reply has been written, so it is in `presence` while the body is still speaking it.
- The conditions are those of a text turn. A voice turn sent with `participantMode: "guest"` (a stream, 「友人も一緒」), or an owner turn with `companionPresent`, never opens a look and ends one in progress (`409 LOOK_ALREADY_ANSWERED` for a late answer); when asked, she says that she does not look with other people present.
- When she cannot look she is given the server's own reason and says it: no body registered its capabilities, `flags.camera` is not true, no presence read from the camera device in the last 75 seconds, a look already open, the hourly or daily limit, looks switched off. She no longer has to guess, so a wrong reason now points at one of these facts.

What the body must check for a call:

1. It keeps reading `presence` while a call is running, on the device that registered `flags.camera: true`, and follows `pollAfterSeconds` (3 for a minute after every voice turn).
2. It takes the frame and answers while its own reply audio is playing or the microphone is open; a look must not wait for the call to end (it expires 30 seconds after `requestedAt`).
3. It speaks `message.text` of the answer **in the call**, after the reply it is speaking, as her next utterance: queued behind the current speech, not dropped because a call is active and not interrupting her. The text is already stored in the Talk of the call (`message.threadId` is the call's thread) and must not be sent again as a voice turn (`/v1/voice/…/turns`), or it would be stored twice.
4. It registers that utterance with its echo guard as her own speech, so that the microphone hearing it does not come back as an owner utterance.
5. A `message` of `null` is silence: a look she chose herself that did not happen leaves no line.
6. If the call runs on another device (the iPhone) while the body only shows her, the body still receives the look and the answer; whether it speaks the line then is the body's choice. The iPhone gets the message as a push and in the Talk, not in the call audio.

The next voice turn replays the stored message as history, so she knows what she said about the room whichever device spoke it.

### A look in her own time

Stage 2. Her activity loop may ask for a look too, at most 3 times an owner-local day (`SHANNON_AUTONOMY_MAX_ROOM_LOOKS`), inside the same 6 an hour and 30 a day. **Nothing new is on the wire.** The differences the body sees:

- `look` may appear in `presence` **without a conversation turn before it**. The server asks only while a device with `flags.camera: true` read presence in the last 30 seconds and the owner has not written or spoken to her for 10 minutes. Treat it exactly like any other look: the badge, one frame, the same refusal codes, the body's own limits.
- The body polls every 10 seconds when nothing is happening, so it may first see the look up to 10 seconds after `requestedAt`. `expiresAt` is still 30 seconds after `requestedAt`: the body has at least 20 seconds to answer. Once it has read the look, `pollAfterSeconds` is 3 as for any open look.
- The answer of `POST /v1/body/looks/{id}` has `"message": null` for every `status`. What she saw is not a message: it becomes a note in her study, which the owner reads there, and which she may speak of later in a conversation with the owner (with other people present it is guarded like other personal information). The body must not show or speak anything for such a look, and nothing arrives through `/v1/conversation`, `/v1/initiatives`, or a push.
- The `POST` is still held while the model looks (up to 20 seconds).

### `POST /v1/body/looks/{id}`

Seen:

```json
{ "scopeKey": "owner", "outcome": "seen", "audience": "owner", "image": { "mediaType": "image/jpeg", "base64": "/9j/4AAQ…", "width": 960, "height": 540 } }
```

Not seen:

```json
{ "scopeKey": "owner", "outcome": "refused", "code": "camera_off" }
```

| Field | Type | Notes |
| --- | --- | --- |
| `outcome` | `seen` \| `refused` | No other top-level field than the ones listed for the outcome is accepted; there is no text field. |
| `audience` | `owner` \| `others` | `seen` only, required. The body decides it as for events. With `others` the frame is **dropped without being shown to the model** and the look is recorded as refused (`others_present`). The body should not send this: it should refuse with `others_present` before opening the camera. |
| `image.mediaType` | `image/jpeg` | Nothing else. |
| `image.base64` | standard base64, no `data:` prefix, no line breaks | The decoded JPEG is at most **400,000 bytes** (533,336 base64 characters). The bytes must start with the JPEG marker and contain a frame header. |
| `image.width` / `image.height` | integers, 1–960 / 1–1,920 | Must equal the size in the JPEG's own frame header. |
| `code` | see below | `refused` only, required. |

| `code` | The body sends it when |
| --- | --- |
| `camera_off` | The owner has the camera switched off. |
| `window_hidden` | Her window is hidden or minimised. |
| `busy` | The camera or the body is doing something else. |
| `no_camera` | No camera is attached. |
| `denied` | The operating system refuses camera access. |
| `failed` | The frame could not be taken or encoded. |
| `timeout` | The frame was not ready in time. (The server uses the same code for a look nobody answered.) |
| `others_present` | Stream output is on, the 「友人も一緒」 switch is on, or the body cannot tell that the owner is alone. The camera is not opened. |
| `rate_limited` | The body's own limit of 6 an hour and 30 a day, counted on looks actually taken. |

The JSON body of this route may be at most **535,384 bytes** (the largest frame in base64 plus 2,048 bytes for the other fields). Every other route keeps the 64 KiB limit.

The answer is `200`:

```json
{ "schemaVersion": 1, "id": "0b6c1f0e-…", "status": "seen", "message": { "id": "8f0f…", "threadId": "c1a2…", "text": "机の上にマグカップが見えます。", "initiativeId": "5d3e…" } }
```

| `status` | Meaning | `message` |
| --- | --- | --- |
| `seen` | The model saw the frame; `message.text` is what she says about it. | present |
| `refused` | The refusal was recorded. | her one honest line if the owner had asked her to look, otherwise `null` |
| `discarded` | A frame with `audience: others` was dropped unseen. | as for `refused` |
| `failed` | The frame arrived and no message came of it (the model call failed, or someone else joined the conversation meanwhile). | as for `refused`, or `null` |

The request is held while the model looks (up to 20 seconds); the answer is the fastest way for the body to learn what she said. Refusals of the request itself:

| Status | `error` | Meaning | Retry |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | A field is missing, out of bounds, or not allowed; the frame is not a JPEG, too large, or wider than 960. The look stays open. | With a corrected answer, before `expiresAt` |
| 403 | `LOOK_NOT_YOURS` | The look was given to another device. Only that device may answer. | No |
| 403 | `BODY_LOOK_DISABLED` | Looks are switched off on the server. | No |
| 404 | `LOOK_NOT_FOUND` | Unknown id. | No |
| 409 | `LOOK_ALREADY_ANSWERED` | The look was answered (or withdrawn) before. A look is answered once. | No |
| 410 | `LOOK_EXPIRED` | `expiresAt` has passed. | No |
| 413 | `REQUEST_TOO_LARGE` | Body above 535,384 bytes. | No |

### How her message reaches a client

Her message about a look is one ordinary assistant message, delivered the way she says anything on her own. A client learns of it in three places, and each names the look:

| Where | Field |
| --- | --- |
| The answer of `POST /v1/body/looks/{id}` | `message.text` (with `message.id`, `message.threadId`, `message.initiativeId`). The body can show and speak it at once. |
| `GET /v1/conversation?threadId=…` | An assistant message with `bodyLook: { "id": "<look id>", "outcome": "seen" \| "not_seen" }`, `content` = the text, `sourceExperienceId` = `initiative:<initiativeId>`. |
| `GET /v1/initiatives` | An unread message with `bodyLookId: "<look id>"`, `sourceTitle: "部屋を見た"`, `sourceURL: ""`, `expression: "curious"` (`"thinking"` for a line about a look that did not happen). The push worker sends it like any initiative. |

When the existing apps show it, without a change to them: the Mac app reads `GET /v1/initiatives` every 60 seconds and reloads the Talk, so the message appears within a minute. The iPhone receives it as a push notification (the banner carries a fixed line, 「ライ氏、部屋のことでひとことあります。」, never what she saw — owner decision 2026-10-02) and loads it into the Talk when the app next becomes active or the banner is opened; an iPhone that stays in the foreground on that Talk shows the banner but not yet the message. The body gets it in the answer of its own `POST`.

`not_seen` messages are fixed sentences (`bodyLookLines.ts`), one per reason, and exist only when the owner had asked her to look. A look she chose herself that did not happen leaves no message. A look that expired unanswered has no `POST` to return its line in; it arrives through the other two.

### What the body must do

- Camera off by default; the owner can switch it off at any time. Register `flags.camera` accordingly.
- One JPEG frame per look, at most 960 pixels wide and 400,000 bytes (about 100–200 KB is expected). Show the badge while the camera is open. Keep no image.
- Never open the camera while her window is hidden, a stream is live, or 「友人も一緒」 is on: refuse with the matching code.
- Keep its own limit of 6 an hour and 30 a day.
- Answer each look once. After `409`, `410` or `404`, drop the frame.

### What the server guarantees about the frame

- It is sent to a model provider **once** and then dropped: for a look in conversation, the conversation model, with a request the provider is asked not to keep (`store: false`); for a look in her own time, the model of her own activity (Gemini, with the dedicated autonomy key). It is never written to the database, a file, a log line, the conversation history, or a turn capture. `body_looks` holds identifiers, timestamps, an outcome and a code, and has no column for a frame or a description. For a look in her own time, her short text about it rests in `body_look_activity` until her activity loop takes it (seconds), and is then a note in her study, which she may use in her own thinking and recall in conversation.
- A frame is shown to the model only for a look opened in an owner text turn, an owner voice turn with nobody else listening, or by her activity loop through the gate, answered by the device it was given to, in time, with `audience: owner`. A text turn with `audience: others`, or a voice turn other people can hear, that arrives meanwhile ends the look: an unanswered one is closed, and what the model saw is not said.
- Limits on the server: 6 an hour and 30 an owner-local day (`Asia/Tokyo`), counted on looks for which a frame arrived (`SHANNON_BODY_LOOK_PER_HOUR`, `SHANNON_BODY_LOOK_PER_DAY`).
- Every look is in the activity record. In conversation: one entry (tool `body.look`), 「部屋を一度見ました。」 or 「部屋を見ませんでした（…）。」 with the code. In her own time: the gate's decision and one result (tool `study.look`, domain 「体のカメラで部屋を見る」), with the cost. No entry contains what she saw.
- The model is told, with the frame: that the person in view may be taken to be the owner and that she may speak of his appearance (owner decision 2026-10-02), not to say who any other person is or judge their appearance, not to read out or remember text on screens or documents, and not to put other people who appear into memory. Her message is display history: it has no user side and no completed-turn event, so no fact, relationship, promise, goal or person memory is extracted from it.
- Voice calls, the platform bridge, turns with `audience: others`, guests, and the activity loop never start a look.

## Errors

Body: `{ "error": "<code>", "message": "…" }`.

| Status | `error` | Meaning | Retry |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | A field is missing, out of bounds, or not allowed. `message` names it (`events[2].strength must be 0..1`). | No |
| 400 | `INVALID_REQUEST` | The body is not JSON. | No |
| 401 | `PAIRING_REQUIRED` | Missing or revoked device token. | After pairing |
| 403 | `BODY_INGEST_DISABLED` | Body events are switched off on the server (`POST /v1/body/events` only). | No; drop the events and keep polling |
| 404 | `NOT_FOUND` | Unknown path under `/v1/body/`, including `/v1/body/presence/stream`. | No |
| 403 / 404 / 409 / 410 | `REACH_OUT_…` | See [What the body did with her message](#what-the-body-did-with-her-message). | No |
| 405 | `METHOD_NOT_ALLOWED` | `PUT` anywhere but `/v1/body/capabilities`, or another method. | No |
| 413 | `REQUEST_TOO_LARGE` | Body above 64 KiB (535,384 bytes for a look answer). | No |
| 429 | `RATE_LIMITED` | More than 120 body requests from the device in a minute. | After a minute |

A refused or failed request must never stop the body from showing her.

## Server switch

`SHANNON_BODY_INGEST=off` (also `false`, `0`, `disabled`) on the API makes `POST /v1/body/events` answer `403 BODY_INGEST_DISABLED` and keeps already stored events out of conversation turns. Presence, capabilities and nudges keep working. It is an app setting: changing it needs a restart, not a deployment. Unset means on.

`SHANNON_BODY_LOOK=off` (same values) switches off looking at the room only: a look is never offered to the model, `presence` has no `look` field, and `POST /v1/body/looks/{id}` answers `403 BODY_LOOK_DISABLED`. `SHANNON_BODY_INGEST=off` switches looks off as well. `SHANNON_BODY_LOOK_PER_HOUR` (default 6) and `SHANNON_BODY_LOOK_PER_DAY` (default 30) set the server's limits. `SHANNON_BODY_LOOK_PRESENCE_FRESH_SECONDS` (default 75) is how recent the camera device's presence read must be for a look in conversation. `SHANNON_VOICE_ROOM_LOOK=off` switches off looks from voice turns only; text turns and her own time are unchanged.

## Not built

Deliberately, for this version:

- **A presence stream** (`GET /v1/body/presence/stream`, Server-Sent Events). The API's HTTP layer answers one JSON document per request; the only streaming route is the model-driven NDJSON reply of a voice turn, which lasts as long as one model call. Presence changes are written by other processes (the background worker and the activity loop) into SQLite, and nothing notifies the API process, so a stream would be a server-side polling loop held open against the 30-second request timeout and the reverse proxy. Polling with `etag` gives the same result with less machinery.
- **Any server-initiated push to the body.** The server holds no connection to the PC and has no address for it.
- **Sentence streaming for `/v1/chat`.** A text reply still arrives whole.
- **Per-moment generated nudges.** Stage 1 is fixed lines only: no model call, no cost, nothing about the moment sent to a model.
- **A reply, a feeling, or a memory from a touch.** Events do not change her stored emotion, are not remembered as experience, and do not start a turn.
- **Body awareness in the prompt, beyond the look.** The capabilities wording names one ability of the body: one look at the room, with its four rules. Telling her what else her body can do (from the registered capabilities) and letting a reply choose an expression or gesture are later changes to core that need the owner's approval.
- **Looking from a voice call, from the activity loop, or on her own schedule; more than one frame; any stored image.** Stage 1 is one frame in a text turn with the owner alone.
- **The `audience` field of `POST /v1/chat`.** It belongs to a separate change; this contract only reads it if present.
