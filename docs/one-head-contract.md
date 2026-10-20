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
- **Two ways to speak**: voice is the one voice turn (`apiLiveVoice.ts`): the router decides whether to answer, what to recall and her face,
  and her plain words stream; the apps and Discord's voice channel go through it. Text is the text turn (`ShannonApiKernel.textTurn`):
  the apps' Talk, Discord's text and her game chat go through it.

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
                "speakingNow": false, "situation": "…" },
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
body sends it, else 「Discordの会話」. Someone she cannot remember (people memory off) is answered as a stranger and nothing of them is
kept. The owner's private conversation stays refused to anyone else.

## The apps

The apps' routes are unchanged. A voice stream client that sends `expressionEvents: true` also gets `expression` lines; the iPhone's
reader refuses an unknown line type, so nobody else is sent one (the face is in `voicePlan` as before).

## Rollback

`SHANNON_ONE_HEAD=off` and a restart. No table or column is added; Discord's turns stay in `platform_voice_turns` and
`platform_reply_turns`. The body's own `SHANNON_ONE_HEAD` decides whether it sends everything here; while this server answers 503 the
body answers as it did before.
