# Her Minecraft body in every conversation, and her live commentary (session dc-live)

Owner 2026-10-20: while she plays (the dragon order), she talks with the owner and friends on Discord and says what she is doing and how
it stands, without being asked; the app and Discord chats can also answer 「今なにしてるの？」 and 「あとどれくらい？」. Two switches, both
off unless set to `on`.

| Switch | Effect |
|---|---|
| `SHANNON_MINECRAFT_LIVE` | A `[マイクラの体の今]` block in the turn context of every text conversation (the app, Discord text through `/v1/platform/reply`), read from the body's newest frame. The moments the frames show are noticed. Nothing is said unasked. |
| `SHANNON_MINECRAFT_LIVE_SPEECH` | With the first: she says a word of her own about a moment, in the voice channel she is in or in one text channel. |

Rolling back is setting either to `off` (or removing it) and restarting the API; the body side is off with `MINEBOT_LIVE_SPEECH` unset.

## The block

`surfaces/minecraft/minecraftLive.ts` keeps the tasks the task bodies tell it (`withMinecraftLive`, wrapped around the body of each step) and
reads the body's newest frame at the time of the turn (`MinecraftControl.latest`, up to two minutes old). `minecraftLiveBlock.ts` writes it:
the task and who asked, what the running tool does, the owner's order's step now and next with the step's target seconds
(`MILESTONE_TARGET_SECONDS`, early or late), the place and time of day, health and hunger, hostiles near (a wall between marked), what she
carries, the map the body keeps (short), the furnace, what happened in the last ten minutes, and how old the picture is.

Privacy follows `withoutRequestTask` of the game chat (S5): the task's words are given only when the owner alone reads (`audience.alone`);
in a shared room only that something was asked is said, and the game's own facts remain. Her own pursuit (`origin: own_time`) is not his matter.
The voice (another session) reads the same object: `dependencies.minecraftLive.block({ alone })`.

## Moments and the governor

The moments are found from the frames the body already sends (`minecraftMoments.ts`): a diamond carried or a diamond ore the map knows, the
full set of armour, a new pickaxe, a near death (health 6 or less, re-armed at 12), hunger, a death, the night, the morning, a night slept
through, another dimension, a lava escape (the reflex counter), a structure the map newly knows, a blaze near, the dragon and the crystals,
the first blaze rod, pearl, eye, flint and steel, ten obsidian and a bed, a step of the order passed or late, a stalled command. The first
frame of a run is only remembered. The body sends nothing new for them.

What happens to her as it happens is read from the same frames (`minecraftMoments.ts`, `fights()` and `company()`): the first hit of a hostile that can
reach her (`attacked`, told at once, and not again until twenty seconds without a hostile at her), a creeper at her side (`scared`), a blow of five
or more with no hostile near (`surprised`), getting away (`got_away`: nothing that can reach her within 8 m for 8 s after a fight), a hostile that
stood at her and is gone (`killed`, "gone, it seems"; never a creeper), coming back (`respawned`), a view she has a plain word for (`scenery`) and another
person coming near after 45 s without one (`player_near`, never a name). Every kind belongs to one of six groups (`liveGroupOf`: danger, fight, find,
body, work, people); a reaction (`liveIsReaction`) is the kind that is about this second.

`@shannon/mind` `LiveGovernor` (`liveGovernor.ts`) decides whether a moment is told now. Salience is a noisy-OR of the kind's weight, a bonus
for the first of its kind (0.2) and one for danger (0.25); the threshold is 0.55 and 0.9 is urgent. Then, in order: staleness (the kind's
lifetime, at most 60 s), a reply being written, someone's words within 8 s (3 s for an important moment) or someone speaking, the minute's
budget (2) and the ten minutes' (7), the gap (18 s, 6 s urgent), the same topic within 90 s (not for an urgent one), the same kind within 4
minutes (10 s for a death, 30 s for a near death). A line must also differ from her last six by a trigram measure (a cry: from the last ones of its
own group, at a lower bar).

A reaction is told in the urgent gap (5 s), and has two words more in the minute than the ordinary talk, up to the six the body's mouth takes
(`LIVE_REACTION_EXTRA_PER_MINUTE`, `LIVE_MOUTH_PER_MINUTE`). The little voices of her body and of the time of day (hunger, night, morning) and being stuck
weigh more than the threshold, so that they are not dropped for being quiet. When she has said nothing for `LIVE_QUIET_SECONDS` (22 s) while she
works and is chatty, the commentary asks the live view for what she is doing (`working`, a moment like the others), so the silence stays well under 40 s. None of it waits on a decision of the task: a
frame only schedules a timer; the model call is on its own; a failure drops the moment.

## The line and the wire

A line is asked as one short request (`infra/models/liveLineModel.ts`: a native Haiku request on the background route `minecraft_line`, no
thinking, 120 tokens at most, the fixed rules cached), not as a conversation turn (which sent the conversation's instructions and a structured reply:
about sixteen thousand tokens in, and the style of a report). Without a Claude key it goes through the conversation turn as it did.

What happens to her (the danger and fight kinds, the view, a person near, hunger, night and morning) is written by `minecraftSceneLine.ts` from the
scene alone (`minecraftLiveScene.ts`: the hostiles at her in her words, her health in words and how fast it fell, what she holds, the odds, whether a
person is near, the time of day, what she was doing in a few words): not her plan, her aim or what she said of her work. The rules say why each is
there and give no line as an example; the feelings of the kind are offered in a rotated order, and the openings of what she said lately of the same
group are named as the ones to avoid.

`minecraftLiveWriter.ts` asks the auxiliary chat model (Haiku) for the other lines (her work, a find, the end of a request) from her identity (the shared-room identity with her character
core), the persona block of her character space for a group, the block written for a shared room, her last live lines, and the moment's fact
lines (in the user's turn with the light request). The answer is cleaned (`cleanLiveLine`: one line, no list, no link, no coordinates, no tool name, 54 characters for a voice and 100
for text) or the moment is dropped.

The control poll (`POST /v1/body/minecraft/control`) gains three optional fields, all ignored by a side that does not know them:
`liveRoom` and `speechReceipts` in the poll (the body: in a voice channel or not, someone speaking, since when someone spoke or wrote; what
became of each line), and `speech` in the reply (at most one line: `id`, `text`, `urgency`, `expiresAt`, `kind`). The outbox
(`minecraftLiveSpeech.ts`) offers a line again after 4 s without a receipt (3 offers), drops it at its time, and tells the engine how each line
ended. A line counts toward the spacing only when the body says it `spoken` or `posted`; a text line is then kept in the platform thread of
its conversation as her own words (`appendNoteOnce`, note kind `minecraft-live`, shared audience), so an answer to it is understood.

## The body

`MINEBOT_LIVE_SPEECH=on` registers a sink at the Discord bot's start (`services/discord/liveSpeechSink.ts`). Voice first: the voice mouth
(`getVoiceMouth().say`) with `source=minecraft:live:<kind>`; with no voice channel, one text channel, `MINEBOT_LIVE_DISCORD_CHANNEL=<guild
id>:<channel id>`, checked on every line (the channel is in that guild, the bot may write in it, no mention at all, quiet for 3 s after a
human wrote there). With neither, nothing is said.

## Not verified

Not run against a live Discord guild, a real voice channel or the lab's Minecraft world; the voice mouth is another session's and is
reached through the shape in `dc-speak-interface.md`.
