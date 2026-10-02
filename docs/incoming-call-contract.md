# Incoming call contract (v1)

Owner request 2026-10-03: 「イヤホンをつないでいるとき、アプリを起動していなくても、シャノンから話しかけていい」. iOS lets an app that is not running start sound only as an incoming call, and he approved that: 「シャノンからの電話はすてき。出るかどうかはボクが選ぶので問題ない」.

Owner decision of the same day: **the call is her own deliberate act.** His picture of it: 「これをライ氏に伝えたい。あ、でもいまアプリを開いていない。じゃあ電話しよう」. So phoning him is a step she chooses in her own time, beside writing to him (`reach_out`). Nothing rings by itself: an ordinary message of hers is delivered as before (text, the notification, an app in his ears or her body saying it) and is never rung with.

The step is `autonomyLoopPhoneStep.ts`; asking for the call is `incomingCallRequests.ts`; the vocabulary and bounds are in `incomingCallContract.ts`, the API's side in `incomingCalls.ts`, the store in `incomingCallStore.ts`, the routes in `incomingCallRoutes.ts` and `serverIncomingCallRoute.ts`, the APNs sender in `voipPushSender.ts`. Tests: `services/api/tests/autonomyPhoneCall.test.ts` (the step, end to end) and `incomingCalls.test.ts` (the wire contract). On the iPhone: `apps/ios/Sources/ShannonAppCore/Features/IncomingCall/`. The Mac has no call screen and takes no part.

Everything is additive: two tables (`voip_push_registrations`, `incoming_calls`), one column (`reach_out_claims.via`), two routes, and one optional field (`callId`) on the existing claim route.

## Her step: `call`

A plannable action of her activity loop, with a reason from the same closed set as a message of hers (`share`, `wonder`, `upcoming`, `saw`). Tool `owner.call`, gate domain `owner_call` (free, in `packages/cognition/src/autonomy.ts`).

**When it is offered.** Only while all of this holds; otherwise the thinking prompt does not name the action, and a plan that names it leads to nothing:

- the owner switched 「シャノンからの着信を受ける」 on, on an iPhone the server knows;
- the server can send a push: `SHANNON_INCOMING_CALLS` is on and the three APNs values are configured;
- no conversation is in progress (he wrote or spoke in the last 10 minutes), and no call of hers is on its way or ringing;
- her last call, whatever became of it, is at least `SHANNON_INCOMING_CALL_MIN_INTERVAL_MINUTES` old (default 5);
- she has not already written or phoned in this cycle.

There is **no count of calls a day** (owner decision: 「コストの範囲内なら、好きなだけ」) and no quiet hours. The daily budget and the approval gate bound her: the gate refuses the step while a call may not be placed (`access_limit`), while she is paused, and when the model call does not fit the budget.

**What she is told** (`autonomyLoopPhoneStep.ts`, verbatim). The action, in the list of actions of the thinking prompt:

> call（ライ氏のiPhoneに電話をかける。伝えたいことがあって、ライ氏がアプリを開いていない時のためのもの。ライ氏の電話が鳴り、出るかどうかはライ氏が選ぶ。出てくれたら、最初の一言をボクの声で伝えて、そのまま会話になる。同じ一言はトークにも文字で残る。reason は share、wonder のどれか。かけたあとで、出てくれた・出ないことを選んだ・出なかった・つながらなかった、のどれだったかが分かる。時間帯の決まりはなく夜中でも鳴るので、時刻と下の「いまの様子」を見て、本当にかけたい時だけ。一度の計画で1回まで、reach_out とは一緒に置かない）、

(`upcoming` and `saw（この計画の look より後に置く）` are added to the reasons while they are available.)

The facts of the moment, one section of fixed sentences, shown whenever he switched calls on, also while she cannot call just now:

```
[いまの様子]（サーバーが見た事実）
- イヤホン: いま、ライ氏にだけ聞こえるイヤホンでアプリを聞いている（reach_out は声でも届く）。 | いま、ライ氏のイヤホンでアプリは聞かれていない。
- 体: ボクの体（デスクトップ）はいま表示されている。 | ボクの体（デスクトップ）が表示されているかは分からない。
- 会話: いまライ氏と会話が続いている。 | いまは会話していない。
- ライ氏が最後に書くか話すかしたのは: 12分前。 | 記録がない。
- 電話: いまかけられる。 | いまはかけられない（サーバーの準備がまだ） | （電話を鳴らしている最中） | （ライ氏と会話が続いている） | （前の電話から間もない。あと約N分）
- 前の電話: 3時間前にかけた。出てくれた。 | …ライ氏は出ないことを選んだ。 | …出なかった。 | …つながらなかった。 | …まだ鳴らしている。 | まだかけたことがない。
```

And one rule line:

> - 「いまの様子」は、サーバーが見た事実。電話に出なかったことも、出ないことを選んだことも、悪いことではない。出ないことを選んだのは、ライ氏がいまは出ないと決めたということ。あとでもう一度かけるか、書いて伝えるか、そのままにするかは、ボクが決める。責めたり、急がせたりしない。

Every value is a yes or no, a closed state or a time: no word of his, no device name. While he has not switched calls on, none of this is in any prompt.

**What the step does.**

1. One model call words her opening line: the prompt of a message of hers for that reason, plus 「[電話の最初の一言] これは電話。ライ氏が出てくれた時に、最初にボクの声で言う一言になる。同じ言葉がトークに文字で残り、通知にも出る。」 An empty line means she decided not to call.
2. The line is written as a message of hers: one assistant message in his most recent Talk, one initiative, the ordinary notification. Its key is `reach-out-call:<owner-local day>:<random>`, so it is not one of the day's messages when the owner has set a count of those.
3. She asks for the call: the message's claim is taken as `iphone_call` for the iPhone, and one `pending` row is written to `incoming_calls`. Her process sends no push and reads no key.
4. She stays with it, renewing her lease, until the call has an outcome (at most 75 seconds; a ring is 30), and records it.

**What she learns.** One closed value on the step's observation (`reachOut.call`), its reason code (`call_answered`, `call_declined`, `call_unanswered`, `call_failed`), and one fixed line (see [What she observes](#what-she-observes)). After anything but an answer she thinks again in the same cycle with that line in front of her and decides herself: write once more (`follow_up`, text), look at the room, jot a note, or let it go; in a later cycle, after the interval, she may call again.

**In conversation.** There is no tool for it: he is already there. Her capability description (`capabilities.ts`, owner audience) says: 「電話: 自分の時間に伝えたいことがあって、ライ氏がアプリを開いていない時、ライ氏のiPhoneに電話をかける。電話が鳴り、出るかどうかはライ氏が選ぶ。ライ氏が着信をオンにしている時だけで、会話の中からはかけない。」

## The API process sends it

Every 2 seconds the API process looks for `pending` rows of the owner's scope and, for each:

- checks again, a moment after she chose: calls are available, the message is unread, no owner turn in the last 10 minutes, no other call ringing, the claim is still the call's, and the device still holds a pairing that is neither revoked nor expired. A refusal closes the call as `failed` with a code and gives the claim back;
- takes the row (`pending` → `sending`, one atomic update, so only one process sends it and only once, also across a restart) and sets the end of the ring, 30 seconds on;
- sends the push; `200` makes it `ringing`, anything else `failed` (and the claim is given back).

A `pending` row older than 10 seconds (the API was down while she asked) is closed as `failed` and never sent. A row a stopped process left `sending` is never sent again; it stays answerable for the ring's length, in case the push did leave, and is then closed as `failed`.

**Exactly one surface.** From the moment she asks, the message is the call's: no app is offered it and her body is not told about it, also after he answered, declined or did not answer. Only a call that could not ring gives the claim back, so her body or an app in his ears may still say it while it is fresh.

A message is rung with **at most once**: `incoming_calls` has one row per message.

It rings whether or not earphones are connected: answering is his choice. A Focus or Do Not Disturb on the phone silences it.

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

The step records what became of the call as a closed value in `autonomy_loop_observations` (`reachOut.call`), never a word of his, and she is told one fixed line for it, when she thinks again and in what she remembers of the day:

| `call` | Line |
| --- | --- |
| `answered` | 電話の知らせ: iPhoneに電話をかけたら、ライ氏が出てくれた。 |
| `declined` | 電話の知らせ: iPhoneに電話をかけたが、ライ氏はいまは出ないことを選んだ。 |
| `unanswered` | 電話の知らせ: iPhoneに電話をかけたが、ライ氏は出なかった。 |
| `failed` | 電話の知らせ: iPhoneに電話をかけようとしたが、つながらなかった。 |

An answer counts as his reply. No outcome within her wait means the API process is not running: nothing rang, and she is told it could not connect. Her day's record says 「電話をN回かけ」.

Loop files touched: `autonomyLoopPhoneStep.ts` (new: the step, the facts, the action's wording), `autonomyLoopPlan.ts` (the action `call`), `autonomyLoopThinkStep.ts` (offers it and adds the facts), `autonomyLoopSteps.ts` (dispatch, adapters, the `phone` dependency), `autonomyLoopState.ts` (`call` on a planned step), `autonomyLoopReachOutStep.ts` (`sayByPhone` on the interface), `autonomyLoopObservations.ts`, `autonomyLoopObserve.ts`, `autonomyLoopObservePrompts.ts` (the closed value and its lines), `autonomyLoopSessionPrompts.ts` (the action's name), `autonomyPolicy.ts` and `autonomyService.ts` (the gate), `autonomyDayLog.ts`, `autonomyCore.ts`, `autonomyWorker.ts` (wiring), and `packages/cognition/src/autonomy.ts` (the domain).

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

iPhone, Settings › 「シャノンからの電話」: the toggle 「シャノンからの着信を受ける」 (off until he turns it on; turning it on asks 「シャノンからの着信を受けますか」 and explains: she decides when to call, any hour and with no count unless a Focus silences it, his choice to answer, listed in the Phone app's recents). The row says 「着信を受けられます」, 「サーバー側の準備がまだです」, 「準備しています」, 「シャノンに接続すると、着信を受けられます」 or 「サーバーに届きませんでした。アプリを開き直すと、もう一度試します」.

## Stored shape

`voip_push_registrations` (additive): `device_id` (primary key), `scope_key`, `device_token`, `environment`, `bundle_id`, `enabled`, `updated_at`, `invalidated_at`.

`incoming_calls` (additive):

| Column | |
| --- | --- |
| `call_id` | primary key; the identifier CallKit knows the call by |
| `scope_key`, `initiative_id` | unique together: one call per message |
| `device_id`, `thread_id` | |
| `state` | `pending` (she asked) \| `sending` (the API took it) \| `ringing` \| `answered` \| `declined` \| `unanswered` \| `failed` |
| `created_at`, `expires_at`, `pushed_at`, `ended_at` | |
| `decided_by` | `app` \| `server` |
| `apns_status`, `reason` | the status APNs answered, and a short code |

`reach_out_claims.via` (additive): `call` for a claim of a call. The table's own check knows the surfaces `body`, `mac`, `iphone`, so a call's claim is stored as `iphone` with `via = 'call'` and read back as `iphone_call`.

Closed calls are deleted after 30 days. Neither table has a column for words.

## Server switches and credentials

`SHANNON_INCOMING_CALLS=off` (also `false`, `0`, `disabled`) is the kill switch: she is not offered the step, a call she asked for is not sent, a call that is ringing cannot be answered (`403`), and registrations answer `available: false`. Unset means on. `SHANNON_PRIVATE_LISTENING_REACH_OUTS=off` (or `SHANNON_PRIVATE_LISTENING=off`) switches calls off as well: the claim is what keeps two surfaces from saying one message.

`SHANNON_INCOMING_CALL_MIN_INTERVAL_MINUTES` (0–1440, default 5) is the shortest time between two calls of hers, whatever became of the first.

Set them for the API and the autonomy service alike; a restart applies them.

Credentials come from the environment only, the same three the ordinary notifications use: `SHANNON_APNS_KEY_ID`, `SHANNON_APNS_TEAM_ID`, and the key file named by `SHANNON_APNS_PRIVATE_KEY_FILE` (the `.p8`, mode 600, outside the repository). `SHANNON_APNS_BUNDLE_ID`, when set, is the only bundle a registration may name. Without all three, or with a key that cannot be read, the API keeps running, logs one code (never a value), and calls are unavailable. The key and the device tokens are never logged.

The API process sends the push (a timer every 2 seconds). The autonomy worker asks for the call and checks only that the three values are set and the key file exists; it does not read the key. The world worker takes no part.
