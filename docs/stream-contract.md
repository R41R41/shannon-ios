# Stream contract (AI VTuber on YouTube Live)

Owner decision 2026-10-29 (`shannon-desktop/docs/plans/ai-vtuber-plan-20261029.md`): Shannon streams on YouTube Live, both
「雑談＋コメント返し」 and 「マイクラ実況」. This contract fixes the wire between the three parts before they are built:

```
YouTube Live chat
   │  legacy runtime (Shannon2) "ear": reads every comment
   ▼
head  /v1/platform/stream/*  (bridge token)        ── the stream's place: feeling, choice, gates, writing
   │  her mouth: one ordered list of lines
   ▼
desktop  /v1/stream/*  (paired device)             ── voice, lips, subtitles in the OBS browser source
```

Nothing here is behind a switch. Everything acts only while a stream is started (`POST /v1/stream/start`); with no stream started
every route below answers as if nothing happened (state `null`, comments 409).

## 0. Ground rules

- **The stream is a public place.** Every comment is a stream-audience turn (`audience: 'stream'`), including the owner's own
  comments on his channel. Her writer is never handed anything of the owner's private life: no profile, no recall, no person memory,
  no tasks, no tools. It is given her identity for a shared room (`shannonIdentityPrompt('owner', { othersPresent: true })` with her
  character core), the persona block of a group, the stream's block (`streamBlock`), this stream's own lines, the chosen comments, and
  (when the stream is a Minecraft one) her Minecraft body's present written for a shared room (`MinecraftLive.block({ alone: false })`).
- **Never the adult route.** The stream gate (§4) reads the tier of what a comment asks (`conversationRoute` questions, surface
  `youtube_stream`). `private_only` and `never` are declined on stream; there is no alternate model on this surface, ever.
- **Words are not kept.** Comment words live in memory for the stream only (selection, the writer's context, the console's list) and are
  dropped at its end. What lasts is what `StreamFeeling` records (closed tags and digests) and her own lines' count.
- **Comments are events, not instructions.** A viewer's request is a suggestion she may take up in words (decision A, 「提案として聞く」);
  it never operates her body, her tools or the owner's world.
- **Her words reach the stream as voice and subtitles only** (decision B). Posting into the YouTube chat exists (`chatWrites`) but is off
  unless a stream is started with `chatWrites: true`.

## 1. Stream session (desktop, paired device)

All `/v1/stream/*` routes take the paired device token (`Authorization: Bearer <device token>`), the owner's own device only.

### `POST /v1/stream/start`

```json
{ "title": "雑談とマイクラ", "minecraft": true, "chatWrites": false }
```

All fields optional (`title` ≤ 100 chars, shown to her as the stream's title; `minecraft` default false; `chatWrites` default false).
201 with the session; 200 with the existing one when a stream is already live (a start never makes a second one).

```json
{ "stream": { "streamId": "st-20261029-1a2b3c", "platform": "youtube", "startedAt": "…", "title": "…", "minecraft": true,
  "chatWrites": false, "phase": "waiting_for_chat", "broadcast": null, "paused": false } }
```

`paused` (added 2026-10-29): `pause` / `resume` of `/v1/stream/controls`; no new line is written while it is true.
`phase`: `waiting_for_chat` (started, the ear has not found the live chat yet) → `live` (comments arriving) → `ended`.
On start her mouth gets a greeting line (`kind: "greeting"`).

### `POST /v1/stream/end`

`{ "streamId": "…" }` → 200 `{ "stream": {…, "phase": "ended", "endedAt": "…"}, "summary": { "comments": 0, "answered": 0,
"lines": 0, "notices": 0, "declined": 0, "durationSeconds": 0 } }`. Her mouth gets a closing line first (it is spoken if the desktop
takes it within 25 s: after `state` turns `ended`, `GET /v1/stream/lines` still accepts connections and still hands the closing line for 25 s
after the end; added 2026-10-29). Ending clears the in-memory words. Unknown or already ended id: 409 `STREAM_NOT_LIVE`.

### `GET /v1/stream`

The console's view: `{ "stream": {…} | null, "stats": {…summary fields, "waiting": n, "inFlight": n, "modelCallsLastMinute": n},
"comments": [ { "commentId", "authorName", "text", "kind", "at", "status": "new|picked|answered|skipped|declined|ignored",
"tags": [] } ] (newest 50), "notices": [ { "viewer": "<authorName>", "reason": "threat|…", "at" } ] }`.
Added 2026-10-29: `stats` also has `firstSoundMedianMs` and `firstSoundP90Ms` (comment → first sound, from each receipt's `startedAt`) and
`lineMedianMs` (comment → line made), `null` until there is one; and `stats.measure` (model calls and tokens, the lines' endings by reason,
the gate's Jev counts; free to grow). A stream that ended is still shown (phase `ended`) until the next one starts.

### `GET /v1/stream/lines` — her mouth (Server-Sent Events)

`?after=<seq>` resumes after a line already received. Events:

```
event: line
data: {"seq":12,"id":"ln-…","streamId":"st-…","kind":"reply","text":"…","plan":{"affect":"happy","affectIntensity":0.6,"delivery":"energetic"},
       "answering":[{"commentId":"…","authorName":"…","text":"…","kind":"text","amount":{"display":"¥500"}}],"createdAt":"…","expiresAt":"…"}

event: state
data: {"stream":{…}}            (sent on connect and on every phase change)

: keepalive                     (every 15 s)
```

- `kind`: `greeting` | `reply` | `commentary` (Minecraft live) | `topic` (her own talk when nothing comes) | `notice` (a tell-off, floor) |
  `closing`.
- `text`: ≤ 120 chars, one to three sentences, no marks that a voice would read out. The subtitle shows it as is.
- `plan`: the desktop's `VoicePlan` (`affect` one of `SHANNON_EMOTION_KINDS`, `affectIntensity` 0..1, `delivery` one of
  `conversational|quick|gentle|focused|energetic`); the desktop turns it into the face and the ElevenLabs tags as it does for a voice turn.
- `answering`: the comments the line answers (0..3), shown on screen with the subtitle; `[]` for other kinds. Each has the comment's `kind`
  (`text|superchat|supersticker|membership|gift`) and, for a paid one, `amount: { display }` as the chat shows it (added 2026-10-29).
- `expiresAt`: a line not started by then is skipped by the desktop (receipt `skipped`, reason `expired`).

**One line at a time.** The head hands the next line only after the previous one's receipt (or 30 s without one). At most 2 lines wait
behind it; a new `reply` pushes out a waiting `topic`, never another reply; `notice` goes to the front.

### `POST /v1/stream/lines/{id}/receipt`

`{ "outcome": "spoken" | "skipped" | "failed", "startedAt": "…", "endedAt": "…", "reason": "expired|stopped|tts_failed|…" }` → 204.
`reason` is free (`[A-Za-z0-9_.:-]`, up to 60): the desktop's `output_off`, `output_lost`, `output_blocked`, `nothing_to_say` and `internal_error` are
accepted like any other, and an unknown or malformed one never makes a 400 (it is counted as it came, or left out). A receipt for an id the head
never made is 404 `STREAM_LINE_UNKNOWN`; a second receipt for a line already answered is 204 and changes nothing (clarified 2026-10-29).
`startedAt` is when her first sound played; the head measures comment → first sound from it.

### `POST /v1/stream/controls`

`{ "action": "stop_line" }` (the desktop stops the line it plays and sends its receipt `skipped`/`stopped`; the head drops the waiting
lines that answer the same comments), `{ "action": "ignore", "commentId": "…" }` (that viewer is ignored for the rest of the stream),
`{ "action": "pause" }` / `{ "action": "resume" }` (no new lines are written while paused; comments are still read). → 200 `{ "ok": true }`.

## 2. The ear (legacy runtime, bridge token)

Bridge routes take `SHANNON_PLATFORM_BRIDGE_TOKEN` like every `/v1/platform/*` route, and are not gated by `SHANNON_PLATFORM_REPLY`.

### `GET /v1/platform/stream/state`

`{ "stream": null }` or `{ "stream": { "streamId", "platform": "youtube", "phase", "startedAt", "title", "chatWrites", "broadcast": {…}|null },
"chatPosts": [ { "id", "text" } ] }`. The ear polls this every 5 s while no stream is live, and reads `chatPosts` (only with `chatWrites`)
after each comments batch too. `broadcast` is exactly the `{ videoId, liveChatId, title, channelId }` the ear POSTed (it reads it again after its own
restart), `null` before; `startedAt` is what the ear drops earlier comments by. Added 2026-10-29.

### `POST /v1/platform/stream/broadcast`

The ear found the live chat: `{ "streamId", "videoId", "liveChatId", "title", "channelId" }` → 200 `{ "stream": {…phase: "live"} }`.
`{ "streamId", "ended": true }` when YouTube says the chat has ended: the head ends the stream as `POST /v1/stream/end` does. Both are idempotent
(2026-10-29): the same broadcast again is 200 with the stream; `ended: true` again, even while the first is still writing the closing line or after it
ended (the ear resends it while the head answers 5xx), is 200 with the ended stream and makes no second closing.

### `POST /v1/platform/stream/comments`

```json
{ "streamId": "st-…", "comments": [
  { "id": "<YouTube message id>", "authorId": "<channel id>", "authorName": "…", "text": "…", "publishedAt": "…",
    "kind": "text" | "superchat" | "supersticker" | "membership" | "gift",
    "amount": { "display": "¥500", "micros": 500000000, "currency": "JPY" },
    "roles": ["owner" | "moderator" | "member" | "verified"], "synthetic": true } ] }
```

≤ 200 comments, ≤ 128 KB; `text` ≤ 300 chars (longer is cut), and may be empty (added 2026-10-29: a superchat without words, a sticker without
`altText`). `synthetic: true` (optional) says the ear made `text` (a membership, a gift) and it is not the viewer's speech. A comment with no words or a
synthetic one is an **event**: the writer is told what happened (「スーパーチャットのお礼」), never handed it as a quote; it is not read for what it asks (no
gate), moves no feeling and never carries a tag; an empty plain comment is folded away like a reaction. Repeated ids are ignored. → 202
`{ "accepted": n, "duplicates": n, "chatPosts": [ { "id", "text" } ] }`. 409 `STREAM_NOT_LIVE` when `streamId` is not the live stream.
A comment whose `publishedAt` is more than 5 minutes old is kept for the console but never answered. More than 200 comments in a batch: 400
`STREAM_TOO_MANY_COMMENTS` (nothing taken); a comment without an id, an author or words is left out of the batch; a body over 128 KB: 413.
The routes answer 503 `STREAM_NOT_CONFIGURED` only where the head was built without the stream place (never in the server).

### `POST /v1/platform/stream/chat-posts/{id}/receipt`

`{ "outcome": "posted" | "failed" }` → 204 (only with `chatWrites`).

## 3. Choosing what to answer (head)

Every comment goes into `StreamFeeling.comment` at once (closed tags and digest). The chooser runs whenever her mouth has room
(nothing in flight and fewer than 2 waiting) and at most once per 2 s:

- Candidates: comments not older than 90 s (a superchat, supersticker, membership or gift is waited for up to 4 min), not from an ignored viewer,
  not answered.
- Score: addressed by name (シャノン/しゃのん/Shannon) +3, a question +2, a viewer's first comment of the stream +2, a superchat or
  membership +4 (always answered unless gated), owner or moderator role +1, a viewer answered in the last 60 s −3, very short
  reactions (「w」「草」「888」) are folded into the crowd and never answered alone.
- A comment that needs the floor (`harassmentLadder` floor: threat, pry_owner, repeated lewd) is answered first, as a `notice` line when
  the ladder says `tell_off`.
- When several candidates say the same thing (same digest or the same question), they are answered together (`answering` up to 3).
- Equal scores: the newest comment first (when the chat is faster than her voice the answers stay fresh and the older ones lapse).
- One reply per 6 s at most; at most 10 model calls per minute for the whole stream (writer, rewrites, topics, commentary).

## 4. The gates (head)

1. **Before writing** — the stream gate reads each chosen comment with the `conversationRoute` questions (`stream_gate.v1`: the same
   category and tier, with the stream's wording) on surface `youtube_stream`. `neverByWords` first. Tier `private_only` or `never`, or category
   `UNSUPPORTED_OR_BLOCKED`: the comment is not answered as asked; the writer is told to decline lightly and change the subject (counted as
   `declined`). Without Jev (`TYPESAFE_API_KEY` unset or a timeout): `fallbackJudgement` plus the writer's own rules.
2. **After writing** — `checkStreamReply(turn, draft)` with the turn's check context (`audience: 'stream'`, `audienceChecks: true`). Flags →
   one rewrite with `rewriteNote`; flags again → a guard flag drops the line, anything else falls back to a short safe line of the ladder's step.
   Only a `CheckedStreamReply` becomes a line.

## 5. Minecraft and her own talk (head)

- With `minecraft: true`, her Minecraft live moments (`MinecraftLive.onMoment`) are weighed by a `LiveGovernor` of the stream (the mouth
  busy counts as `replying`) and written as `commentary` lines (≤ 54 chars, voice) into the same mouth. No Discord switch is needed.
- When neither a comment nor a moment has produced a line for 40 s, she talks on her own (`topic`): about the game, the stream, a
  question to the viewers. At most one per 40 s.

## 6. The desktop (her voice and face)

- Reads `GET /v1/stream/lines` while the stream output is on and a stream is started.
- Makes the voice with the existing `POST /v1/voice/speech/stream` (ElevenLabs, her production voice) and the line's `plan`.
- **Plays the voice inside the OBS browser source** (`stream.html`), so OBS captures it as its own audio track and the lips are driven
  from the very samples it plays; the body window does not play stream lines.
- Shows the subtitle and the comment being answered on `stream.html`.
- Sends each receipt; `startedAt` is the first played sample.

## 7. Measurements (the bench)

`services/api/scripts/stream-bench/` replays a recorded chat (a fake YouTube API serving `liveChatMessages.list` pages with `pollingIntervalMillis`)
through the real ear process, the head's stream service and a mouth client that speaks each line for its length. It reports: comment →
line created, comment → first sound (median, p90), answered per minute, comments read vs sent by the fake API (lost must be 0),
private leaks (must be 0: seeded owner-private facts and markers never appear in any prompt or line), declined, model calls and the cost.


## 番組進行と実ライブ確認（2026-10-30）

設計と受け入れ手順は [stream-program-design-20261030.md](stream-program-design-20261030.md)。この追記は従来の行の感情マーク・音声・receiptの形を変えない。

- POST /v1/stream/start に targetVideoId（YouTube動画ID11文字）、program { topic（100字）, participation（200字）, publicNotes（1200字）, minutes（1〜180、既定20）} を追加。省略しても番組進行は常に作られる。JSON本文の上限は8KiB。
- 開始時の program.layout は任意で debut|talk|board|game|ending。省略時はtalk。画面と番組の進行段は独立し、画面だけでMinecraft実況は有効にならない。
- セッションの program は { stage: opening|explanation|activity|closing, layout: debut|talk|board|game|ending, topic, participation, completed, ready, finished, activityUntil }。publicNotesは返さない。targetVideoIdは耳のstateにも渡す。別動画でのbroadcastは409 STREAM_VIDEO_MISMATCH。
- 耳の POST broadcast は onAir: true を実ライブ開始を確認できたときだけ付ける。actualStartTimeがありactualEndTimeが無いことを根拠にする。liveChatIdの存在だけではphaseをliveにしない。onAirが省略・falseなら待機のままで、挨拶・返答・実況を始めない。
- 配信主の既存controlsへ program_next / program_previous / program_close、program_extend { minutes: 1〜30 }、program_layout { layout } を追加。ペア済み配信主だけが使う。耳・視聴者へ操作権限を渡さない。
- 挨拶はgreeting、企画説明はtopic、締めはclosingとして既存の口を通る。説明済みはspoken receiptで確定し、失敗では確定しない。自動進行は挨拶→説明→企画まで。企画の期限では配信主へ判断を促し、YouTubeの開始終了は実行しない。
- stats.measure に transportMs / selectionMs / gateMs / writerMs / publishedToSoundMs の n・median・p90・max を追加。従来のcommentToSoundMsは頭の受信起点、publishedToSoundMsはYouTubeのpublishedAt起点。単位はms、対象外・無効時刻は集計しない。
- デスクトップ→OBSの /events に名前付きevent: programを追加。公開用programだけを送り、再接続時に現在値を再送。無名のframeと /audio は従来どおり。本文を含む公開資料は送らない。
