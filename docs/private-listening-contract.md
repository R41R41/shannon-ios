# Private listening contract (v1)

Owner decision 2026-10-02: 「イヤホンをつないでいるとき（ボクにしか聞こえないとき）は、いつでも話しかけていい」.

"Privately listening" means that the sound of one of the owner's own apps comes out of something only he can hear. The app decides it; the server is told. The vocabulary and bounds are in `services/api/src/privateListeningContract.ts`, the routes in `privateListeningRoutes.ts`, the store in `privateListeningStore.ts`, and the contract test is `services/api/tests/privateListening.test.ts`.

Everything here is additive: routes and tables are only added, and two columns (`private_listening.speaks`, `reach_out_deliveries.surface`) are added to tables that already exist. One thing an existing route answers changes, and only while an app is privately listening: what her body is told about a message she started on her own (see [Her body](#her-body)).

## What "only he can hear" is

Decided on the device, by `ShannonPrivateListeningJudge` (`apps/ios/Sources/ShannonAppCore/Features/PrivateListening/`):

- **Wired headphones count without registration.** iOS: an output port of type `headphones`. macOS: the built-in device `BuiltInHeadphoneOutputDevice` (Apple silicon), or a built-in device whose output data source is `hdpn` (Intel). The system reports a headphone jack as headphones whatever is plugged into it, so speakers on the jack would count too: Settings has 「有線の出口をヘッドホンとして扱う」 (on unless the owner switches it off), and with it off a wired output is never private.
- **Bluetooth and USB devices count only when the owner registered that device.** The system cannot tell Bluetooth earphones from a Bluetooth speaker, so the owner registers his earphones in Settings while they are connected. The registry is matched by the device's identity, never by its name; iOS port UIDs are stored without their profile suffix (`-tacl`, `-tsco`), so the same earphones are recognised while a voice conversation uses the hands-free profile.
- **Everything else is not private:** the built-in speaker, the receiver, AirPlay, a car, a display, an aggregate or virtual device, and an empty route. With several outputs at once, every one must be private.
- **Other people present is never private.** While a voice conversation is in 「友人も一緒」, or the owner mentioned a companion, the app does not report private listening whatever the output is.
- **An app that cannot run does not report.** The iPhone app is suspended in the background, so it withdraws its report when it leaves the foreground, unless it stands by (see [iPhone standby](#iphone-standby)). The Mac app reports for as long as it runs, in front or not.

The registry is stored on the device (`UserDefaults`, `shannon.privateListening.earphones`: identity, name, date). It is not secret, and it never leaves the device: the server receives no device name and no identifier of the earphones.

## `POST /v1/private-listening`

`Authorization: Bearer <device token>`. Only a **paired device in the owner's scope** may call it. The device is taken from its token.

```json
{ "scopeKey": "owner", "kind": "mac", "listening": true, "speaks": true, "ownerActiveAt": "2026-10-02T03:00:00Z" }
```

| Field | Values |
| --- | --- |
| `kind` | `mac` \| `iphone` |
| `listening` | `true`: only he can hear this app now. `false`: no longer. |
| `speaks` | optional boolean, default `false`: the app would say a message of hers aloud now. The owner switched 「イヤホンのときは声で話しかける」 on in that app (off until he does). |
| `ownerActiveAt` | optional ISO 8601: when the owner last used that device, as the app saw it (macOS: the last keyboard or pointer input in any app; iPhone: now, while the app is in front). The server never takes it from the future and never moves it backwards within one run. |

No other field is accepted (`400`): there is no text field and no device name.

Answer to `listening: true`:

```json
{ "schemaVersion": 1, "listening": true, "kind": "mac", "since": "2026-10-02T03:00:00.000Z", "expiresAt": "2026-10-02T03:00:45.000Z", "pollAfterSeconds": 15,
  "speaks": true, "reachOut": null }
```

- **It is a heartbeat.** The app repeats the report every `pollAfterSeconds` (15). A report counts for 45 seconds (`expiresAt`); a device that stops reporting — the app was closed or force-quit, the network dropped, the Mac went to sleep — stops counting by itself. Nothing has to be cleaned up after a restart of the server: the table holds timestamps, and freshness is read from the clock.
- `since` is the first report of the current unbroken run. A gap longer than 45 seconds, or another `kind`, starts a new run.
- The app sends `listening: false` at once when the route changes to something that is not private, a friend joins, the iPhone app leaves the foreground, or the app is closing. The answer is `{ "schemaVersion": 1, "listening": false, "pollAfterSeconds": 15 }`. Saying it twice is harmless.
- While it is not privately listening the app sends nothing at all.
- While speaking is switched on on the server, the answer to `listening: true` also carries `speaks` (as stored) and `reachOut`: `null`, or `{ "id": "0b6f…", "createdAt": "…" }` when this app should say a message of hers now. See [Speaking a message she started](#speaking-a-message-she-started).

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | A field is missing, not allowed, or out of its closed set. |
| 401 | `PAIRING_REQUIRED` | Missing or revoked device token. |
| 403 | `PAIRED_DEVICE_REQUIRED` | The caller has no paired device (a fixed-token caller). |
| 403 | `PRIVATE_LISTENING_OWNER_ONLY` | The device is paired into another scope than the owner's (`SHANNON_OWNER_SCOPE_KEY`, default `owner`). A guest can neither set nor clear the owner's state. |
| 403 | `PRIVATE_LISTENING_DISABLED` | Switched off on the server. `listening: false` is still accepted. |
| 405 | `METHOD_NOT_ALLOWED` | Anything but `POST`. |
| 429 | `RATE_LIMITED` | More than 60 requests from the device in a minute. |

## Stored shape

`private_listening` (additive):

| Column | |
| --- | --- |
| `scope_key`, `device_id` | primary key: one row per paired device |
| `kind` | `mac` \| `iphone` |
| `since` | first report of the current run |
| `seen_at` | the last report; the row counts while this is at most 45 seconds old |
| `owner_active_at` | nullable |
| `speaks` | 0 or 1 |

Rows not reported for a day are deleted at the next report.

## Speaking a message she started

A message she starts on her own (`reach_out`, and its one `follow_up`) is written exactly as before: one assistant message in the Talk and one initiative, which the apps show and the phone is notified of. Nothing about when she may write one changes: at most three an owner-local day, never while a conversation is in progress, through the approval gate. What is added is that the message may also be **said aloud through his earphones**, and that exactly one surface says it.

### Which surface speaks

1. **An app that is privately listening and speaks.** When several are, the one whose device the owner used most recently (`ownerActiveAt`; a device with a known last use before one without; then the run that began later).
2. **Her body**, only when no app is privately listening and able to speak, and by its own rules as before.

3. **A call**, by the owner's decision of 2026-10-03, when he switched 「シャノンからの着信を受ける」 on in the iPhone app: when neither an app in his ears nor her body takes the message, the server rings his iPhone with it, once. See `docs/incoming-call-contract.md`. A message the call holds (`surface: iphone_call`) is offered to no app and not told to her body.

Whoever speaks first holds the message's **claim**: one row whose primary key is the message, so two devices asking at the same instant cannot both get it, and it survives a restart.

An app that gave a message back (`not_spoken`) is left out of the choice for that message: it is not offered it again, and it does not keep it from the other surfaces.

A message is spoken only while it is fresh: within **3 minutes** of being written (her own wait for an answer is three minutes). After that it stays text. It is never spoken once the owner read it, or wrote or spoke in any Talk after it: she does not speak over a conversation.

### Order of one message

1. The app's heartbeat is answered with `reachOut: { id, createdAt }`: only for the chosen app, only for the newest fresh, unread message nobody holds, and never after the owner wrote or spoke. While it is fresh, a message this app took and has not reported as spoken is offered to it again, so a claim whose answer was lost is not stuck; the app then says it if it never did, or answers with what it did, and never says a message twice.
2. The app takes it: `POST /v1/private-listening/reach-outs/{id}/claim`. The answer carries her words.
3. The app asks its own route again. If only he can still hear, it says the message in her voice (the speech stream of a voice conversation, the same pitch). If the earphones left meanwhile, a friend joined, a conversation began, or the first sound of her voice was not ready within 30 seconds of asking for it, it says nothing and reports `not_spoken`. A line is stopped two minutes after it was asked for, whatever state it is in.
4. The app reports `POST /v1/private-listening/reach-outs/{id}/delivery` with `shown_spoken` and opens the microphone for `listenSeconds`. A report that did not arrive is kept on the device and sent again with every heartbeat until the server has answered it, also after the app was closed and opened again, so a message that was said does not look unsaid.
5. **He answers:** on the iPhone the ordinary voice conversation runs on the Talk her message is in; on the Mac, which has none, his answer is transcribed and answered through the voice conversation's server path (`/v1/voice/gemini/cascade/delegations` and `/turns`, as her body does), her reply is spoken, and the microphone opens again. Either way the turns are stored as voice turns are. **He does not answer:** the microphone closes and nothing more is stored; her message stays in the Talk as it already was.

While she speaks, every change of the route is checked at once and the sound stops the moment the output is no longer private; a message cut short is reported `shown_spoken` (he heard part of it) and the microphone stays closed.

### `POST /v1/private-listening/reach-outs/{id}/claim`

```json
{ "scopeKey": "owner" }
```

```json
{ "schemaVersion": 1, "id": "0b6f…", "status": "claimed", "surface": "mac", "spoken": false, "listenSeconds": 8,
  "message": { "id": "0b6f…", "threadId": "…", "content": "ライ氏、いま何をしていますか。", "expression": "curious", "reason": "wonder", "createdAt": "2026-10-02T04:00:00.000Z" } }
```

`status` is `held` when the same device asks again (a lost reply), and `spoken` then says whether it already reported speaking. No other field is accepted, except `callId` from the iPhone that answered a call from her (`docs/incoming-call-contract.md`): the answer is then the same shape with `surface: "iphone_call"` and `listenSeconds: 0`, and the device does not have to be privately listening.

| Status | `error` | Meaning |
| --- | --- | --- |
| 403 | `PRIVATE_REACH_OUTS_DISABLED` | Speaking is switched off on the server. |
| 404 | `REACH_OUT_NOT_FOUND` | Unknown id, or an initiative that is not a message she started on her own. |
| 409 | `REACH_OUT_NOT_LISTENING` | The device has no fresh report with `speaks: true`. |
| 409 | `REACH_OUT_NOT_YOURS` | Another of the owner's devices is the one that speaks now. |
| 409 | `REACH_OUT_TAKEN` | Another surface holds the message. |
| 409 | `REACH_OUT_ALREADY_READ` | The owner read it in an app. |
| 409 | `REACH_OUT_ANSWERED` | The owner wrote or spoke after it. |
| 410 | `REACH_OUT_EXPIRED` | Older than 3 minutes. |

Plus the refusals of the report route (`PAIRED_DEVICE_REQUIRED`, `PRIVATE_LISTENING_OWNER_ONLY`, `400`).

### `POST /v1/private-listening/reach-outs/{id}/delivery`

```json
{ "scopeKey": "owner", "outcome": "shown_spoken" }
```

| `outcome` | The app sends it when |
| --- | --- |
| `shown_spoken` | It said the message through his earphones (the body contract's word for "shown and said aloud"). |
| `not_spoken` | It said nothing because private listening had ended. The claim is given back and this device is not offered the message again: another surface may take it while it is fresh, and the text delivery stands. |

- Only the device that holds the claim may report (`409 REACH_OUT_NOT_CLAIMED`). No other field is accepted: there is no text field.
- `shown_spoken` is stored in **the same table as her body's reports** (`reach_out_deliveries`), with `surface` naming the app (`mac`, `iphone`; a row of her body has none). The same report again answers `duplicate`. After it the claim is never given back (`409 REACH_OUT_ALREADY_REPORTED` to a later `not_spoken`), so nobody says the message again.
- The answer is `{ "schemaVersion": 1, "id": "…", "status": "stored" | "duplicate" | "released" | "ignored" }`. `ignored`: her observing is switched off (`SHANNON_AUTONOMY_MAX_FOLLOW_UPS=0`), so nothing was kept, and the claim still counts as spoken.

What she observes afterwards is what she observes after any message: whether the owner wrote or spoke (a yes or no and a number of seconds, from timestamps) and the delivery. For an app's report the fixed line names the device: 「イヤホンからの知らせ: Macのイヤホンで、ライ氏にだけ聞こえる声で伝えた。」 No answer inside her wait is, as before, 「返事はまだない」, and a second call is hers to decide.

### Her body

The body contract is unchanged for the body: it polls `presence`, reads `/v1/initiatives`, shows and speaks, and reports. What it is told changes in one case:

- A message an app holds is not in `presence.reachOut` and not in the `/v1/initiatives` answer **for a device that registered as her body**. The owner's apps see it as before. An app that took a message and was never heard from again (it was closed) keeps it from her body for 5 minutes after its claim; by then nothing is being said any more (a line ends at most two minutes after it was asked for), the message is at least that old, and the body's own rule for old messages applies.
- A fresh message nobody holds is withheld from her body **while an app is privately listening and speaks**; that app takes it at its next heartbeat. If it does not (the app was closed), her body is told once the app's report lapsed (45 seconds) or the message is no longer fresh.
- A fresh message nobody holds, with no app listening, becomes her body's **by the body's own read** (`surface: body`), so an app that starts listening a moment later does not say it a second time.
- A body that reports `away`, `hidden` or `muted` (it did not show the message) gives back the claim it holds itself, so an app in his ears may still say it. With two bodies, one body's report never gives back what the other holds.

### What a message may contain

Nothing about the wording of her message changes. When her body reports other people present, the message is written under the speak-time check as before, also while an app is privately listening: the same text is stored in the Talk and may be shown by the body if private listening ends. With the owner alone, it is written as for a conversation with him alone, as before.

## iPhone standby

On the iPhone, saying a message while another app is in front needs the Shannon app to be running. With 「ほかのアプリを使っている間も待機する」 switched on (off until the owner turns it on), and only while registered earphones or wired headphones are connected and nobody else is present, the app keeps a silent, mixable `playback` audio session alive (`ShannonStandbyAudio`), which the `audio` background mode lets it do. It plays silence: other audio is neither interrupted nor lowered, and the microphone is not open. Standby stops when the earphones disconnect, a switch goes off, or a friend joins; iOS then suspends the app, its report lapses, and nothing is said. It also does not run in Low Power Mode, while the server refuses the app's reports, or while the server has nothing to say through earphones (an older server, or `SHANNON_PRIVATE_LISTENING_REACH_OUTS=off`): it would only use battery. While reports fail for lack of a network it keeps running and the report is tried less often (15, 30, then 60 seconds). Force-quitting the app ends standby. There is no notification and no CallKit involved.

## Stored shape of a claim

`reach_out_claims` (additive):

| Column | |
| --- | --- |
| `scope_key`, `initiative_id` | primary key: one holder per message |
| `device_id` | the device that took it |
| `surface` | `body` \| `mac` \| `iphone` |
| `via` | nullable, added later: `call` for a claim the server took to ring the iPhone; such a claim is read as surface `iphone_call` |
| `claimed_at` | |
| `spoken_at` | nullable: set when the holder reported `shown_spoken`; from then on the claim is not given back |

`reach_out_declines` (additive): `scope_key`, `initiative_id`, `device_id` (primary key), `declined_at`. One row per app that gave a message back.

## Server switches

`SHANNON_PRIVATE_LISTENING=off` (also `false`, `0`, `disabled`) makes every `listening: true` answer `403 PRIVATE_LISTENING_DISABLED`, nobody counts as privately listening, and no app is given a message to say. Unset means on. It is an app setting: a restart applies it.

`SHANNON_PRIVATE_LISTENING_REACH_OUTS=off` keeps the state and stops the speaking: no heartbeat is answered with a message, a claim and a delivery report answer `403 PRIVATE_REACH_OUTS_DISABLED`, and her body is told about every message exactly as before this existed. Unset means on.

`SHANNON_PRIVATE_LISTENING_LISTEN_SECONDS` (default 8, 0–30) is how long the app keeps its microphone open after speaking. `0`: it speaks and does not listen.

On the device, both owner switches are off until he turns them on: 「イヤホンのときは声で話しかける」 (both apps) and 「ほかのアプリを使っている間も待機する」 (iPhone).
