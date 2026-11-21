# Discord voice channel contract (`/v1/platform/voice/*`)

Owner request 2026-10-20: while Shannon works toward the Ender Dragon, she talks with the owner and his friends in a Discord voice
channel, and says what she is doing and what the situation is. The Discord bot (the Shannon body) hears and speaks; her one mind (this
server) decides what she says. Everything here answers 503 `PLATFORM_VOICE_DISABLED` while `SHANNON_DC_VOICE` is off, and uses the platform
bridge's service token (`Authorization: Bearer`, as `/v1/platform/turns`).

## Who is present

A voice channel's turn is a turn of the conversation kernel through the platform surface (`platformSurface.ts`), like
`POST /v1/platform/reply`, with the channel's members as the audience:

- The conversation is `discord:<guildId>:<textChannelId>` (the text channel of the voice channel), bound in
  `SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON` like a typed conversation. Spoken and typed words are one conversation.
- The owner alone in a conversation bound `owner-private`: the owner's own turn (his profile, her tools, her feeling moves). With
  anyone else in the channel (`participants`), or someone else speaking, the same conversation is an audience of the channel as a
  whole (`PlatformAudienceOptions.sharedPresence`): her identity without his profile, the speak-time check, what is kept is labelled
  with that audience.
- Several people in the channel: she answers only what is said to her (named, asked, requested, greeted, or a short reaction right
  after she spoke; `voiceChannelAddress.ts`). What she hears and does not answer is kept for three minutes in memory as context,
  never in her memory.
- With `SHANNON_ADDRESSED` on (owner 2026-10-21, `docs/addressed-contract.md`) the rule is the same for one person and for many: she
  answers only words that call her by name and are said to her, and the same person's follow-up within ~20 s of her last words;
  Jev judges, and only in those two cases. A `decision` of `respond: false` has the reasons `no_name`, `about_her`, `not_to_her`,
  `fragment`; `respond: true` has `named`, `bare_call`, `continuation`, `stop` (止めて, 待って... from the owner while she speaks or her body works, and the plain stop words 止めて・ストップ from a guest while her body works, without her name).

## `POST /v1/platform/voice/turn` (NDJSON)

Request: `platform: "discord"`, `requestId`, `conversationId`, `voiceChannelId?`, `sourceUserId`, `sourceDisplayName`, `userMessage`
(the words heard, 1,000 characters), `observedAt`, `participants` (the humans in the channel, the speaker included), `heard` (up to
eight lines she did not answer: `userId`, `name`, `text`, `at`), `followsShannonTurn`, `speakingNow`, `shannonSpokeMsAgo?` (ms since she
last finished speaking), `fillerId?`, `situation?`
(what her Minecraft body is doing, 300 characters), `sttMs?`, `utteranceMs?`. Anything else is a 400.

Lines, in order: `decision` (`respond`, `reason`, `filler` or null; always first, before anything is read or paid for), then
`sentence` (`index`, `text` shown, `voiceText` with the voice's audio tags when they differ; sent while the model writes, cut at a
clause after 14 characters), `intent` (the owner's spoken request for her body: `task_message`, `task`, `stop`; `delivered`),
`done` (`reply`, `threadId`, `duplicate`, `timings`), or `error` after a first line. A refusal before the first line is JSON
(400, 403, 409, 429). A retried `requestId` replays the stored answer. `silent: true` on `done` means she had nothing to say.

A spoken request for her Minecraft body (owner decision 2026-11-21, 「全員と自由に話せてほしい」; before it only the verified owner's words
reached the body, and a new task only while he was alone in the channel): with the body connected and the speaker not the owner alone in a
private conversation, the reply may carry `minecraftIntent`, whoever speaks. A request while one is under way is a message to that task,
`stop` stops the body's tasks, and anything else is a new task. The speaker (`sourceUserId`, `sourceDisplayName`, owner or not) travels
with the request, and the words the task's head reads say who asked (「Discordの通話でのユウの依頼: …」, the owner's as 「本人（名前）」).
A guest's turn is kept as person memory, which no task may stand on, so a request of theirs is also written into the channel's thread with
their name on it (no background learning from it) and that turn is the task's source; the owner's own turn is the source, and when the
reply recalled what a source may not stand on (a guest's person memory) the same record is written for him and tried once more. If it is
refused after her reply promised it, the fixed words of the refusal are the last `sentence` (`correction: true`) and are kept as what she
said. What stays: she answers only what is said to her (`SHANNON_ADDRESSED`), the body hears no bot (itself included), and its turns
run one at a time per channel (`turnQueue.ts`). A stop word without her name is heard from anyone while her body works.

## Other routes

- `POST speech` `{text, style?}`: raw PCM (`audio/l16;rate=24000;channels=1`, s16le), streamed; `x-shannon-first-chunk-ms`.
- `GET fillers`: `{items: [{id, text, style}]}`, the short sounds a `decision` may name (`voiceFillers.ts`).
- `POST say`, `POST mouth/poll`, `POST mouth/result`: her mouth (`voiceMouth.ts`); `POST wording` (event facts into her words);
  `POST said` (what she said by herself, or was heard saying before being talked over, kept in the conversation).

## One head (`SHANNON_ONE_HEAD`)

With `SHANNON_ONE_HEAD` on, the same turn is answered by the one voice turn the apps use (`apiLiveVoice.ts`, the router, recall only when
it is wanted, her plain spoken stream; the owner's request to her body through the structured stream), with the channel's seat in place
of a device's, and `expression` lines may come before the sentences. Conversations nobody bound and strangers are answered too, and
`POST /v1/converse` takes this turn in the one shape (`docs/one-head-contract.md`).

## Switches

`SHANNON_DC_VOICE` (off), `SHANNON_DC_VOICE_FILLER` (off since 2026-10-21: the recorded fillers are the old voice), `SHANNON_DC_VOICE_MINECRAFT`,
`SHANNON_DC_VOICE_MOUTH` (on within the first), `SHANNON_ADDRESSED` (off; whom a line was said to).
`SHANNON_VOICE_AUDIO_TAGS` decides whether her replies carry audio tags. The voice needs `ELEVENLABS_API_KEY` and
`SHANNON_ELEVEN_TTS_VOICE_ID`; without them `speech` is 503 and the bot says the line in its own voice.

## Measured (dc-voice, `tests/perf/voiceContentionBench.ts`)

See the dc-voice report. In short: the turn's own work before the model is about 120 ms (p50) in a production-shaped store; the API's one
event loop is shared with her Minecraft task, whose decision starts block it for seconds, and a voice turn that meets such a stall waits.
