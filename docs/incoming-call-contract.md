# Incoming call contract (v1)

Owner request 2026-10-03: 「イヤホンをつないでいるとき、アプリを起動していなくても、シャノンから話しかけていい」. iOS lets an app that is not running start sound only as an incoming call, and he approved that: 「シャノンからの電話はすてき。出るかどうかはボクが選ぶので問題ない」.

A call is a **surface** for a message she starts on her own (`reach_out`), like her body and the apps in his ears (`docs/private-listening-contract.md`). Nothing about when she may write such a message changes: at most `SHANNON_AUTONOMY_MAX_REACH_OUTS` an owner-local day, never while a conversation is in progress, through the approval gate. The message is written exactly as before (one assistant message in the Talk, one initiative, the ordinary notification). What is added: when no surface can simply say it, the owner's iPhone rings.

The vocabulary and bounds are in `services/api/src/incomingCallContract.ts`, the rules in `incomingCalls.ts`, the store in `incomingCallStore.ts`, the routes in `incomingCallRoutes.ts` and `serverIncomingCallRoute.ts`, the APNs sender in `voipPushSender.ts`, and the contract test is `services/api/tests/incomingCalls.test.ts`. On the iPhone: `apps/ios/Sources/ShannonAppCore/Features/IncomingCall/`. The Mac has no call screen and takes no part.

Everything is additive: two tables (`voip_push_registrations`, `incoming_calls`), one column (`reach_out_claims.via`), two routes, and one optional field (`callId`) on the existing claim route.

## Which surface says a message

1. **An app that is privately listening and speaks**, as before.
2. **Her body**, when it is there and shows the message, by its own rules, as before. A body that read presence in the last 30 seconds takes a fresh message at its next read; the call waits for that, at most 20 seconds from when the message was written. A body that reports `away`, `hidden` or `muted` has given the message back, and the phone rings at once.
3. **The call**, when the owner switched 「シャノンからの着信を受ける」 on (off until he does).

Exactly one surface: the call takes the message's claim (`reach_out_claims`, surface `iphone_call`) **before** the push is sent. While the phone rings, and after he answered, declined or did not answer, no app is offered the message and her body is not told about it. Only a call that could not ring at all (the push failed) gives the claim back.

A message is rung with **at most once**, whatever becomes of the call: `incoming_calls` has one row per message. That also holds across a restart. A row whose push was never confirmed (the process stopped in between) is closed as `failed` after 10 seconds and never sent.

The phone rings only for the **newest** of her unread messages, only within **3 minutes** of its being written, never once he read it, and never when he wrote or spoke in any Talk in the last **10 minutes** (a conversation in progress). Her one second call after an unanswered message (`follow_up`) is never a ring: he is not rung twice about one thing. So at most `SHANNON_AUTONOMY_MAX_REACH_OUTS` calls a day.

It rings whether or not earphones are connected: answering is his choice. There are no quiet hours on the server (owner decision: no time-of-day restriction); a Focus or Do Not Disturb on the phone silences it.

## The push

One VoIP push through APNs (`apns-push-type: voip`, `apns-topic: <bundle id>.voip`, `apns-priority: 10`, `apns-expiration`: the end of the ring), authenticated with a provider token (ES256, the team's `.p8` key). Its body is all it carries:

```json
{ "aps": {}, "shannonCall": 1, "callId": "5c2f…", "reachOutId": "0b6f…", "threadId": "…", "expiresAt": "2026-10-03T03:00:30.000Z" }
```

Identifiers and a time. **Her words are never in a push**, and never in a log: the server logs `ringing` or `failed` with the APNs status.

The ring lasts **30 seconds** (`expiresAt`). A push that arrives after that is not rung.

## `POST /v1/incoming-calls/registration`

`Authorization: Bearer <device token>`. Only a **paired device in the owner's scope**. The device is taken from its token.

```json
{ "scopeKey": "owner", "deviceToken": "ab12…", "environment": "production", "bundleId": "com.r41r41.shannon", "enabled": true }
```

| Field | |
| --- | --- |
| `deviceToken` | The phone's **VoIP** push token (PushKit), hexadecimal. It is not the ordinary notification token of `/v1/push/register`. |
| `environment` | `sandbox` \| `production` |
| `bundleId` | The app's bundle identifier; the push topic is `<bundleId>.voip`. When `SHANNON_APNS_BUNDLE_ID` is set, another value is refused. |
| `enabled` | The owner's switch. `false` keeps the token and rings nothing. |

No other field is accepted (`400`).

```json
{ "schemaVersion": 1, "registered": true, "enabled": true, "available": true, "ringSeconds": 30 }
```

`available` is the truth for the settings row: `false` while the server holds no APNs key or `SHANNON_INCOMING_CALLS=off` (the app then says 「サーバー側の準備がまだです」). The registration is stored either way.

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | A field is missing, not allowed, or out of its closed set. |
| 401 | `PAIRING_REQUIRED` | Missing or revoked device token. |
| 403 | `PAIRED_DEVICE_REQUIRED` | The caller has no paired device (a fixed-token caller). |
| 403 | `INCOMING_CALLS_OWNER_ONLY` | The device is paired into another scope than the owner's. A guest is never rung and can report nothing. |
| 429 | `RATE_LIMITED` | More than 30 requests from the device in a minute. |

Only a device whose pairing is neither revoked nor expired is rung. Unpairing a device (`POST /v1/devices`) drops its call token, and so does APNs answering `410`, `BadDeviceToken`, `DeviceTokenNotForTopic` or `Unregistered`.

## Answering: the claim route

He answered. The app takes her words through the **existing** claim route, naming the call:

`POST /v1/private-listening/reach-outs/{reachOutId}/claim`

```json
{ "scopeKey": "owner", "callId": "5c2f…" }
```

```json
{ "schemaVersion": 1, "id": "0b6f…", "status": "claimed", "surface": "iphone_call", "spoken": false, "listenSeconds": 0,
  "message": { "id": "0b6f…", "threadId": "…", "content": "ライ氏、さっき読んだ話をしてもいいですか。", "expression": "curious", "reason": "wonder", "createdAt": "…" } }
```

This is what marks the call `answered`: from here the message counts as said, and its claim is never given back. The same request again answers `held` with the same words. Unlike a claim of an app in his ears, the device does not have to be privately listening: he chose to answer.

| Status | `error` | Meaning |
| --- | --- | --- |
| 403 | `INCOMING_CALLS_DISABLED` | Calls are switched off on the server. |
| 404 | `CALL_NOT_FOUND` | No such call for this message. |
| 409 | `CALL_NOT_YOURS` | Another device was called. |
| 410 | `CALL_EXPIRED` | The ring ended more than 15 seconds ago. |
| 409 | `CALL_ENDED` | The call was declined or failed. |

A claim **without** `callId` for a message the call holds is refused as before (`REACH_OUT_NOT_LISTENING`, `REACH_OUT_TAKEN`), and the earphone delivery route answers `REACH_OUT_NOT_CLAIMED`.

## `POST /v1/incoming-calls/{callId}/report`

```json
{ "scopeKey": "owner", "outcome": "declined" }
```

| `outcome` | The app sends it when |
| --- | --- |
| `answered` | He answered. Taking her words already says so; the app need not send it. |
| `declined` | He declined, or hung up before a word of hers. |
| `unanswered` | The ring ended and nobody answered, or a Focus kept it from ringing. |
| `failed` | The call could not be shown or heard: the push was not a call the app could use, the switch is off on the phone, a conversation is going on in the app, or her words could not be taken. |

Only the device that was called may report (`409 CALL_NOT_YOURS`). No other field is accepted. The answer is `{ "schemaVersion": 1, "callId": "…", "status": "stored" | "duplicate" | "kept" }`; `kept`: he had already answered, and what went wrong afterwards does not undo that. Another outcome for a call that is closed is `409 CALL_ALREADY_REPORTED`.

A ringing call nobody reported on is closed as `unanswered` by the server 15 seconds after its ring ended (the app was killed, the push never arrived); a report of the app that arrives later replaces that guess.

- `declined`, `unanswered`: the claim stays the call's. Nobody says the message after he chose not to hear it; the text stays in the Talk as it already was, and the phone shows a missed call.
- `failed`: the claim is given back, so her body or an app in his ears may still say it while it is fresh. The phone is not rung with it again.

## What she observes

After a message of hers she observes what she observes after any message: whether he wrote or spoke (a yes or no and seconds, from timestamps) and how it was delivered. A call adds one fixed line per outcome, a closed value in `autonomy_loop_observations` (`reachOut.call`) and never a word of his:

| `call` | Line |
| --- | --- |
| `answered` | 電話の知らせ: iPhoneに電話をかけたら、ライ氏が出てくれた。 |
| `declined` | 電話の知らせ: iPhoneに電話をかけたが、ライ氏はいまは出ないことを選んだ。 |
| `unanswered` | 電話の知らせ: iPhoneに電話をかけたが、ライ氏は出なかった。 |
| `failed` | 電話の知らせ: iPhoneに電話をかけようとしたが、つながらなかった。 |

No answer inside her wait is, as before, 「返事はまだない」, and a second call (text, never a ring) is hers to decide. The loop's process reads the outcome from `incoming_calls`; it sends no push.

Loop files touched: `autonomyLoopObservations.ts` (the closed value), `autonomyLoopObserve.ts` (the observer's `call`), `autonomyLoopObservePrompts.ts` (the four lines), `autonomyWorker.ts` (reads `incoming_calls`).

## On the iPhone

- **PushKit and CallKit are set up at every launch** (`ShannonIncomingCalls.activate()` from `application(_:didFinishLaunchingWithOptions:)`), also a launch by the push itself with no window, and whatever the owner's switch says.
- **Every VoIP push is answered with an incoming call**, inside the push's callback (`ShannonCallKitBridge`): iOS ends an app that does not, and stops delivering such pushes. A push that is not a call to ring with (malformed, expired, a duplicate, the switch off, a conversation going on in the app) is reported and ended at once, with a reason the phone understands (`failed`, `unanswered`, `answeredElsewhere`).
- The caller is 「シャノン」, a generic handle, audio only, no hold, no grouping, no DTMF. `includesCallsInRecents` is **true**: her calls, answered or missed, are listed in the Phone app's recents, which is also where a missed call is seen. The settings say so.
- **On answer** (`ShannonIncomingCallMachine`: ringing → connecting → speaking → conversation): the audio session's category is set and nothing is activated; the system activates the session and says so (`provider(_:didActivate:)`). Then her words are taken, said in her voice (`ShannonEarphoneSpeaker`, the voice of a message said through earphones), and the **ordinary voice conversation** starts on the Talk her message is in. Its turns are stored as voice turns are. Without microphone permission her line is heard and the call ends.
- The conversation ending (終了 in the app, five minutes of silence in the background) ends the system's call; hanging up from the system's screen or the earphone button ends the conversation. The system's mute is the conversation's mute.
- **One owner of the audio session.** The conversation model and its workspace are one pair of objects for the app (`ShannonVoiceCallHost`), used by the call screen and by a call from her alike. From the first ring to the end of the call, standby steps aside and her messages are not said through the earphones. A voice conversation the owner started in the app is never a system call; while one runs the server does not ring (he spoke in the last 10 minutes), and a push that arrives anyway is reported and ended.
- Without earphones the phone routes an answered call as it routes any call: the receiver, or the speaker when he taps it. The speaker is not forced.
- **Lock screen.** The device's credential is stored in the Keychain readable only while unlocked. While the owner's switch is on it is stored `AfterFirstUnlockThisDeviceOnly` instead, so a call answered on the lock screen can reach the server; switching it off puts the stricter protection back. After a restart of the phone and before its first unlock, a call rings and ends as `failed`.

## Settings

iPhone, Settings › 「シャノンからの電話」: the toggle 「シャノンからの着信を受ける」 (off until he turns it on; turning it on asks 「シャノンからの着信を受けますか」 and explains: any hour unless a Focus silences it, his choice to answer, listed in the Phone app's recents). The row says 「着信を受けられます」, 「サーバー側の準備がまだです」, 「準備しています」, 「シャノンに接続すると、着信を受けられます」 or 「サーバーに届きませんでした。アプリを開き直すと、もう一度試します」.

## Stored shape

`voip_push_registrations` (additive): `device_id` (primary key), `scope_key`, `device_token`, `environment`, `bundle_id`, `enabled`, `updated_at`, `invalidated_at`.

`incoming_calls` (additive):

| Column | |
| --- | --- |
| `call_id` | primary key; the identifier CallKit knows the call by |
| `scope_key`, `initiative_id` | unique together: one call per message |
| `device_id`, `thread_id` | |
| `state` | `pending` (before the push) \| `ringing` \| `answered` \| `declined` \| `unanswered` \| `failed` |
| `created_at`, `expires_at`, `pushed_at`, `ended_at` | |
| `decided_by` | `app` \| `server` |
| `apns_status`, `reason` | the status APNs answered, and a short code |

`reach_out_claims.via` (additive): `call` for a claim of a call. The table's own check knows the surfaces `body`, `mac`, `iphone`, so a call's claim is stored as `iphone` with `via = 'call'` and read back as `iphone_call`.

Closed calls are deleted after 30 days. Neither table has a column for words.

## Server switches and credentials

`SHANNON_INCOMING_CALLS=off` (also `false`, `0`, `disabled`) is the kill switch: nothing is rung, a call that is ringing cannot be answered (`403`), and registrations answer `available: false`. Unset means on. `SHANNON_PRIVATE_LISTENING_REACH_OUTS=off` (or `SHANNON_PRIVATE_LISTENING=off`) switches calls off as well: the claim is what keeps two surfaces from saying one message.

Credentials come from the environment only, the same three the ordinary notifications use: `SHANNON_APNS_KEY_ID`, `SHANNON_APNS_TEAM_ID`, and the key file named by `SHANNON_APNS_PRIVATE_KEY_FILE` (the `.p8`, mode 600, outside the repository). `SHANNON_APNS_BUNDLE_ID`, when set, is the only bundle a registration may name. Without all three, or with a key that cannot be read, the API keeps running, logs one code (never a value), and calls are unavailable. The key and the device tokens are never logged.

The API process places the call (a timer every 2 seconds); the world worker and the autonomy worker send no VoIP push.
