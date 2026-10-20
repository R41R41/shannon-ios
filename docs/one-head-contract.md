# One head, entries only hear and speak (`SHANNON_ONE_HEAD`)

Owner decision 2026-10-20 (「作り直す」): Shannon is one mind. Every entry (the apps' Talk and voice on iPhone, Mac and Windows, Discord's
text and voice channel) hands her mind the same shape of a turn and reads the same events back. Who is present, what she remembers, how
she feels and what she says are decided by the mind; an entry only hears, plays and shows. `SHANNON_ONE_HEAD` (off) switches it on;
off, every route behaves exactly as before (dc-voice).

## The core

- **Seat**: who is present. The apps prove the owner by the paired device and say whether someone is beside him (`participantMode`,
  `companionPresent`); a platform's seat is the bridge's policy for that speaker (`PlatformBridgeService.audiencePolicy`):
  `owner-private`, shared, a conversation nobody bound, a stranger.
- **Ingredients, the same for every entry**: identity and her character core (with `SHANNON_CHARACTER_SPACE` her space's core and
  region, now also in a voice turn), natural talk's cues, memory through the seat's audience (`openOnly` where the owner is not there to
  release a protected line), people memory heard by everyone there, feeling turn, her Minecraft body's present (`minecraftLive`) and the
  commentary's quiet while she answers, the owner's request to her body (`minecraftIntent`), her tools by the audience, and her guard
  lines (a text draft checked whole before sending; a spoken reply checked sentence by sentence before each is said, `VoiceSentenceGuard`).
- **One flow, two modalities** (`mind/action/respond/conversationTurn.ts`, `runConversationTurn`): every turn goes through the same
  stages in the same order: open (what was said, by whom, the route) → what she remembers (`startTurnMemory`: the deterministic recall,
  people memory by the seat's audience, the bounded semantic recall) → begin (feeling turn, perception) → who she is (`identifyTurn`:
  her character core, her own time's projection, stage 5) → what she can read (`startTurnCapability`, bounded) → the prompt
  (`composedTurnContext`, the replay by `turnReplay`) → speak → close (store, feeling commit, record) or abandon. Only the modality
  differs: voice (`surfaces/voice/voiceConversation*.ts`: the router decides whether to answer and her face, her plain words stream,
  each sentence guarded) for the apps' voice and Discord's voice channel; text (`infra/http/textConversation.ts`: structured reply,
  tools, a draft checked whole) for the apps' Talk, Discord's text and her game chat. The flow is the same with the switch off; the
  switch only decides which entries reach it and with which seat. Nothing is awaited before the model call when nothing needs to be.

## `POST /v1/converse` (NDJSON)

The bridge's service token (`Authorization: Bearer`, as `/v1/platform/*`). 503 `ONE_HEAD_DISABLED` while the switch is off;
503 `PLATFORM_VOICE_DISABLED` / `PLATFORM_REPLY_DISABLED` while the modality's part is off.

```json
{
  "version": 1, "requestId": "…", "observedAt": "ISO", "modality": "voice" | "text",
  "where": { "platform": "discord", "conversationId": "discord:<guild>:<channel>" | "discord::<dm channel>",
             "conversationKind": "channel" | "dm", "title": "channel name (optional)", "voiceChannelId": "…" },
  "who": { "userId": "…", "displayName": "…" },
  "presence": { "participants": ["…"], "heard": [{ "userId", "name", "text", "at" }], "followsShannonTurn": false,
                "speakingNow": false, "shannonSpokeMsAgo": 4000 /* optional: since she last finished speaking; docs/addressed-contract.md */,
                "situation": "…" },
  "words": "…",
  "voice": { "fillerId": "…", "sttMs": 0, "utteranceMs": 0 }
}
```

Lines, in order: `decision` (`respond`, `reason`, `filler`), `expression` (`affect`, `intensity`, `delivery`: her face, for an entry
that shows one; Discord reads past it), `sentence` (`index`, `text` shown, `voiceText` with the voice's audio tags), `intent`, `done`
(`reply`, `threadId`, `duplicate`, `silent?`, `timings`), or `error` after a first line. A typed message's reply is one `sentence`
(a message is posted whole). Each modality's fields are checked by its own route's validator (`validatedVoiceTurn`,
`validatedPlatformReply`), and a retried `requestId` replays the stored answer.

## Conversations nobody bound, and strangers

With one head a Discord conversation nobody bound is answered as one its people read (`shared`), never as the owner's own; the owner
is the one Discord account the bindings name (with none or two, no conversation is opened). Its title is the channel's name when the
body sends it (a typed message's channel; for the voice channel, the text channel it posts to), else 「Discordの会話」. Someone she cannot remember (people memory off) is answered as a stranger and nothing of them is
kept. The owner's private conversation stays refused to anyone else.

## The apps

The apps' routes are unchanged. A voice stream client that sends `expressionEvents: true` also gets `expression` lines; the iPhone's
reader refuses an unknown line type, so nobody else is sent one (the face is in `voicePlan` as before).

## Her replies on Sonnet (`SHANNON_REPLY_SONNET`, owner 2026-10-21)

Every reply of hers, spoken or written, from every entry and before anyone, is Sonnet 5.5's (`infra/models/replySonnetChatModel.ts`,
wired by `wiring/replySonnetWiring.ts` around the kernel's model, inside the reply check): the plain spoken stream, a voice turn's
structured request (`spokenReply`) and every text turn's reply (`conversationReply`: the apps' Talk, a Talk read aloud on Windows,
Discord's text and dc-voice's turns, her game chat), the check's rewrite included. The router (Jev) and the small helpers keep
their models; anything asking the kernel's model that is not a reply is answered as before.

- **Cached prefix**: the Sonnet model always uses the cache plans (`anthropicCachePlan.ts`, `anthropicVoicePlan.ts`): one system
  (her identity, her space's core a fixed text) and one tool set for every turn; the turn's own lines follow the words.
- **First words early**: Sonnet's voice answers before it thinks (`SHANNON_SONNET_VOICE_THINKING`, `between_tools`), and the apps'
  stream says a reply's first clause (14 characters or more, at a 「、」 outside quotes) at once (`FIRST_CLAUSE_CHARACTERS`); Discord's
  voice already cuts every clause.
- **Guards**: a spoken stream waits for Sonnet's first word or tool call at most 4 s and never into the turn's last 6 s; past it, or
  when Sonnet fails before a word or a tool, Haiku answers the turn. With less than 1 s for it, Haiku answers without asking Sonnet.
- **One cap a day** (`SHANNON_REPLY_SONNET_DAILY_CAP`, default 800): voice and text together, counted per server day in the
  database (`shannon_reply_sonnet_days`, step `emotion/008_reply_sonnet_days`; kept across restarts). Past it replies are Haiku's
  until the day turns, said once in the log; a reply Sonnet did not serve is given back; if the count cannot be read the reply is
  Haiku's. While it is on, the feeling turn's own Sonnet (`SHANNON_FEELING_STRONG_REPLY_MODEL`, 200 a day, 80% for her space)
  stands aside, and a rewrite in her space is waited for as Sonnet's (8 s).

Off (the default; a new installation's example sets it on): every reply's model and request are what they were. To roll back,
`SHANNON_REPLY_SONNET=off` and a restart; the day table stays and is not read.
## Rollback

`SHANNON_ONE_HEAD=off` and a restart. No table or column is added; Discord's turns stay in `platform_voice_turns` and
`platform_reply_turns`. The body's own `SHANNON_ONE_HEAD` decides whether it sends everything here; while this server answers 503 the
body answers as it did before.
