# Body contract (v1)

What Shannon's body must send and may read. The body is the Live2D desktop application on the owner's Windows PC (facial expressions, idle gestures, shoulders, tears; it can be streamed through OBS). Her mind is this server. The body lives in another repository; this document and the contract test `services/api/tests/body.test.ts` are what it is built against. The vocabulary and bounds are in `services/api/src/contracts/bodyContract.ts`.

Everything here is additive: routes and tables are only added. Two changes of 2026-10-02 alter what an existing message does: a touch event now moves her feeling and is remembered (see [When she is touched](#when-she-is-touched)), and her capability description gained one line about her body (since 2026-10-06 ending 「体は自分のもの。触れられ方は自分で受け取る。」, Syzygy ADR-0005 owner answer 7). A change of 2026-10-05 alters one more: `callStarted` / `callEnded` from a body that only feels touch are stored instead of answering `ignored` / `touch_only`, and her voice requests may be refused with `409 OWNER_IN_CALL_ELSEWHERE` (see [When the owner is in a call elsewhere](#when-the-owner-is-in-a-call-elsewhere)).

The contract in one paragraph: the body **reports facts** (`POST /v1/body/events`), **polls a snapshot** of what to show (`GET /v1/body/presence`), **registers what it can express** (`PUT /v1/body/capabilities`), **reads fixed lines** it may show at a suitable moment (`GET /v1/body/nudges`), **answers one look at the room** when the snapshot asks for it (`POST /v1/body/looks/{id}`), and **says what it did with a message she started on her own** (`POST /v1/body/reach-outs/{id}/delivery`). It also **asks whether she says something when she is touched** (`POST /v1/body/reactions`). The server never calls the body and never generates a reply because of an event. Two routes call a model: the answer to a look, and a reaction to a touch; no other route here does.

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
| `region` | `head` \| `face` \| `side` \| `hand` \| `body` | touch types only, optional | Which part of her was touched (added 2026-10-03). A value outside the list is left out, not refused. See [Which part, and on which surface](#which-part-and-on-which-surface). |
| `part`, `side`, `gesture`, `input`, `reflex` | see [Touch vocabulary 2](#touch-vocabulary-2) | touch types only, optional | Added 2026-10-06. Send them only to a server that says `touchVocabulary: 2` or more; an older server refuses them with `400`. |

| Group | `type` | Extra fields |
| --- | --- | --- |
| Touch | `pet`, `tickle`, `poke`, `carry`, `holdHand` | `durationMs`, `strength`, `region`, and since 2026-10-06 `part`, `side`, `gesture`, `input`, `reflex` |
| Owner at the PC | `ownerAway`, `ownerReturned` | `minutesAway` |
| Plain | `callStarted`, `callEnded`, `windowHidden`, `windowShown`, `appStarted` | none |
| Game (her Minecraft body only, added 2026-10-05) | `game.died` | `cause` (required, a namespaced id such as `minecraft:lava`) |

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
| `ignored` + `reason: touch_only` | The device registered as a body that only feels touch and the event is not a touch. | No |
| `ignored` + `reason: not_game_body` | A game event from a device that is not her Minecraft body (`docs/minecraft-body-contract.md`). | No |
| `ignored` + `reason: game_only` | Her Minecraft body sent an event that is not a game event. | No |
| `ignored` + `reason: not_a_touch` | Its [touch vocabulary 2](#touch-vocabulary-2) fields name something that cannot be a touch: `gesture: hold` anywhere but the hand, or `input: hover` anywhere but the head and the hair (or with a gesture other than `stroke`). Added 2026-10-06. Only that event; the rest of the batch is taken. Answered so whatever its `id` was used for before. | No; it is a bug in the sender |

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
- `ownerAway` and `ownerReturned` are also read by her activity loop after a message of hers, as "he is away" / "he is back" (the newest of the last hour, whatever its `audience`). `callStarted` and `callEnded` tell another body that the owner is in a call on this device (added 2026-10-05; see [When the owner is in a call elsewhere](#when-the-owner-is-in-a-call-elsewhere)); a body's own call never counts for that. `windowHidden`, `windowShown` and `appStarted` are stored and used for nothing else yet.
- `game.died` is taken only from the device configured as her Minecraft body, in the owner's scope, and becomes one experience in fixed words (「ゲームの記憶: …マイクラで死んだ（溶岩）。」, source `body.game`). It moves no feeling, never enters the `[体に起きたこと]` block, and never stands in for who is at the PC. See `docs/minecraft-body-contract.md`.
- **「ゲームの体」** (her Minecraft body, core owner decision 2026-10-06) is identified by the `deviceId` of `SHANNON_MINECRAFT_BODY_JSON`, never by `PUT /v1/body/capabilities` (refused from that device with `403 GAME_BODY_CAPABILITIES_DENIED`). Only `game.*` events are taken from it; any other event answers `ignored` with `reason: game_only`. It is never counted in `othersPresent` (including the event fallback; its presence reads note no `audience`), in `ownerCallElsewhere`, among the full bodies a `409 OWNER_IN_CALL_ELSEWHERE` is for, or for a touch and its feeling, even with a registration stored before this rule. More games or bodies that need registering are decided later by adding a `kind`. Its token reaches only its own routes, `POST /v1/body/events` and `GET /v1/body/presence`; anything else answers `403 GAME_BODY_DEVICE_DENIED` (`docs/minecraft-body-contract.md`), and so does any request of it with `X-Shannon-Body` (it is never given a desktop-body identity; see [Her desktop body inside an app](#her-desktop-body-inside-an-app); `<its deviceId>.desktop-body` would still be the game body).
- **A touch event moves her feeling and is remembered** (owner decision 2026-10-02), exactly as a touch that arrives through `POST /v1/body/reactions` does, and each touch `id` counts once across the two routes: see [When she is touched](#when-she-is-touched). The other event types change nothing of her state.
- **No reply is produced by an event.** No model is called, no message is added to a conversation, and no notification is sent. She is free not to mention it in her next reply. Her words for a touch come only from `POST /v1/body/reactions`.
- Voice calls and the platform bridge do not receive the block.

## Audience

`audience` says who could see or cause the event, and the body decides it:

- `owner`: the owner alone at the PC, not streaming.
- `others`: anything else — an OBS stream or recording is live, someone else is at the PC, or the body cannot tell. When in doubt, send `others`.

On the Mac (roadmap A18 S5), while the owner has 配信用の出力（OBS） on, her desktop body sends `others` on its presence reads and events, refuses a look with `others_present`, and the app's figure in Talk reports its touches as `others`, as the Windows body does while its stream output is on. It is decided by the switch alone (not by whether a page is watching), with no hold after it is turned off. Meanwhile a Mac voice call is 「友人も一緒」 (`participantMode: "guest"`) and its `callStarted` / `callEnded` carry `others`, and the Mac reports that the owner is not privately listening. Nothing changes on the server.

An event with `audience: others` is stored and **never** added to the `[体に起きたこと]` block of a conversation, in any channel. The store reads events by audience, so the owner block cannot include one by mistake. A touch with `audience: others` still moves her feeling and is remembered (owner decision 2026-10-02: other people present make no difference to a touch); the cause the server keeps for that feeling then names no one. A text turn that is not for the owner alone (`audience` other than `owner` on `POST /v1/chat`, once that field exists) does not receive the block either.

What the server returns to the body is safe to show to others unless marked:

- `presence` carries the feeling's face and strength, never its cause. The cause is conversation text and stays in the app.
- `presence` carries how many stories await a reaction, never a title or text.
- A nudge with `audience: owner` must not be shown while a stream is live or someone else is present.

## `GET /v1/body/presence`

A read-only snapshot of what the body should show. Reading it changes nothing of her state. The server notes when each device last read it (in memory, and for a device that registered capabilities also as one timestamp per device in the database, at most every ten seconds), which is how it knows her window is showing.

`GET /v1/body/presence?scopeKey=owner[&etag=…][&audience=owner|others]`

`audience` is optional (added 2026-10-02): who can see or hear the body right now, decided as for events. The server keeps the latest value per device for 90 seconds and uses it for one thing: how guarded a message she starts on her own is. Send it on every read when you can tell; a body that does not send it is treated as before (the audience of its newest event of the last 30 minutes stands in; since 2026-10-05 only the events of a device registered with `PUT /v1/body/capabilities` as a full body, and never `callStarted` / `callEnded`, which the phone sends whatever its registration). Any other value is answered `400`. It is not part of the snapshot and does not change the `etag`.

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
  "reachOut": { "pending": 1, "latestId": "0b6f…" },
  "ownerCallElsewhere": { "active": false },
  "touchVocabulary": 2
}
```

`touchVocabulary` (added 2026-10-06) is a fact of the server, not of the snapshot: it is on every answer, also on an `unchanged` one, and it is not part of the `etag`. See [Touch vocabulary 2](#touch-vocabulary-2).

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
| `ownerCallElsewhere` | `{ active, since?, surface? }`; absent while switched off on the server | Added 2026-10-05. The owner is in a voice call with her on another of his apps. See [When the owner is in a call elsewhere](#when-the-owner-is-in-a-call-elsewhere). |

`doing` is `idle` unless the loop is running (enabled, not paused, reporting in, budget left) and its latest step was recorded within the last 3 minutes. Then: thinking about what to do next → `thinking`; reading a public page or a shared Notion page → `reading`; writing a note → `noting`; writing a story draft → `drafting`; revising → `revising`; marking a story 「見せてもいい」 or telling the owner → `showing`. Putting a draft away is `idle`. The body should treat an unknown `doing` or `expression` as `idle` / `neutral`.

The emotion source has one input from the body: a touch (a touch event, or a reaction request). Nothing else the body sends changes it. `mood` shows a touch within one poll; the answer of `POST /v1/body/reactions` carries the same face at once.

### Polling

There is no stream and no push (see [Not built](#not-built)). Poll every `pollAfterSeconds`: 10, or 3 for a minute after a text turn and while a look is open, or 5 while `ownerCallElsewhere.active` is true (the smaller wins).

- `etag` identifies the snapshot: everything except `schemaVersion`, `etag`, `changedAt`, `pollAfterSeconds` and `touchVocabulary`, which describe the answer and the server rather than what to show. Send the last one back as `?etag=<etag>`; when nothing changed the answer is short:

  ```json
  { "schemaVersion": 1, "etag": "3f9a1c0b7d2e4a68", "changedAt": "2026-10-02T03:00:00.000Z", "pollAfterSeconds": 10, "touchVocabulary": 2, "unchanged": true }
  ```

  It is a `200` with `unchanged: true`, not an HTTP `304`, and the value travels in the query and the body, not in `ETag` / `If-None-Match` headers.
- `changedAt` is when this server process first saw the snapshot with this `etag`. It restarts with the API process, so use it to order snapshots, not as a history.

## A message she starts on her own

Owner decision 2026-10-02 (話しかける): in her own time she may write the owner a short message (since 2026-10-03 with no count a day unless the owner sets one, at least five minutes apart), for one of four reasons — `share` (something she read or wrote), `wonder` (what he is doing), `upcoming` (something near in his calendar, promises or tasks), `saw` (what she saw in a look she just took). She does not do it while a conversation is in progress (a turn in the last 10 minutes). There are no quiet hours.

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
- Added 2026-10-02, and nothing for the body to do: while one of the owner's apps is privately listening (his sound comes out of registered earphones or wired headphones), that app says her message through his earphones instead, and the message is then absent from `presence.reachOut` and from the `/v1/initiatives` answer the body receives. Exactly one surface says a message. A body that reports `away`, `hidden` or `muted` gives the message back so that such an app may still say it. See `docs/private-listening-contract.md`.
- Added 2026-10-03, and nothing for the body to do: she may choose to phone the owner's iPhone with a message instead of writing it (`docs/incoming-call-contract.md`). Such a message is the call's from the moment she asks: it is absent from `presence.reachOut` and from the `/v1/initiatives` answer the body receives, also after he declined or did not answer. Only a call that could not ring gives the message back. Nothing rings for an ordinary message of hers, which reaches the body as before.

### A second call (`follow_up`)

Added 2026-10-02. After a message of hers she waits a few minutes (three by default) and observes: did the owner write or speak, and what did the body do with the message. If no answer came she thinks again and may, entirely as her own decision, call **once more**, in words she writes then — or look at the room first, or let it go.

- A second call arrives **exactly like a first one**: `presence.reachOut` changes, and `GET /v1/initiatives` returns it with `kind: "reach_out"` and `reason: "follow_up"`, `expression: "curious"`. Show and speak it by the same rules as any reach-out, and report its delivery the same way.
- There is at most one per message (and no count a day unless the owner sets one); it is not made once the owner has written or spoken.
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
| `surface` | `windows` \| `mac` \| `iphone` | no | Where this body is (added 2026-10-03). A value outside the list is left out, not refused; a later registration without it removes it. |

An id is 1–40 characters of `[A-Za-z0-9_.-]`, starting with a letter or digit, without repeats in a list. No names in Japanese, no descriptions, no other field. The answer is `200` with the stored registration and `updatedAt`, and (since 2026-10-06) `touchVocabulary`, the touch vocabulary this server takes (see [Touch vocabulary 2](#touch-vocabulary-2)); `touchVocabulary` is not part of the stored registration and is not in `presence.capabilities`.

Her Minecraft body never registers: from the device of `SHANNON_MINECRAFT_BODY_JSON` this route answers `403 GAME_BODY_CAPABILITIES_DENIED` (see [What the server does with an event](#what-the-server-does-with-an-event)).

The registration is stored and returned in `presence`. Two flags are read by the server: `camera`, and `touchOnly` (see [A body that only feels touch](#a-body-that-only-feels-touch)). Nothing else of the registration is in any prompt, so Shannon does not yet know which expressions and gestures her body has.

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

The lines are a **seed set of five, one per scene, awaiting the owner's review** (`services/api/src/surfaces/body/bodyNudges.ts`). `packages/cognition` holds no canonical list of short lines, so they were written in the voice of the existing fixed sentences (ボク, ライ氏, です・ます). Persona is core: changing or adding a line is the owner's decision.

## Looking at the room

Owner decision (Syzygy ADR-0002 addendum, 2026-10-02). Shannon may take **one look** at the room through the body's camera: one JPEG frame, only while her window is visible. Stage 1: in a conversation with the owner alone, by text or, since 2026-10-02, by voice (see [A look in a voice call](#a-look-in-a-voice-call)). Stage 2: also in her own time, with no count a day since 2026-10-03 (see [A look in her own time](#a-look-in-her-own-time)). The server asks through `presence`; the body answers with `POST /v1/body/looks/{id}`. `services/api/src/contracts/bodyLookContract.ts` holds the bounds, `bodyLook.ts` the rules.

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
- When she cannot look she is given the server's own reason and says it: no body registered its capabilities, `flags.camera` is not true, no presence read from the camera device in the last 75 seconds (she says that nothing has come from her body for a while: the window is hidden or the body is not running; the server keeps these reads in memory, so for up to one poll after an API restart this is said although the window is showing), a look already open, the hourly or daily limit, looks switched off. She no longer has to guess, so a wrong reason now points at one of these facts.
- If the conditions stop holding between the turn and her reply (the camera is switched off in those seconds), she has said 「見てみますね」 and no look follows in `presence`. One honest fixed line is stored in the Talk of the call and sent as an initiative (the Mac app and the iPhone show it); the body is not handed it, because there is no look for it to answer.
- Every look opened from a voice turn counts as asked for: when it fails, the answer of the body's `POST` carries her one honest line in `message`, and the body should speak it.
- **Store the voice turn promptly.** Her message about a voice look is written to the Talk after the turn that asked for it, so the server holds the answer of `POST /v1/body/looks/{id}` until the client has stored that turn with `POST /v1/voice/…/turns` (same `threadId`), for at most 8 seconds; after that the answer is given anyway and the Talk may then read out of order. A body that stores the turn when the delegation response completes (as the iPhone does), not after playback, never waits.
- **Recommended: send the utterance id on both requests.** `POST /v1/voice/…/turns` accepts an optional `utteranceId` (string, at most 120 characters; `400` otherwise; ignored when absent). Send the same value as `deviceContext.userUtterance.id` of the delegation of that turn: the server then knows the two requests as one turn by the id alone. Without it the turn is recognised by the Talk and the owner's words, which works when `userTranscript` and the delegation's `transcript` are the same utterance (differences of spacing and punctuation, or a tidied version of the raw text, are tolerated); if they differ more, her message simply comes after the 8 seconds.
- **A short 「見て」 after she offered.** When a turn mentions the camera and no look is taken, she is told that she could look and may say so. For 60 seconds after such a turn in the same Talk, a bare 「見て」「じゃあ見て」「うん、見て」 opens the look. The server keeps this as a fact about the turn, in memory; it does not read what she said.
- If the call is cut off after she began to say that she would look (the owner spoke over her), no look is asked for, and one fixed line (「話が途中になったので、いまは見ないでおきました。」) is stored in the Talk and sent as an initiative.

What the body must check for a call:

1. It keeps reading `presence` while a call is running, on the device that registered `flags.camera: true`, and follows `pollAfterSeconds` (3 for a minute after every voice turn).
2. It takes the frame and answers while its own reply audio is playing or the microphone is open; a look must not wait for the call to end (it expires 30 seconds after `requestedAt`).
3. It speaks `message.text` of the answer **in the call**, after the reply it is speaking, as her next utterance: queued behind the current speech, not dropped because a call is active and not interrupting her. The text is already stored in the Talk of the call (`message.threadId` is the call's thread) and must not be sent again as a voice turn (`/v1/voice/…/turns`), or it would be stored twice.
4. It registers that utterance with its echo guard as her own speech, so that the microphone hearing it does not come back as an owner utterance.
5. A `message` of `null` is silence (a look withdrawn because someone else joined).
6. If the call runs on another device (the iPhone) while the body only shows her, the body still receives the look and the answer; whether it speaks the line then is the body's choice. The iPhone gets the message as a push and in the Talk, not in the call audio.

The next voice turn replays the stored message as history, so she knows what she said about the room whichever device spoke it.

### A look in her own time

Stage 2. Her activity loop may ask for a look too. There is no count a day (owner decision 2026-10-03; it was 3): `SHANNON_AUTONOMY_MAX_ROOM_LOOKS` unset or `unlimited` means as often as the other conditions allow, `0` switches stage 2 off, and a positive number is a cap. Every look stays inside the same 6 an hour, her daily budget, and the gate. **Nothing new is on the wire.** The differences the body sees:

- `look` may appear in `presence` **without a conversation turn before it**. The server asks only while a device with `flags.camera: true` read presence in the last 30 seconds and the owner has not written or spoken to her for 10 minutes. Treat it exactly like any other look: the badge, one frame, the same refusal codes, the body's own limits.
- The body polls every 10 seconds when nothing is happening, so it may first see the look up to 10 seconds after `requestedAt`. `expiresAt` is still 30 seconds after `requestedAt`: the body has at least 20 seconds to answer. Once it has read the look, `pollAfterSeconds` is 3 as for any open look.
- The answer of `POST /v1/body/looks/{id}` has `"message": null` for every `status`. What she saw is not a message: it becomes a note in her study, which the owner reads there, and which she may speak of later in a conversation with the owner (with other people present it is guarded like other personal information). The body must not show or speak anything for such a look, and nothing arrives through `/v1/conversation`, `/v1/initiatives`, or a push.
- The `POST` is still held while the model looks (up to 20 seconds).

### A look through the app

Added 2026-10-02 (owner: 「アプリからも、これ見れる？って言ったら、シャノンが興味を持てばカメラで見てほしい」). **Nothing changes for the body.** The iPhone and Mac apps can be her eyes for the turn they send; this section is their contract (`services/api/src/contracts/appLookContract.ts`, `appLook.ts`).

1. A turn states what the app's camera can do now. `POST /v1/chat` and `POST /v1/voice/…/delegations` accept an optional top-level field:

   ```json
   { "appLook": { "state": "ready", "cameras": ["back", "front"], "platform": "ios" } }
   ```

   | `state` | The app sends it when |
   | --- | --- |
   | `ready` | It is in the foreground, camera access is granted, and 「会話中にシャノンがカメラで見る」 is on. |
   | `undetermined` | The same, but the system has not asked about the camera yet. The first ask brings the prompt. |
   | `background` | It is not on screen (iOS allows no camera then). |
   | `denied` | Camera access is refused or restricted. |
   | `no_camera` | The device has no camera. |
   | `switched_off` | The owner's switch is off. |

   `cameras` is a subset of `back`, `front` (a Mac reports its camera as `front`); `platform` is `ios` or `macos` and only chooses which fixed line says where to allow the camera. A voice turn may carry it inside `deviceContext` instead (`deviceContext.appLook`), which is where the apps put it. An absent or malformed field means "no app camera": the turn is exactly what it was. A 「友人も一緒」 turn (`participantMode: guest`) should not send it, and never opens a look if it does.
2. When she looks, the response of that turn carries `appLook: { "id": "…", "camera": "back" | "front", "expiresAt": "…", "lifetimeSeconds": 30 }` (text: the JSON response; voice: the final response, also in the `completed` event of the stream). `expiresAt` is 30 seconds after the ask, or 90 when the turn reported `undetermined` (the owner reads an explanation and answers the system's prompt first); `lifetimeSeconds` says the same relative to the ask, so the app counts from when the response arrived instead of trusting its clock against the server's. Her reply only says that she will look.
3. The app captures **one** frame with that camera without a tap, shows 「いま見ました」 with a small thumbnail, and answers, keeping no copy:

   ```json
   POST /v1/app/looks/{id}
   { "scopeKey": "owner", "outcome": "seen", "camera": "back", "image": { "mediaType": "image/jpeg", "base64": "/9j/…", "width": 720, "height": 960 } }
   { "scopeKey": "owner", "outcome": "refused", "code": "background" }
   ```

   The frame has the bounds of a body frame (JPEG, at most 960 wide, 1,920 high, 400,000 bytes; the request at most 535,384 bytes). `camera` is the camera that actually took it. Refusal codes: `background`, `denied`, `declined` (the system prompt was not yet answered and the owner chose not now), `no_camera`, `switched_off`, `busy` (the camera is in use by something else), `failed`, `interrupted` (he spoke over her or ended the call before the camera opened; nothing was captured). No other field is accepted; there is no text field.
4. The answer is `200` with `{ schemaVersion, id, status: "seen" | "refused" | "failed", message: { id, threadId, text } | null }`. `message.text` is her next message, already stored in the Talk (`message.id` is the conversation message). A text client appends it; a voice client speaks it behind the reply it is speaking and registers it with its echo guard (the apps wait at most 15 seconds for it; later it is in the Talk only). It is not an initiative and no push is sent. For a voice look the answer is held until the client has stored the turn (`POST /v1/voice/…/turns`), for at most 8 seconds.

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | A field is missing, out of bounds, or not allowed. The look stays open. |
| 403 | `LOOK_NOT_YOURS` | The ask was given to another device: only the device of the turn may answer. |
| 403 | `APP_LOOK_DISABLED` | `SHANNON_APP_LOOK=off`. |
| 404 | `LOOK_NOT_FOUND` | Unknown id. |
| 409 | `LOOK_ALREADY_ANSWERED` | Answered before. |
| 410 | `LOOK_EXPIRED` | The answer arrived after `expiresAt`; she has then said her one line about it, if she had announced the look. |

Rules of the server:

- **Which camera looks.** The surface the turn came from: an app that reports `ready` or `undetermined` is asked, and her body is not, even when it could look. An app that cannot capture leaves the turn to her body under the body's unchanged rules. When neither can and he asked, she says the app's reason.
- **When.** Asked (「これ見れる？」「見える？」) she looks: in a text turn the conversation model is told to choose the look whenever she is asked; in a voice turn his words count as a request when the decision gateway agrees, and 「これ見れる？」 said as the whole utterance counts even when no model tier answered. A request the gateway scores as not one is not decided beforehand; the reply is then told that she may look (not that she must), and looks only if she says so herself. 「見ないで」 offers nothing. For a remark about where he is or what is in front of him she looks if she is curious: the conversation model's choice in a text turn, the decision gateway's judgement in a voice turn.
- **Other people.** A look through the app is allowed with other people around (he aims the camera himself), when she is asked and (owner decision 2026-10-03) when she is curious, as when he is alone. In a voice turn with someone beside him a model tier has to agree (a look at least as likely as not): words alone open nothing. In an owner call the speakers are not told apart, so a companion who addresses her and asks can open one (accepted by the owner); the model that sees the frame is then given the turn itself and no other line of his Talk. A guest never opens one. Her body keeps its rule: the owner alone.
- **Her own announcement, and honesty (2026-10-03, after the production call of 2026-10-02 in which she announced a look that was never opened and then described what she had not seen).** In a voice turn from an app that can look, when nothing decided a look before the reply (the gateway gave no answer, did not trust the spoken transcript, or scored no look), her reply is told that she may look and that the words 「カメラで見てみますね」 open it. A reply opens the look after it is said when it announces the look non-past and affirmatively, outside a quotation: in those words, in others that name the camera as the means (「カメラを使って見てみますね」「カメラで確認しますね」), or, when his words asked her to look, by saying that she will look or check (「いま確認して、感想を伝えますね」). The past, a negation, a question, a quotation, and a reply about a note or a schedule open nothing. A text reply that announces it opens one too, whatever the structured field said. A turn in which he shares a photo himself is about that photo: it carries no offer and no guard. Every turn in which no look is opened tells her, as a fact, that this reply sees nothing, that she has seen nothing through the camera unless the Talk holds what she saw, and that she must not describe appearance as seen or say that she will look; a turn from an app that cannot look carries its reason whether or not he asks. If she says the opening words in a turn that cannot look, her one fixed line for that reason is stored in the Talk (`not_opened` when the reason has no line of its own). With someone beside the owner only a decision before the reply opens a look; her announcement opens nothing there, and such a turn is told only that this reply does not look (what she saw earlier is not replayed to it).
- **Count.** No hourly or daily limit. One look per turn, one open look per scope, and 5 seconds between two looks (`SHANNON_APP_LOOK_MIN_INTERVAL_SECONDS`, 0–600).
- **The frame.** Sent to the conversation model once with `store: false`, with the camera named; for the outer camera a person in view is not taken to be the owner. It is written to no table, file, or log. `app_looks` holds identifiers, timestamps, the camera, an outcome and a code. Her message carries the same `bodyLook` mark as a body look: it is display history (no fact, promise, or person memory is made from it) and is not replayed in a turn other people can see.
- **Not looking.** Her fixed lines (`appLookLines.ts`), one per reason: not on screen, no permission (with where to allow it), not now, no camera, switched off, camera in use, could not capture, interrupted before the camera opened (the line of a cut-off look), not answered in time, the model could not see, and (server only, `too_soon`) another look was just taken or still open when she had already said she would look. A look she chose herself that fails says nothing unless her reply had said she would look.
- **Record.** One entry in the activity record per look (tool `app.look`), without what she saw.
- **Switch.** `SHANNON_APP_LOOK=off` (also `false`, `0`, `disabled`): never offered, the voice gateway is not asked, nothing she says opens a look, and the answer route replies `403`. The honesty lines stay: a turn from an app is told that the feature is switched off and that nothing is seen, and an announced look gets her fixed line. Unset means on.

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
| `rate_limited` | The body's own limit of 6 an hour, counted on looks actually taken. (The server no longer counts looks per day; a body that still keeps its own 30 a day may go on sending this code for it.) |

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
| `GET /v1/initiatives` | An unread message with `bodyLookId: "<look id>"`, `roomLook: true` (every inbox message carries `roomLook`, true also for her own messages about what she saw, `reach-out:saw:` and `reach-out:follow_up:seen:`, so a notice outside the Talk says only 「ライ氏、部屋のことでひとことあります。」; `roomLookSource.ts`), `sourceTitle: "部屋を見た"`, `sourceURL: ""`, `expression: "curious"` (`"thinking"` for a line about a look that did not happen). The push worker sends it like any initiative. |

When the existing apps show it, without a change to them: the Mac app reads `GET /v1/initiatives` every 60 seconds and reloads the Talk, so the message appears within a minute. The iPhone receives it as a push notification (the banner carries a fixed line, 「ライ氏、部屋のことでひとことあります。」, never what she saw — owner decision 2026-10-02) and loads it into the Talk when the app next becomes active or the banner is opened; an iPhone that stays in the foreground on that Talk shows the banner but not yet the message. The body gets it in the answer of its own `POST`.

`not_seen` messages are fixed sentences (`bodyLookLines.ts`), one per reason, and exist only when the owner had asked her to look. A look she chose herself that did not happen leaves no message. A look that expired unanswered has no `POST` to return its line in; it arrives through the other two.

### What the body must do

- Camera off by default; the owner can switch it off at any time. Register `flags.camera` accordingly.
- One JPEG frame per look, at most 960 pixels wide and 400,000 bytes (about 100–200 KB is expected). Show the badge while the camera is open. Keep no image.
- Never open the camera while her window is hidden, a stream is live, or 「友人も一緒」 is on: refuse with the matching code.
- Keep its own limit of 6 an hour. A count a day is no longer asked of the body (owner decision 2026-10-03).
- Answer each look once. After `409`, `410` or `404`, drop the frame.

### What the server guarantees about the frame

- It is sent to a model provider **once** and then dropped: for a look in conversation, the conversation model, with a request the provider is asked not to keep (`store: false`); for a look in her own time, the model of her own activity (Gemini, with the dedicated autonomy key). It is never written to the database, a file, a log line, the conversation history, or a turn capture. `body_looks` holds identifiers, timestamps, an outcome and a code, and has no column for a frame or a description. For a look in her own time, her short text about it rests in `body_look_activity` until her activity loop takes it (seconds), and is then a note in her study, which she may use in her own thinking and recall in conversation.
- A frame is shown to the model only for a look opened in an owner text turn, an owner voice turn with nobody else listening, or by her activity loop through the gate, answered by the device it was given to, in time, with `audience: owner`. A text turn with `audience: others`, or a voice turn other people can hear, that arrives meanwhile ends the look: an unanswered one is closed, and what the model saw is not said.
- Limits on the server: 6 an hour, counted on looks for which a frame arrived (`SHANNON_BODY_LOOK_PER_HOUR`): the technical guard against a loop. There is no count a day (owner decision 2026-10-03; it was 30): `SHANNON_BODY_LOOK_PER_DAY` unset or `unlimited` means none, and a number sets one (`Asia/Tokyo` day). Her line 「今日はもうたくさん見たので、少し間をあけます。」 is said only where such a number is set, or when the body refuses with `rate_limited`.
- Every look is in the activity record. In conversation: one entry (tool `body.look`), 「部屋を一度見ました。」 or 「部屋を見ませんでした（…）。」 with the code. In her own time: the gate's decision and one result (tool `study.look`, domain 「体のカメラで部屋を見る」), with the cost. No entry contains what she saw.
- The model is told, with the frame: that the person in view may be taken to be the owner and that she may speak of his appearance (owner decision 2026-10-02), not to say who any other person is or judge their appearance, not to read out or remember text on screens or documents, and not to put other people who appear into memory. Her message is display history: it has no user side and no completed-turn event, so no fact, relationship, promise, goal or person memory is extracted from it.
- Voice calls, the platform bridge, turns with `audience: others`, guests, and the activity loop never start a look.

## When she is touched

Owner decision 2026-10-02 (「触ったり動かしたりしたのがバックエンドに届いてほしい。頭をなでたら『えへへ、なんですかライ氏？』のように反応できるように」), Syzygy ADR-0003 reflex layer. A touch reaches her mind: her **feeling moves**, she **remembers** it, and she **may say one line** — or stay silent and leave it to the face and gesture the body already shows. If the owner **answers her line aloud**, a conversation begins and only then is her line part of the conversation history. `services/api/src/contracts/bodyReactionContract.ts` holds the bounds, `bodyReaction.ts` the rules, and `services/api/tests/bodyReaction.test.ts` / `bodyReactionMemory.test.ts` the behaviour.

### `POST /v1/body/reactions`

```json
{ "scopeKey": "owner", "id": "7d1c0f1e-0001", "touch": { "type": "pet", "durationMs": 1500, "strength": 0.3, "ongoing": true },
  "audience": "owner", "occurredAt": "2026-10-02T06:00:00.000Z" }
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string, 1–80, `[A-Za-z0-9_.:-]`, starting with a letter or digit | yes | The body's idempotency key **and the id of this touch**. The finished touch is later sent through `POST /v1/body/events` with the **same `id`** (see [One touch, two messages](#one-touch-two-messages)). |
| `touch.type` | `pet` \| `tickle` \| `poke` \| `carry` \| `holdHand` | yes | |
| `touch.durationMs` | integer, 0–600,000 | yes | How long the touch has lasted when the request is sent. |
| `touch.strength` | number, 0–1 | no | Stored to two decimals. |
| `touch.ongoing` | boolean | yes | `true` while the touch is still going on. |
| `touch.region` | `head` \| `face` \| `side` \| `hand` \| `body` | no | Which part of her is touched (added 2026-10-03). A value outside the list is left out, not refused. |
| `touch.part`, `touch.side`, `touch.gesture`, `touch.input`, `touch.reflex` | see [Touch vocabulary 2](#touch-vocabulary-2) | no | Added 2026-10-06, only to a server that says `touchVocabulary: 2` or more. |
| `audience` | `owner` \| `others` | yes | Decided as for events. |
| `occurredAt` | ISO 8601 | yes | When the touch began on the PC. |

No other field is accepted, at the top level or inside `touch`, and there is no text field: a request with one is refused with `400`. The request is facts; nothing in it can be read as an instruction.

Only a device that registered with `PUT /v1/body/capabilities` may ask (a registration with `flags.touchOnly` is enough), and only in the owner's own scope (`SHANNON_OWNER_SCOPE_KEY`, default `owner`).

The answer is `200`:

```json
{ "schemaVersion": 1, "id": "7d1c0f1e-0001", "status": "said",
  "message": { "id": "5d3e…", "text": "えへへ、なんですかライ氏？", "expression": "bashful", "threadId": "c1a2…", "listenSeconds": 6 },
  "mood": { "expression": "bashful" } }
```

| Field | Values | Notes |
| --- | --- | --- |
| `status` | `said` \| `quiet` | `said`: she says `message.text`. `quiet`: she says nothing; `message` is `null`. |
| `message.id` | string | An identifier of this line. Not a conversation message id: the line is in no conversation yet. |
| `message.text` | at most 60 characters, one short sentence | Show it and speak it as it is. |
| `message.expression`, `message.feeling` | the `presence` vocabulary; `feeling` optional | The face for the line. |
| `message.threadId` | string \| `null` | The Talk a spoken answer would continue (the most recent one); `null` when she has no Talk yet. |
| `message.listenSeconds` | integer, 0–30 (default 6) | How long the body keeps its microphone open for his answer. |
| `mood.expression`, `mood.feeling` | the `presence` vocabulary | Her face **after** the touch (and after her line). Present for both statuses, so the body can show the feeling at once instead of waiting for the next presence poll. No cause is returned. |
| `ignored` | `not_a_touch`, absent otherwise | Added 2026-10-06. The request named something that cannot be a touch (see [Touch vocabulary 2](#touch-vocabulary-2)): the answer is `quiet`, and the touch moved no feeling, left no memory and called no model. Nothing is kept under the `id` and the request is not counted against the 12 a minute; the same request is answered the same way every time, whatever its `id` was used for before. |

What the body does:

- **`said`**: show the bubble and speak `message.text` with `message.expression`, then open the microphone for `listenSeconds` (see [If he answers](#if-he-answers)). `listenSeconds` applies whether or not the line was spoken aloud: a bubble-only line can be answered by voice. The server does not know or ask whether it was spoken.
- **`quiet`**: say nothing. Show `mood` and whatever gesture the body plays for the touch by itself. `quiet` is a valid answer of hers, and it is also what a late model, a failed model call, or a server without a model key produces.
- **Timing.** The server gives the model up 3.8 seconds after it took the request up (`SHANNON_BODY_REACTION_DEADLINE_MS`, at most 4.0) and answers `status: "quiet"`. An answer in about 1–2.5 seconds is expected and not yet measured against the real model. The body waits 4.5 seconds and discards anything later. A model answer that arrives after the server gave up is thrown away: it is not said, not kept as a pending line, and not remembered as something she said (its tokens are then not in the usage record either, because the call was aborted). The feeling and the memory of the touch stand either way. If the body discards a `said` answer because it arrived after its own 4.5 seconds, it sends nothing more: the line then waits unanswered and is dropped like any unanswered line, though the memory of the touch and the activity record say that she said it.
- **When to ask.** One request per touch, sent only while the owner's body setting "tell Shannon what happens to the body" is on (the same switch as events; the server has nothing to do for it). For a touch that goes on, ask about 1.5 seconds into it with `ongoing: true` (`pet` ≥ 1.5 s, `tickle` ≥ 1.2 s, `holdHand` ≥ 2 s); for a short one, right after it (`poke`; `carry` once she is put down; a short `pet` of ≥ 0.6 s at its end) with `ongoing: false`. At most one request in about 45 seconds, and none during a voice conversation, while waiting for a text reply, or while she is speaking. The server does not count touches per hour or day; its only limit is technical (12 reaction requests a minute per scope, inside the 120 body requests a minute per device).
- A request whose `occurredAt` is more than 2 minutes old is remembered (and, up to 10 minutes old, felt) and answered `quiet` without a model call. One that is more than 24 hours old or more than 5 minutes ahead of the server is answered `quiet` and not taken in at all, like an event `ignored` as `stale` or `future`.

Refusals:

| Status | `error` | Meaning | Retry |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | A field is missing, out of bounds, or not allowed. | With a corrected body |
| 403 | `BODY_REACTIONS_DISABLED` | Reactions are switched off on the server (`SHANNON_BODY_REACTIONS=off`). | No; keep sending events |
| 403 | `BODY_INGEST_DISABLED` | Body events are switched off on the server. | No |
| 403 | `BODY_REACTION_NOT_A_BODY` | The device has not registered capabilities. | After `PUT /v1/body/capabilities` |
| 403 | `BODY_REACTION_OWNER_ONLY` | The device is paired to a scope other than the owner's. | No |
| 409 | `BODY_REACTION_CONFLICT` | This `id` was already used for a reaction with different content. Nothing changed. | No; it is a bug in the sender |
| 429 | `RATE_LIMITED` | More than 12 reaction requests in a minute. | After a minute |

**Idempotency.** The same `id` with the same content returns the same answer (the same `message.id` and text) for 24 hours, without a second model call, feeling or memory. A retry that arrives while the first request is still being answered waits for that answer. The same `id` with different content is `409`. Retry on a network failure with the same `id`; do not retry after the 4.5 seconds have passed, because her line would then be late.

### One touch, two messages

The body asks for a reaction while a touch is going on and later reports the finished touch through `POST /v1/body/events` with its real duration. **Use the same `id` for both.** The server counts a touch id once:

- The first message with an id (whichever route it uses) is the touch: her feeling moves and it enters the memory.
- A later message with that id only brings the stored duration (the longer one) and strength of that touch up to date. It moves no feeling a second time and adds no second memory. In `POST /v1/body/events` it answers `stored` like any new event (the event table is separate from the reactions).
- An event whose id matches no reaction is a touch in its own right. So touches the body did not ask a reaction for (inside its 45-second spacing, during a conversation) still move her feeling and are remembered: send them as events. This holds for `audience: others` too.

### What a touch does to her

- **Feeling.** A touch is an input to her one emotion state, the same state conversation moves: the reducer event `body-touched` and the one table in `packages/cognition/src/touchEmotion.ts` (since 2026-10-06 not on the parts where her body flinches first: see [Where only the reflex moves her](#where-only-the-reflex-moves-her)). Being patted pleases her (`happy`, then `bashful` from the third pat of a sitting, `affectionate` from the sixth); tickling makes her giggle, then flusters her, then she is cutely cross; a poke surprises her, a second one makes her cross, and from the fourth she sulks; being carried flusters her; holding hands makes her shy, then affectionate. A firm or long touch is felt a little more. The continuous mood moves by at most 0.08 per value per touch and never past the row's mood, so any number of touches stays bounded. The feeling fades as every feeling does, on her awake clock (`docs/architecture.md`, emotional continuity): the reaction passes in minutes, and being patted or poked enough to please or annoy her leaves a mood for a few awake hours; while she is dormant nothing fades. What she feels now is not replaced by a touch (nor by her line about it) when an override holds it (safety, grief, emergency, accuracy) or when it is presently stronger than the touch's: she does not turn happy from one pat while she is very sad; only the mood moves then. A feeling that itself came from a touch always gives way to the next touch. A touch reported more than 10 minutes after it happened is remembered and moves no feeling.
- **Memory.** Touches of one kind that follow each other (each within 5 minutes of the last, for at most 30 minutes) are **one experience**, rewritten as it grows: 「体の記憶: 10月2日の午後、ライ氏に頭をなでてもらった（たくさん、6回、合わせて12秒ほど）。ボクは「えへへ、なんですかライ氏？」と言った。」 She can recall it later like any experience, the owner sees it in Memory (its evidence line is a token, `body-touch-…`, because the owner said nothing), and forgetting it there removes it from recall, from what the reaction model is told, and from being continued, together with replies whose prompt had recalled it; other memories and earlier conversation are untouched. With someone else around the memory does not say who touched her (「…、頭をなでてもらった。ほかの人も見ている時だった。」). Nothing from the microphone is stored here.
- **Words.** One small call of the conversation model (the model of the spoken reply; `chat` usage lane, never her own day's budget). It is told her one-line voice, the touch in plain words, her feeling, what happened to her body in the last half hour (counts, and the last three lines she said, so she does not repeat herself), who can hear, and, only with the owner alone and only while a conversation is in progress (a turn in the last 10 minutes), the last three lines of it. She chooses `say: false` freely.
- **Record.** One entry in the activity record for each line she says (tool `body.reaction`, 「体に触れられて（頭をなでられた）、ひとこと返しました。」), without her words. Silent reactions and plain events add none.
- **Others present.** She reacts in words in the same way while a stream is live or a friend is there. The reaction model is then told so, is given no line of the owner's Talk, no cause of her feeling, and of her earlier lines only those she said in front of others, and is told not to touch on the owner's personal matters. Send `audience: "others"` as for events.

### If he answers

After a `said` answer the body listens for `listenSeconds`.

- **He does not speak.** The body closes the microphone and sends nothing. Her line is in no conversation: not in a Talk, not in history, not learned from. It remains only in the memory of the touch as what she said. The server drops the pending line `listenSeconds` + 60 seconds after it was said.
- **He speaks.** The body starts its normal voice conversation, which goes on until its usual silence timeout; there is no special one-exchange mode. The **first voice turn** carries `reactionId` (the `id` of the reaction request), and `threadId` = `message.threadId` when that is not `null`:

  ```json
  POST /v1/voice/gemini/cascade/delegations
  { "scopeKey": "owner", "transcript": "なんでもないよ、えらいなと思って", "reactionId": "7d1c0f1e-0001", "threadId": "c1a2…" }
  ```

  The model that answers him receives her line as the assistant message directly before his words. When the body then stores the turn, it passes the same `reactionId`:

  ```json
  POST /v1/voice/gemini/cascade/turns
  { "scopeKey": "owner", "userTranscript": "なんでもないよ、えらいなと思って", "shannonTranscript": "ふふ、呼ばれた気がしたので。", "reactionId": "7d1c0f1e-0001", "threadId": "c1a2…" }
  ```

  The Talk then reads: **her line → his words → her reply**. Her line is stored once; later turns of the conversation send no `reactionId` (one sent again is ignored).
- **Windows.** The first voice turn that names the reaction must reach the server within `listenSeconds` + 60 seconds of the reaction's answer (he may speak for a while). Once a delegation named it, the stored turn may follow up to 10 minutes later. A body that only stores turns (`/v1/voice/realtime/turns`) may send `reactionId` there alone, inside the first window; her line is then stored before the turn but was not given to a model by the server.
- **An unknown, expired or already used `reactionId` is not an error**: the turn is handled as an ordinary one. Only a `reactionId` that is not a string is refused (`400`).
- **Guest mode** (the body runs voice with `participantMode: "guest"` while a stream is live or 「友人も一緒」 is on). `reactionId` is accepted on the delegation and **only supplies context**: her line precedes the speaker's words for the model. History and memory follow the existing rules of that call; nothing is written into the owner's Talk as an owner-alone turn. The same holds for an owner-mode turn stored with `companionPresent: true`, and for a line that was said with `audience: "others"`: the stored turn follows the companion rules and her line is not added to the Talk. The stored-turn route cannot tell a guest-mode call by itself: a body in guest mode must not send `reactionId` on `/turns` (or must send `companionPresent: true` with it).

## Which part, and on which surface

Owner decisions 2026-10-03 (「触った部位によって反応してほしい」「撫でたのか、つついたのかも」「どこで触ったのかも伝えたい」). Two optional facts, both closed vocabularies, both additive: a body that sends neither is told about exactly as before, and the server accepts the old and the new shapes side by side. `services/api/src/surfaces/body/bodyTouchWords.ts` holds the words.

- **`region`**: the part that was touched, at the same level as `type` on an event (`{ id, type, audience, occurredAt, durationMs?, strength?, region? }`) and as `touch.region` on a reaction request. `head` 頭, `face` 頬, `side` 脇, `hand` 手, `body` 体.
- **`surface`**: where the body is, at the top level of `PUT /v1/body/capabilities`. It is read for the device that sends a touch.

What changes is only what she is told, in three places. The way of touching and the part become one phrase:

| | `head` | `face` | `side` | `hand` | `body` | no `region` (as before) |
| --- | --- | --- | --- | --- | --- | --- |
| `pet` | 頭をなでられた | 頬をなでられた | 脇をなでられた | 手をなでられた | 体をなでられた | なでられた (text turn) ／ 頭をなでられた (reaction) |
| `poke` | 頭をつつかれた | 頬をつつかれた | 脇をつつかれた | 手をつつかれた | 体をつつかれた | つつかれた |
| `tickle` | 頭をくすぐられた | 頬をくすぐられた | 脇をくすぐられた | 手をくすぐられた | 体をくすぐられた | くすぐられた |
| `holdHand` | 手をつないでもらった, whatever the region | | | | | 手をつないでもらった |
| `carry` | 持ち上げて運ばれた, whatever the region | | | | | 持ち上げて運ばれた |

While a touch is going on the reaction prompt says なでられている／つつかれている／くすぐられている; duration and strength are worded as before (`ライ氏に頬をつつかれた（ほんの一瞬）`, `ライ氏に頭をなでられている（3秒ほど、やさしく）`). A touch memory says 頭をなでてもらった／頬をつつかれた／脇をくすぐられた.

1. **The `[体に起きたこと]` block** of an owner text turn. The heading names the surface of the touches in it: 「Windowsのデスクトップにいるボクの体にライ氏がしたこと」, 「Macのデスクトップにいるボクの体に…」, 「iPhoneのアプリの中のボクの体に…」; without a surface it stays 「PCに表示されているボクの体に…」. When touches from more than one surface stand in one block, the heading says 「ボクの体にライ氏がしたこと」 and each touch line ends with （Windowsで）／（Macで）／（iPhoneで）.
2. **The reaction prompt**: 「iPhoneのアプリの中のボクの体に、いま触れられた。」 (and the Windows and Mac forms; without a surface 「PCに表示されているボクの体に、いま触れられた。」), the touch line, and the lines of this sitting, each with its part.
3. **The memory of a touch**: 「体の記憶: 10月2日の午後、iPhoneのアプリの中で、ライ氏に頬をつつかれた（2回）。…」 (Windowsのデスクトップで、／Macのデスクトップで、; nothing without a surface).

Touches of one kind are still one memory, and one line of the reaction prompt; it keeps the part and the surface only while every touch of it named the same one. When they differed, the burst is told without a part (なでられた／なでてもらった, never the old 頭を…) and without a surface; a burst none of whose touches ever named a part keeps the wording from before parts existed. In the `[体に起きたこと]` block each way of touching, part and surface has its own line with its own count (at most three lines), so a count never puts one touch's part or place on another's; a fact from another surface in the same block — also 「席へ戻った」 from the PC beside a touch on the phone — makes the heading name no surface. A touch id that is reported twice (the reaction request, then the finished event) keeps what its first message said.

**The touch → feeling table is unchanged for these regions.** Her feeling still follows the kind of touch and how often (`packages/cognition/src/touchEmotion.ts`); the part reaches her words and her memory, through the prompt, and not the table. The cause the state sheet shows for a feeling keeps the table's own wording. The one exception, since 2026-10-06, is a touch whose [touch vocabulary 2](#touch-vocabulary-2) `part` is one where her body flinches first: see [Where only the reflex moves her](#where-only-the-reflex-moves-her).

Idempotency: `region` is part of an event's and a reaction's content only when it is sent, so a retry of a request that never named one answers as before.

## Touch vocabulary 2

Added 2026-10-06 (Syzygy ADR-0005 and its owner answers of 2026-10-05; phase 1a of the body-touch design). Five optional facts of a touch, beside `type` and `region`, on an event of a touch type and inside `touch` of a reaction request. `services/api/src/contracts/bodyContract.ts` holds the lists and the check, `bodyTouchWords.ts` the words of a part, and `services/api/tests/bodyTouchVocabulary.test.ts` the behaviour.

**Phase 1a stored these facts; phase 1b (2026-10-06) reads them in two places.** The reaction prompt tells her the part, the side, the gesture and what her body did, and a `part` where her body flinches first (neck, chest, waist, leg, skirt) moves her by the reflex alone instead of the table, with her own judgement of the touch as the reaction's `stance`: see [Where only the reflex moves her](#where-only-the-reflex-moves-her). Everything else is as in phase 1a: on any other part her feeling follows `type` and how often (the table), and the `[体に起きたこと]` block and the memory of a touch still come from `type` and `region`. A touch in the old shape is told, felt and answered exactly as before.

### The signal

`PUT /v1/body/capabilities` answers with `touchVocabulary`, and every `GET /v1/body/presence` answer carries it. This server says `2`. **A body sends the fields below only once it has seen `touchVocabulary` of 2 or more** from the server it is talking to; before that, and to a server that says nothing (it predates them and refuses an unknown field with `400`), it sends the old shape. Read it again after each registration and keep the latest value; a server that is rolled back stops saying it.

### The fields

| Field | Values | Meaning |
| --- | --- | --- |
| `part` | see the table below | The finer part that was touched. A value outside the list is left out, not refused, as for `region`; the touch still counts. |
| `side` | `left` \| `right` | Left or right **from her own view**, not the screen's. Only for a part that has two (cheek, shoulder, arm, hand, side, leg, and the like); leave it out otherwise. |
| `gesture` | `stroke` \| `poke` \| `tickle` \| `rest` \| `hold` \| `carry` | Stroked, poked, tickled (quickly back and forth), a touch that stays without moving, holding (the hand), carried. |
| `input` | `press` \| `hover` | Pressed and moved (dragged), or only passed over with the pointer, without a press. |
| `reflex` | `none` \| `flinch` \| `avoid` | What her body did by itself on the spot, as a fact: nothing, flinched a little, or turned away. The body does not judge a touch; it reports what it did. |

**Nothing in these fields refuses a request.** A word outside its list is left out, as an unknown `region` is, and the touch still counts, so that a body of a later vocabulary (or one talking to a server that was rolled back) never loses a batch, which may carry a `callStarted`. Only one thing is a `400`: any of the five on an event that is not a touch.

**The old fields win.** Where the new fields disagree with `type` and `region`, the new one is left out, so nothing that later reads them meets a contradiction:

- a `part` whose parent (the table below) is not the `region` sent is left out; without a `region`, the `part` stands;
- a `gesture` that is not sent with this `type` (see [What the body must send](#what-the-body-must-send)) is left out: `stroke` goes with `pet`, `poke` with `poke`, `tickle` with `tickle`, `rest` with `pet` or `holdHand`, `hold` with `holdHand`, `carry` with `carry`.

What is left out is not part of the content (see [Idempotency](#idempotency)).

Parts. The parts she may not want touched are sent **one by one** (owner answer 1 of 2026-10-05), so that she can be told the part itself.

| `part` | Word | Parent `region` | Group | Hit area on the model |
| --- | --- | --- | --- | --- |
| `head` | 頭 | `head` | ordinary | the present top-of-hair part |
| `hair` | 髪 (the ahoge too) | `head` | ordinary | Hair_Ahoge, Hair_Loop_* |
| `forehead` | おでこ | `face` | ordinary | Hit_Forehead |
| `cheek` | 頬 | `face` | ordinary | Hit_Cheek_L/R |
| `face` | 顔 (the rest; also a body that has only the eyes) | `face` | ordinary | the present face parts |
| `shoulder` | 肩 | `body` | ordinary | Hit_Shoulder_L/R |
| `arm` | 腕 | `body` | ordinary | the present sleeve parts |
| `hand` | 手 | `hand` | ordinary | the present hand parts |
| `belly` | お腹 | `body` | ordinary | Hit_Belly |
| `side` | 脇 | `side` | ordinary | Hit_Side_L/R |
| `neck` | 首 | `body` | not wanted | Hit_Neck |
| `chest` | 胸 | `body` | not wanted | Hit_Chest |
| `waist` | 腰 | `body` | not wanted | Hit_Waist |
| `leg` | 脚 | `body` | not wanted | Hit_Leg_L/R |
| `skirt` | スカート | `body` | not wanted | Hit_Skirt |
| `other` | 体 (the boots too) | `body` | ordinary | the rest |

### What the body must send

- **Keep `type` and `region` exactly as before**, on every touch, whatever else it sends. `type` stays required. `region` keeps its five words and is the part's parent from the table; **never put a new part name into `region`** (an iPhone app from before would read an unknown region as none and fill one in from the gesture: a stroke on the chest would become 「頭をなでられた」).
- `type` from `gesture`: `stroke` → `pet`, `poke` → `poke`, `tickle` → `tickle`, `hold` → `holdHand`, `carry` → `carry`, `rest` → `holdHand` on the hand and `pet` anywhere else.
- `part` from the hit area that was touched (the invisible hit-area parts of the 2026-10-05 model, matched by their drawn shape rather than by rectangles), `side` for a part that has two, `gesture` from the motion, `input: press` for a drag and `hover` for a pointer that only passes over, and `reflex` for what the body did on the spot.
- **Hover strokes only the head and the hair** (owner decision 2026-10-05): a pointer that passes anywhere else is not a touch and is not sent.
- The reflex itself (which parts make her flinch, how far she moves) is the body's, and its size is decided by watching the real app. The server only reads `reflex` as reported and, in this phase, stores it.
- Use the same `id` for the reaction request and the finished event, as before. The finished event may add what the request could not yet say (most often `reflex`): a field the first message left out is filled in; one it said is kept.

### What cannot be a touch

- `gesture: hold` on anything but the hand (`part: hand`, or, without a `part`, `region: hand`);
- `input: hover` on anything but the head or the hair (`part: head` / `hair`, or, without a `part`, `region: head`), or with a `gesture` other than `stroke`.

The check runs on the fields as kept, after unknown words and disagreeing pairs were left out (a `hold` sent with `type: pet` is a pet, not an impossible touch). Without a `part` or a `region` the place rules out nothing, but a hover with a gesture other than `stroke` is still impossible.

Such an event answers `ignored` with `reason: not_a_touch` and is not stored; the other events of the batch are taken as usual. Such a reaction request answers `200`, `status: quiet`, with `ignored: "not_a_touch"`; it moves nothing, writes nothing and is not counted against the reaction limit. Both routes answer so every time, also for an `id` that is already known (it is never a `conflict`), and what is stored for that `id` is unchanged. A touch in the old shape can never be one of these.

### Stored

`body_touches` (the one row of each touch id) has four more columns, added only: `part`, `side`, `gesture`, `reflex`, each the word as kept or empty. `input` is not stored. The event table (`body_events`) and the bursts (`body_touch_bursts`) are unchanged. All of it is closed words; nothing from a microphone.

### Idempotency

Each of the five is part of an event's and a reaction's content **only when it is kept** (sent, known, and in agreement with `type` and `region`), so a retry of a request in the old shape gets exactly the answer it always got, and an event stored before this change still answers `duplicate`. The same `id` sent again with another `part`, `side`, `gesture`, `input` or `reflex`, or without them, is a `conflict` (`409` for a reaction).

### Not in this phase

`presence.boundaries` (the parts she has decided to keep away from, for the body's reflex) is deliberately not part of phase 1a: it comes with her boundary memory in a later stage of ADR-0005. Presence has no `boundaries` field yet, and a body must not expect one.

### Where only the reflex moves her

Phase 1b (Syzygy ADR-0005 decisions 1, 2, 4 and 5; owner answers 1, 2 and 7 of 2026-10-05; 「シャノンに任せる」). Server only; no field and no route changed. `services/api/src/surfaces/body/bodyTouchReflex.ts` holds the parts and the stances, `bodyTouch.ts` and `touchEmotion.ts` the reflex, `bodyReactionPrompt.ts` her words, and `services/api/tests/bodyTouchReflex.test.ts` the behaviour.

- **The parts**: `neck`, `chest`, `waist`, `leg`, `skirt` (the "not wanted" group of the table above). For a touch that names one of them, by a reaction request or a plain event, the touch → feeling table is not read. Only the reflex moves her: the startle the table already has for an unexpected touch (its first poke, `surprised`), the same at every count, strength and length felt as for any touch; of the mood only arousal, and only upward (by at most the 0.08 of any touch); pleasantness and openness are not moved. Stroking there does not please her, and poking there does not make her sulk: nothing is decided for her either way. The cause names the part with the verb of the gesture, as the reaction prompt does (「ライ氏に首をつつかれた」, 「胸をなでられた」, 「胸に触れられた」 for a touch that rests). `holdHand` on such a part (with `gesture: rest`; holding is the hand's alone) is a hand resting there: she is told 「胸に触れられている」 and its cause is 「胸に触れられた」, never hand-holding.
- **What she is told** (reaction prompt, every touch that names a `part`): the part with its side from her own view and the gesture, as one phrase (「首をつつかれた」「左の脚をなでられている」「胸に触れられている」; `input: hover` adds 「なぞるように」); what her body did, when it reported it (`reflex: flinch` 「思わず小さく身を引いた」, `avoid` 「思わず身をそらした」); and one line: 「どう受け取るかは自分で決める。受け入れても、戸惑っても、嫌がっても、拒んでもよい。」 Nothing says how such a touch should feel, nothing forbids anything, and there is no sexual vocabulary. With other people present the rule for the room applies as before. A touch without a `part` gets the prompt of before, word for word.
- **Her answer**: a touch that names a `part` is answered with `stance` beside `say`, `text` and `feeling`: `welcome`, `fine`, `unsure`, `dislike` or `refuse`, how she took it. On the reflex parts the feeling she chose becomes her feeling also when she stays silent, as strong as the reflex was felt, so the answer's `mood` is her own face after the body's flinch (show it as before). She may choose any kind, `uncomfortable` (気持ち悪い・いや, added the same day, face `annoyed`) among them; none is automatic. On every other part a silent answer leaves the table's feeling, as before. `stance` is not sent to the body.
- **The deadline**: when the model is late, fails, or no model is configured, she is quiet and only the reflex moved her; no stance or feeling is filled in for her.
- **Her memory and this sitting**: a burst in which a touch landed on one of these parts (`body_touch_bursts.reflex`, added; also set when a finished event names the part only then) tells stroking and a resting hand as being touched, factually and with no favour in the verb: 「ライ氏に体に触れられた」, never 「なでてもらった」 or 「手をつないでもらった」; without a region 「触れられた」. Poking, tickling and carrying keep their words, and every other burst keeps the words it had. The burst keeps no part, so the part is not named there yet (stage 2). The `[体に起きたこと]` block of an owner text turn reads the part kept for the same touch id (`body_touches`): a stroke on such a part, or a hand resting on any part but the hand, is 「体に触れられた」 there too; a touch that kept no part is told exactly as before.
- **The result table** `body_touch_outcomes`: one row per reaction request whose touch was taken in (touch id, burst, audience, stance, chosen feeling, whether she spoke, when), never her words; stance and feeling stay empty without a judgement, the first row of a touch id stands, and a row goes with its touch (`BODY_LIMITS.retentionDays`). The part, side, gesture and reflex are on the touch's own row. Nothing reads it yet: it is the material of her boundaries (phase 3) and of the prediction of ADR-0006.
- **For the body**: nothing changes on the wire. The physics of the skirt and the after-face of the not-wanted group are the body's own phase 1c; the server moves no physics and asks nothing of it.

### Stage 2: her stance moves her (ADR-0006)

Syzygy ADR-0006 stage 2, candidate B (owner approval 2026-10-06; ADR-0005 owner answers 4 and 6). Server only; no field and no route changed. On under `SHANNON_PREDICTION` (default) while the prediction record exists (`SHANNON_PREDICTION_SHADOW` on); `off`, or no record (with a warning at start), gives everything above exactly. `packages/cognition/src/touchAppraisal.ts` holds the step, `services/api/src/mind/prediction/bodyTouchPrediction.ts` the key and the learning, and `services/api/tests/bodyTouchStage2.test.ts` the behaviour.

- **No table for any part.** A pat on the head no longer pleases her by itself. When a touch arrives, only the startle moves her: arousal rises by how unsure she was of what such a touch is for her (the relative uncertainty of key gesture.part.who; a first touch startles, a known one hardly does). The only feeling a touch brings by itself is surprise, as strong as the startle, and only when the startle stands out of her ordinary fluctuation.
- **Her stance is the outcome.** Every reaction asks her `stance`, also of a touch in the old shape. It is learned at once as the outcome of the key, and its prediction error moves her valence and arousal by the bounded step: the share 1 − γ (γ = 0.61, Rutledge et al. 2014) toward attractor + error + w_E × what she expected (w_E = 0.4375, the same paper's EV weight relative to its RPE weight), so nothing pins at ±1, a familiar welcome keeps her warm and a familiar refusal keeps her cool. The feeling she chose becomes her feeling (also when she stays silent), as strongly as her stance was unexpected (|error|). Taken the same way again and again, a touch moves her less (habituation); an unexpected one moves her again.
- **A touch she is not asked about** (a plain event, a late or failed model) is felt with the stance she gave for the same key within the episode she has learned (the boundary from her own gaps), against what she expects now, and is not learned again: only a stance she gives is an outcome, so one refusal followed by ten plain pokes stays one refusal. Without one, only the startle moved her.
- **What she is told, with the owner alone only**: their closeness (「ライ氏との親密さ: 0.42（経験で育つ気質。0〜1）」) and how she took touches on this part before (「これまで首に触れられた時のボクの受け取り: いや 2回、拒む 1回（新しい順に …）」, or that it is the first time). Facts, no rule. With others present, neither.
- **Her memory** keeps the part every touch of the burst named, in factual words (「ライ氏に首をつつかれた」); `body_touch_bursts.part` is added.
- **Words of favour** (「頭をなでてもらった」「手をつないでもらった」) only for a touch in the old shape (iPhone, Mac) that she took as `welcome` or `fine`. While her stance is not known, and for any other stance, the cause of her feeling and the memory of the burst tell it factually: by its region (「頭をなでられた」「頭に触れられた」) or, with none, 「なでられた」「手を握られた」「触れられた」.

### Next, outside this server

- **The Live2D body (Windows, and the embed page built from the same acting code)**: find the touched part by the drawn hit-area parts instead of rectangles (on the Live2D side: register the 14 hit-area parts in HitAreas, and decide whether the arm needs one), and send the five fields after seeing `touchVocabulary: 2`. What the body then does differently for the not-wanted group (its flinch, the face it adds afterwards, the skirt physics, when it asks) is a later phase of ADR-0005 and is decided with the owner first.
- **The iPhone embed host** (done 2026-10-06, phase 1d; see [A body that only feels touch](#a-body-that-only-feels-touch)): it passes `part`, `side`, `gesture`, `input` and `reflex` from the page through as they are, only after `touchVocabulary: 2`. `ShannonLive2DProtocol.sentRegion` fills in `head` for a `pet`, `hand` for a `holdHand` and `side` for a `tickle` only when the page names neither a region nor a `part`; with a `part`, the page's own `region` (the part's parent) is sent, and a missing one stays missing rather than become 頭.

## A body that only feels touch

Added 2026-10-03 (owner: 「アプリの中でも体を画面に。指で触るのも」). The iPhone app can show her Live2D figure
(`docs/live2d-embed.md`), and a finger on it is a touch. So that a touch there can reach her, the phone
registers as a body of one narrow kind:

```json
PUT /v1/body/capabilities
{ "scopeKey": "owner", "expressions": ["joyful", "…"], "gestures": ["wave", "…"], "flags": { "touchOnly": true } }
```

`flags.touchOnly: true` (`services/api/src/surfaces/body/bodyTouchOnly.ts`) says: this device feels touch and is nothing
else of a body. With it the device may use two routes exactly as the desktop body does, with the same
fields, limits, idempotency and audience rules:

- `POST /v1/body/reactions` (the registration is what lifts `403 BODY_REACTION_NOT_A_BODY`);
- `POST /v1/body/events` with the touch types (`pet`, `tickle`, `poke`, `holdHand`; the page has no `carry`), and, since 2026-10-05, `callStarted` / `callEnded` for a call on the phone itself (see [When the owner is in a call elsewhere](#when-the-owner-is-in-a-call-elsewhere)). Every other event type from such a device answers `ignored` with `reason: touch_only` and is not stored: the phone cannot write "he is back at the PC".

What a touch does to her is unchanged: her feeling moves, she remembers it, and she may say one line. The budgets are the shared ones: 120 body requests a minute per device, 12 reaction requests a minute and 2,000 stored events a day **per scope**, so touches on the phone and on the desktop body count together.

Everything else that a registration means for the desktop body does **not** apply to a touch-only device:

| What a full body's registration does | For a touch-only device |
| --- | --- |
| Counts as "a body is connected" when a look is refused (`no_camera` instead of `no_body`) | Not counted: with only the phone registered she still says her body is not connected. |
| `flags.camera: true` makes it the device a look at the room is given to | Not read: no look is ever given to it, whatever its flags say. Looking through the phone stays the separate app look. |
| A presence read marks "her window is showing" for her activity loop | Not marked. The phone does not read `GET /v1/body/presence` at all. |
| `audience` on a presence read, and the audience of its newest event, say who can see or hear her body | Not kept, and its events do not stand in: the audience of a phone touch describes that touch only. |
| May report what it did with a message she started (`POST /v1/body/reach-outs/{id}/delivery`) | `403 REACH_OUT_NOT_A_BODY`. |
| Its read of `/v1/initiatives` is "her body's own read" of a message (`docs/private-listening-contract.md`) | It is an ordinary app read: nothing is claimed for the body and nothing is withheld from the phone. |

What the phone does:

- Nothing is sent, and the device does not register, until the owner switches on
  「体に起きたことをシャノンに伝える」 (off by default, in 設定 › すがた only; until 2026-10-05 also on the body screen, which is now folded into Talk's dialogue display). With it off a
  touch animates in the page and stays on the device. Switching it off drops what was waiting to be sent.
  The registration itself stays on the server (there is no route to withdraw one); it grants nothing but the two routes above.
- It registers with `surface: "iphone"` and sends `region` with every touch: the page's own, or, from a page that names neither a `region` nor a `part`, what the gesture leaves no doubt about (a pet is on the head, a held hand is the hand, a tickle is on the side; a poke then has none). A page that names a `part` is never given a `region` from the gesture (since 2026-10-06, ADR-0005 phase 1d: a stroke on her chest is not her head).
- [Touch vocabulary 2](#touch-vocabulary-2) (since 2026-10-06, phase 1d): the page's `part`, `side`, `gesture`, `input` and `reflex` go on to the server unchanged, beside the old fields, on the event and inside `touch` of a reaction request, and only while the server's latest answer to the app's registration said `touchVocabulary` of 2 or more (her desktop body on the Mac also keeps the number of each presence read). A word outside the server's list is dropped on the device and never sent. To a server that says nothing every touch is exactly what it was before. A `400` to a touch that carried these fields makes the app register again: if the server now says less than 2 the same touch is sent once more in the old shape, otherwise it is dropped as before.
- It asks for a reaction at the page's moment (the timing of [When to ask](#post-v1bodyreactions), decided by the same acting code as on Windows), waits 4.5 seconds, and discards anything later. It reports the finished touch as an event with the same `id`.
- `audience` is `owner`, or `others` while someone else may be listening to a call (「友人も一緒」, or a companion the owner mentioned) and for five minutes after that ends.
- Her line follows the reply mode of the surface the owner is on (owner decision 2026-10-03):
  - **Text** — 「文字で返す」 (the default, 設定 › すがた), the scroll display of Talk, and anywhere her figure is not the dialogue display in front: the line is shown in a bubble near the figure for a few seconds and `mood` / `message.expression` go to the page's `express`. It is not spoken, no microphone opens, and the line stays out of every Talk.
  - **Voice** — 「声で返す」 while Talk's dialogue display with her figure is what he sees (Talk in front in the dialogue display, nothing over it: no sheet, cover, call screen or picker; this replaced "the body screen is up" when the body screen was folded into Talk, decision 2026-10-03, roadmap A6), the Live2D form, the owner alone (not inside the five-minute hold after someone else was listening), and nothing else holding the app's sound (a voice conversation, dictation, a call from her that rings or runs, one of her own messages being said): the bubble, and the line is spoken in her voice (the speech stream of a voice conversation, in the audio session category of her earphone messages), with her figure in the speaking phase and her mouth following the sound. Then the microphone opens for `listenSeconds` as an ordinary voice conversation on `message.threadId`. If he answers, the first delegation and the stored turn carry `reactionId` exactly as in [If he answers](#if-he-answers), and the conversation goes on in the call screen. If he does not, the call ends and nothing is stored. Without microphone permission she speaks and no window opens (the app never asks for the microphone from a touch). Her voice has to begin within 6 seconds of the answer, or the line stays a bubble; only a line said to its end is listened for. Leaving the dialogue display (switching to the scroll display, another page, or anything coming over it) or the app, switching to 「文字で返す」, switching 「体に起きたことをシャノンに伝える」 off, or choosing the Waterlight form stops her voice and closes the microphone at once. Her spoken line and its window count as a conversation for her own messages through the earphones: none is said over them. The session is prepared and given back through the earphone standby (`ShannonStandbyAudio.beginSpeech` / `endSpeech`): after a touch line the session's category is the standby's own (`.playback` mixing with other audio) when standby runs, and otherwise the session is deactivated and its previous category put back; a voice conversation and dictation set their own category when they start.
  - During a voice conversation the page asks for no reaction (its phase is not idle), as on the desktop body, and the call screen's figure takes no touch.
- The Mac app's figure beside Talk (roadmap A15) registers and reports touches exactly as the phone does, with `surface: "mac"`, only while 「体に起きたことをシャノンに伝える」 is on; it also registers (and reports nothing) while her desktop body is shown, which is how the Mac app says it is the Mac. Her desktop body on the Mac (A17) is a full body and has a device of its own: see [Her desktop body inside an app](#her-desktop-body-inside-an-app).
- Separately from touch, and whatever 「体に起きたことをシャノンに伝える」 says, the iPhone app (and, since 2026-10-06, the Mac app, through the same `ShannonVoiceCallPresence`) sends `callStarted` when a voice session was made and `callEnded` when the call ends or fails (`ShannonVoiceCallPresence`; audience `others` for a call that starts in 「友人も一緒」, fixed at the start of the call and used by the server for nothing: call events never stand in for who can see her body), so that her desktop body knows he is in a call there. An end that could not be sent is kept on the phone and sent again when the conversation view next becomes active; the end of a call the app was killed in is sent before the next call's `callStarted` (also one answered from the lock screen) or when the view next becomes active, stamped with the time this run first used the reporter (and at least 1 s before that next call's start), never with the moment it is sent, so it can never end a call that runs by then; a session made and then cancelled before the call began is followed by a `callEnded` of its own. See [When the owner is in a call elsewhere](#when-the-owner-is-in-a-call-elsewhere).

## Her desktop body inside an app

Added 2026-10-06 (roadmap A17, `services/api/src/surfaces/body/desktopBodyIdentity.ts`). The Mac app shows her standing on the desktop in a window of its own. That window is her **full body** (presence reads, who can see her, looks at the room, what it did with her messages, touches, who is at the Mac), while the app itself stays **one of the owner's apps** (Talk, his voice calls, private listening, the app look). The server's rules tell these apart by device (a full body's call is never "a call elsewhere" and its voice may be refused; an app's call quiets her other bodies and is never refused; a body's read of `/v1/initiatives` leaves out what an app says through his earphones), and one paired device cannot be both. So the body part speaks for a device of its own:

- A request with the header `X-Shannon-Body: desktop` on a body route (`/v1/body/*`; the app look's `/v1/app/looks/{id}` is not one and stays the app's) or on `GET /v1/initiatives` is taken as coming from the device `<deviceId>.desktop-body`, derived from the paired device of its token.
- Every other request, and every request without the header, is the app's exactly as before. A voice request with the header is still the app's.
- Only the Mac app has a desktop body: the body identity is derived only for a device that has said it is the Mac app (`SQLiteOwnerCallFacts.surface` is `mac`: its own registration with `surface: "mac"`, else its private-listening `kind`), and whose own registration, if any, is the Mac's. A device that has said nothing of itself, the phone, a Windows body (with or without a surface) and her Minecraft body are never given one; the header is then ignored and the request is the device's own. The Mac app therefore registers its own figure (`flags.touchOnly`, `surface: "mac"`) before its body's first read, while the desktop body is shown; that registration sends nothing of a touch by itself (touches are still reported only while 「体に起きたことをシャノンに伝える」 is on). The body identity registers only as a full body with `surface: "mac"` (anything else, `touchOnly` included, answers `400`).
- Nothing is authenticated differently. The token is the app's; it can speak only for the one body derived from its own device; unpairing the app ends both. A fixed-token caller has no body identity, and her Minecraft body's token is refused with the header (`403 GAME_BODY_DEVICE_DENIED`). As for every device, unpairing removes no registration: the body identity's row in `body_capabilities` stays (there is no route to withdraw one), grants nothing without a token, and a new pairing is a new device that registers a body of its own. Like any stale registration it can still count as "a body is connected" (and its last `flags.camera`) until it is removed from the database.

What follows, with no other rule changed:

| | The Mac app (`<deviceId>`) | Its desktop body (`<deviceId>.desktop-body`) |
| --- | --- | --- |
| Registration | Its figure in Talk, `flags.touchOnly`, `surface: "mac"` (only while touches are reported) | A full body, `surface: "mac"`, `flags.camera` as the owner set the body's camera |
| Its voice call (`callStarted`, a session, a turn) | **Counts as the owner in a call elsewhere** for the Windows desktop and for its own desktop body; **never refused** | Makes no voice request (the owner's answer to a touch line is the app's call) |
| `audience` on presence reads | Not read (it reads no presence) | **Kept**, and says whether others are present |
| `ownerCallElsewhere` in its presence | — | Active while the Mac app (or the iPhone) is in a call. A call on this Mac is known to the body at once (same app); a call on another device reaches it with its next presence read, so up to one poll (10 seconds, 5 while a call is known) passes before it falls silent: accepted latency, as there is no push to the body |
| Looks at the room, delivery reports, `ownerAway` / `ownerReturned` | Not a body | As any full body |
| `GET /v1/initiatives` | An app's read (its Talk and its earphones) | Her body's read (with the header). Before it has registered as her full body it is told of none of her messages (`presence.reachOut` is `{ pending: 0 }`) and claims nothing, never the app's unfiltered inbox |

The body counts on the per-device budget of 120 body requests a minute under its own identity. When the server took a request as the body's, its answer carries the response header `X-Shannon-Body: desktop`. A server without this rule ignores the header and answers without it: the window's requests would be the app's, and registering them would make the app a full body whose calls no longer count for the Windows desktop. So the Mac reads presence first and, without that header in the answer, never registers the window, sends nothing for it, and shows her there as a figure only (設定 › すがた says why).

## When the owner is in a call elsewhere

Added 2026-10-05 (production incident of that day: the owner was in a voice call with her on his iPhone and said 「お、シャノン、元気？」; the desktop body's wake listener heard his own 「シャノン」 at 10:34:34Z, started its own call, and then transcribed her iPhone speech from the phone's speaker as his turns). Additive: a body that does not read the field and does not expect the code works as before. `ownerCallElsewhere.ts` holds the rules.

```json
"ownerCallElsewhere": { "active": true, "since": "2026-10-05T10:34:02.000Z", "surface": "ios" }
```

| Field | Values | Meaning |
| --- | --- | --- |
| `active` | boolean | The owner is in a voice call with her on another device. Always present. |
| `since` | ISO 8601, only while `active` | When that call began (the earliest, if more than one). |
| `surface` | `ios` \| `mac`, only while `active`, optional | Which of his apps it is, when the server can tell: the device's own body registration (`surface: "iphone"` → `ios`, `"mac"` → `mac`), else what it reported for private listening (`kind`), else `ios` for a device registered for her calls (VoIP, only the iPhone app has one). Absent when none of these is known. |

**When a device is in a call.**

- **A device that reports its calls** (a `callStarted` or `callEnded` of its own in the last 2 hours): from its `callStarted` to its `callEnded`, the newest of the two on the device's own clock deciding (at the same instant the end wins). The iPhone app reports both for every voice conversation, as soon as the session is made and when the call ends (`ShannonVoiceCallPresence`), whether or not it reports touches. A `callStarted` whose `callEnded` never arrives stops counting **2 hours** after its `occurredAt`, or once the server has seen nothing of that device's voice (its `callStarted`, a session, a turn) for **30 minutes** (the app was killed mid-call). After its `callEnded`, the device counts again only for a voice session the server made after that end arrived (compared on the server's clock, so a phone clock that is off does not matter), until its next `callStarted` arrives. A device registered as a body that only feels touch (the phone) may send these two events (before 2026-10-05 they answered `ignored` / `touch_only`); so may any other paired device, registered or not (the Mac app reports its voice calls the same way since 2026-10-06, roadmap A16).
- **Any other device:** while the server sees its voice conversation with her — a session made (`POST /v1/voice/gemini/cascade/sessions`, noted only after it was made), a turn delegated (`POST /v1/voice/gemini/cascade/delegations`, `…/delegations/stream`), in owner or guest mode, or a call from her that it answered (`docs/incoming-call-contract.md`; from the moment of the answer) — until **3 minutes** pass without any of them. Sessions and turns are kept in the API process's memory: after a restart they are empty until the next turn (it fails open). This is the fallback for an app that predates the call events.

Never counted: **the device that reads presence** (its own call is not elsewhere), and **any device registered as her full body** (the desktop): a wake on the desktop never marks the owner as in a call. The Mac's desktop body is a device of its own (see [Her desktop body inside an app](#her-desktop-body-inside-an-app)), so the Mac app's own call does count, for the Windows desktop and for the Mac's body.

**What the body must do.** While `active` is true, keep the wake-name listener closed and start no call. Poll at the faster `pollAfterSeconds` (5). When it turns false, open the listener again.

**`409 OWNER_IN_CALL_ELSEWHERE`.** While the owner is in a call elsewhere, a voice request **from a device registered as her full body**, in owner mode (`participantMode` absent or `"owner"`), is refused:

| Route | Refused with |
| --- | --- |
| `POST /v1/voice/gemini/cascade/sessions` | `409`, before any session or token is made |
| `POST /v1/voice/gemini/cascade/delegations` | `409`, before anything is read or written |
| `POST /v1/voice/gemini/cascade/delegations/stream` | `409` as a plain JSON answer, before any NDJSON line |

```json
{ "error": "OWNER_IN_CALL_ELSEWHERE", "message": "The owner is in a voice call on another device." }
```

The body ends the turn silently. Nothing is stored for a refused request: no turn, no thread, no history, no reaction link, and the request does not count as the body's own call. Never refused: the iPhone and Mac apps (also with their own `callStarted`, and also while the desktop is in a call), a guest call (`participantMode: "guest"`), and a request whose device the server does not know (a fixed-token caller): when the device is missing the server does not block (fail open). The stored-turn route (`…/turns`) is not refused.

## Errors

Body: `{ "error": "<code>", "message": "…" }`.

| Status | `error` | Meaning | Retry |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | A field is missing, out of bounds, or not allowed. `message` names it (`events[2].strength must be 0..1`). | No |
| 400 | `INVALID_REQUEST` | The body is not JSON. | No |
| 401 | `PAIRING_REQUIRED` | Missing or revoked device token. | After pairing |
| 403 | `GAME_BODY_CAPABILITIES_DENIED` | `PUT /v1/body/capabilities` from her Minecraft body (`SHANNON_MINECRAFT_BODY_JSON`), which never registers. | No |
| 403 | `BODY_INGEST_DISABLED` | Body events are switched off on the server (`POST /v1/body/events`, and `POST /v1/body/reactions`). | No; drop the events and keep polling |
| 403 / 409 | `BODY_REACTION…` | See [When she is touched](#when-she-is-touched). | No |
| 404 | `NOT_FOUND` | Unknown path under `/v1/body/`, including `/v1/body/presence/stream`. | No |
| 403 / 404 / 409 / 410 | `REACH_OUT_…` | See [What the body did with her message](#what-the-body-did-with-her-message). | No |
| 405 | `METHOD_NOT_ALLOWED` | `PUT` anywhere but `/v1/body/capabilities`, or another method. | No |
| 409 | `OWNER_IN_CALL_ELSEWHERE` | A voice session or turn from her body while the owner is in a call on another of his apps. See [When the owner is in a call elsewhere](#when-the-owner-is-in-a-call-elsewhere). | No; end the turn silently and wait for `ownerCallElsewhere.active` to turn false |
| 413 | `REQUEST_TOO_LARGE` | Body above 64 KiB (535,384 bytes for a look answer). | No |
| 429 | `RATE_LIMITED` | More than 120 body requests from the device in a minute, or more than 12 reaction requests in the scope in a minute. | After a minute |

A refused or failed request must never stop the body from showing her.

## Server switch

`SHANNON_BODY_INGEST=off` (also `false`, `0`, `disabled`) on the API makes `POST /v1/body/events` answer `403 BODY_INGEST_DISABLED` and keeps already stored events out of conversation turns. Presence, capabilities and nudges keep working. It is an app setting: changing it needs a restart, not a deployment. Unset means on.

`SHANNON_BODY_LOOK=off` (same values) switches off looking at the room only: a look is never offered to the model, `presence` has no `look` field, and `POST /v1/body/looks/{id}` answers `403 BODY_LOOK_DISABLED`. `SHANNON_BODY_INGEST=off` switches looks off as well. `SHANNON_BODY_LOOK_PER_HOUR` (default 6) sets the server's limit an hour; `SHANNON_BODY_LOOK_PER_DAY` (default: none) may set one a day. `SHANNON_BODY_LOOK_PRESENCE_FRESH_SECONDS` (default 75) is how recent the camera device's presence read must be for a look in conversation. `SHANNON_VOICE_ROOM_LOOK=off` switches off looks from voice turns only; text turns and her own time are unchanged.

`SHANNON_OWNER_CALL_ELSEWHERE=off` (same values) removes `ownerCallElsewhere` from presence and refuses nothing with `OWNER_IN_CALL_ELSEWHERE`. Unset means on.

`SHANNON_BODY_REACTIONS=off` (same values) switches off everything a touch does beyond being stored: `POST /v1/body/reactions` answers `403 BODY_REACTIONS_DISABLED`, a touch (by either route) moves no feeling and leaves no memory, and `reactionId` on a voice turn is ignored. Events are stored and shown in the `[体に起きたこと]` block as before. `SHANNON_BODY_INGEST=off` switches reactions off as well. `SHANNON_BODY_REACTION_LISTEN_SECONDS` (default 6, 0–30) sets `listenSeconds`; `SHANNON_BODY_REACTION_DEADLINE_MS` (default 3800, 200–4000) sets when the server gives up waiting for the model.

`SHANNON_PREDICTION=off` (same values) switches off stage 2 of ADR-0006 for touches: see [Stage 2](#stage-2-her-stance-moves-her-adr-0006). Unset means on.

## Not built

Deliberately, for this version:

- **A presence stream** (`GET /v1/body/presence/stream`, Server-Sent Events). The API's HTTP layer answers one JSON document per request; the only streaming route is the model-driven NDJSON reply of a voice turn, which lasts as long as one model call. Presence changes are written by other processes (the background worker and the activity loop) into SQLite, and nothing notifies the API process, so a stream would be a server-side polling loop held open against the 30-second request timeout and the reverse proxy. Polling with `etag` gives the same result with less machinery.
- **Any server-initiated push to the body.** The server holds no connection to the PC and has no address for it.
- **Sentence streaming for `/v1/chat`.** A text reply still arrives whole.
- **Per-moment generated nudges.** Stage 1 is fixed lines only: no model call, no cost, nothing about the moment sent to a model.
- **A touch reaction in her own-time activity, in a text reply, or as a push.** Her line for a touch exists only in the answer of `POST /v1/body/reactions`; the apps do not receive it unless the owner answers it aloud. Touches other than the five kinds, and a reaction to the plain events (`ownerReturned`, `windowShown`, …), are not built.
- **Choosing a gesture.** The answer carries a face (`expression`, `feeling`) and words. Which gesture goes with them is the body's choice.
- **Body awareness in the prompt, beyond the look and the touch.** The capabilities wording names two things of the body: one look at the room, with its four rules, and that she feels a touch and may answer it. Telling her what else her body can do (from the registered capabilities) and letting a reply choose an expression or gesture are later changes to core that need the owner's approval.
- **Looking from a voice call, from the activity loop, or on her own schedule; more than one frame; any stored image.** Stage 1 is one frame in a text turn with the owner alone.
- **A look through the app in her own time, or without a turn.** The app looks only in the turn it sent; her three looks a day of her own stay with her body. A continuous camera view is not built either: one frame per look.
- **The `audience` field of `POST /v1/chat`.** It belongs to a separate change; this contract only reads it if present.
