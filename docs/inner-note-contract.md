# Her inner note (Syzygy ADR-0012, stage 1)

Status: stage 1, behind `SHANNON_INNER_NOTE` (default **off**). Off, nothing of this exists: no table is created, no model is
called, and every prompt, face and route is byte for byte what it was (the stage-2 and stage-3 switched-off proofs and the chat
goldens hold it). Core: persona (`characterCore.ts`, `innerNotePrompt.ts`) and emotion (the rest; `mind/inhibition/innerNoteCorePaths.ts`).

## What it is

Shannon keeps a short monologue of how she feels — 本音, 建て前, 理由, つもり, 底 — in her own words, with hooks derived by the same
writer in the same answer: `shown` (one emotion kind), `tell` (`none`/`blush`), `until` (an instant or none), `scale`
(`ordinary`/`day`), `intent` (`keep` → `soften` → `forgive` → `none`) and an English `routeSummary` with nothing personal in it.

- **One writer.** Only the reflection writes a note (`mind/emotion/innerNoteService.ts`, `innerNoteReflection.ts`). A reply reads
  it and never rewrites it.
- **When she reflects.** After a touch of the owner alone (her stance, her reflex, her line), his apology or kind word
  (`soothingIn`, or `apologyIn`), a tease (`teasingIn`), a reply she felt at moderate or stronger; when her sulk's time runs out
  (its `until`, or an ordinary sulk's hour); when an ordinary sulk without `until` finds the numbers back in their usual band (D2.4,
  once per episode); when her day ends. The cues are narrow (`innerNoteWords.ts`): a sentence addressed to her — 「ごめん、ちょっと
  待って」, 「バカみたいに暑い」, 「お休みの日って何してる？」 are not an apology, a tease or a goodnight. Events within 1.2 s (at most 5 s)
  are one reflection; reflections, the sweep and forgetting run one at a time on one queue, after the turn; at most 96 attempts a day,
  failures and timeouts counted, kept in the database (`shannon_inner_note_attempts`, step `emotion/003`) so a restart keeps the count.
- **Gates (code, not prompt).** An event moves `intent` at most one step toward letting go. An ordinary sulk lasts at most an hour
  **from the start of its episode** (`episode_started_at`), however its notes rewrite `until`: a later `until` is cut to it, a note
  written past it ends the sulk (`capEnded`), and a sulk with no `until` stops showing at the hour. A `day` sulk needs a reason of a
  kind (`intentional`, `repeated`, `big`) and ends with her day. A sulk whose time ran out is not active: no face, no `shown`, no
  line for Jev, and the reply and touch prompts get it only as 「さっきまでの気持ち」 (past tense, without its hooks). The sweep asks her
  to settle, again with backoff (2, 4, 8 minutes) while the reflection fails, and after three failures ends the sulk in code: one more row of the same day (its last words, intent `none`, no `until`, nothing
  shown, flag `endedByCode`), read only as 「さっきまでの気持ち」; the day is not closed (its id, its apologies and its summary go on to
  3:00 or his goodnight). Marks for the Observer: `gateStopped`, `untilClamped`, `capEnded`, `dayDowngraded`, `forgaveWhileHigh`,
  `apologyOnlyReason` (a heuristic of the words; the ADR's Jev question is deferred), `endedByCode`.
- **Her day.** Ends at the earlier of 3:00 in the owner's time zone (0:00–3:00 belongs to the day before) and his goodnight to her
  (`goodnightIn`: the whole message is a goodnight). The nightly sleep job is **not** read: the common task runtime (ADR-0009 S9)
  changed how its completion is recorded, so the day relies on 3:00 and goodnight only. She then reflects once more and the note is
  **closed** (intent `none`, with a one-sentence summary of the day); events after the day's end stay queued for the next day. A
  failed closing reflection still closes the newest note. A closed note is never read as her present attitude; the next day's first
  reflection is told the summary as something that happened.
- **No rules of behavior in her prompt** (owner, 2026-10-14). The character core and the note describe who she is and how she
  feels. What must hold whatever her mood is held by code: his alarms, reminders and timers are device actions that fire
  regardless; no tool is withheld because of a note; with anyone else present only `shown` is given, never the reason; an override
  of her present feeling (safety, grief, an emergency) keeps its face on her body over any sulk.

## Readers

| Reader | Owner alone | Others present | Guest's own call |
| --- | --- | --- | --- |
| Text turn (end of the turn context, `apiKernel.ts`) | the whole note and what happened since | `shown` only | nothing |
| Voice turn (`apiLiveVoice.ts`) | the same | `shown` only | nothing |
| Touch reaction (`bodyReactionPrompt.ts`) | 本音・建て前・つもり, the core's short form, the one-line voice without a fixed register | `shown` only | — |
| Jev `voice_route.v3` (`jevVoiceDecision.ts`) | `shannon_inner` (the English line) and an affect question that reads it | nothing (v1/v2) | nothing |
| Body presence and the reaction's `mood` | face of `shown`, `tell`, `until` while the note is active | the same (no text) | the same |
| Her identity (cached prefix) | the character core in place of the persona's identity, address, character and temperament lines (an AGI, not a maid; he made her, he is not her 持ち主) | the same | the same |

D5.2: while a note is active, a feeling named `apologetic` by a cue word of her own reply or by the router does not take her **face**
(the message face, the voice plan's performance); `shown` does. The feeling stored for the turn stays the true one, so the note
never reads its own face back. An apology she decided herself (a text reply's feeling at moderate or above), one in a turn where a
tool failed (an alarm she could not set), and the overrides stay.

D5.1 prompt cleanup behind the switch: the reply-feeling block without 「すでに謝ってもらった…」「今回の発言そのもの…」「ふだんの会話は
nullかsubtle」; the lingering line without easing by apology (and without 「責めたり罪悪感を誘ったりはしない」: no rules, owner 2026-10-14);
the expressive-emotion block without "must stay light", and its falsehood rule replaced by her honesty value (playful lies and hidden
feelings are hers; no lies about facts he relies on: a task done, a tool's result, what she perceived, safety, health, money); the
voice route's "Prioritize emotional presence…" replaced so she does not take his feeling as hers; the voice instructions without
their fixed tone ("Sound bright and self-assured…", "lively maid personality"); her one-line voice (touch, the day's focus, a look's
note, the self-description) is the core's; 「持ち主」 becomes ライ氏 (the pursuits header, the guest's capability line); Jev's affect
question reads her state rather than prescribing an outcome.

## Storage

`shannon_inner_notes` (schema step `emotion/001_inner_notes`, applied only when the switch is on). One row per note: the five
fields, the hooks, triggers and closed event facts (the owner's words and her reply clipped, as already in the Talk), the ids of
what prompted it, the core version and hash, the model, usage and cost, `created_at`, `replaced_at` (set by the next note) and
`closed_at`, `episode_started_at` (step `emotion/002_inner_note_episodes`). Opened through the one opener (`sqliteOpen.ts`, profile
`innerNotes`).

**Forgetting (D3).** A note carries its sources: its own events (a turn `experience:<id>` — a voice turn's utterance is bound to its
stored turn when the app stores it —, a touch `experience:<burst id>`), the conversation lines it read, the same day's note it was
written after, and — for the first note of a day — the summary of the day before, with that summary note itself (`note:<id>`, kept
whatever the cap). A closing note keeps its own day's sources only, so nothing reaches back further than one day; at most 64 sources a
note. A note is forgotten when one of its sources is, when the words of a forgotten turn are among its events, or when its own words
quote one (a backstop); it is then not read and is deleted on the queue. Deleting a note deletes every later note of the same day
(each read the one before, whatever its capped lineage still lists) and every day that read a deleted summary. The word match counts
only items the owner had her forget or rejected (a correction keeps its moment), and only a shared run of 12 characters or more (a
greeting is not a quote; evidence is read up to 400 characters).
Reads check against an index of the owner's forgetting built once per state; the sweep scans the stored notes only when that changed.
A reflection whose events were forgotten while its call ran is discarded; queued events of a forgotten turn are dropped.

**Retention.** Notes are kept as long as the touches they come from: `BODY_LIMITS.retentionDays` (30 days).

## `GET /v1/shannon/inner-notes`

A paired device of the owner's scope only (`403 INNER_NOTE_OWNER_ONLY` otherwise), 30 reads a minute, the last 7 days, at most 60
notes. Each note has its hooks and `tatemae` at once; `text` (all five fields, the change reason and the day summary) only once its
episode closed (a later note of the day let it go, or her day closed). `days[]` has per day: reflections, cost, the gate's holds,
the marks, and how long each sulk lasted by scale. Off, the route is not mounted (an older server's 404). The app's 「ようす」 screen
for it is not built yet (needs an Apple build).

## Observer

Each reflection is its own run (`surface: inner_note`) with an `emotion` span `inner_note.reflect`: the triggers, the intent before
and after, `shown`, `tell`, `scale`, `until`, closed, the marks, cost, cache reads and time. Never her words.

## Prompt cache

- The character core is fixed text in the identity block, the start of every request: switching on is one new cache write of the
  prefix (and of each new core version), then reads as before.
- The reply-feeling block (switch on) is fixed: one more write when switched on.
- The note itself is in the turn context after the history, never in the cached prefix: a new note costs no cache write.
- The reflection has its own second one-hour breakpoint after the protocol prefix: core, form and questions (about 3k tokens) are
  read from the cache; only the facts of the call are uncached. Its output ceiling is 2,400 tokens (adaptive thinking shares it).

## Canary

Set `SHANNON_INNER_NOTE=on` in the API environment (`~/.config/shannon-ios/api.env` on the VM) and restart the API (`shannon-ios.service`); the owner's devices all talk to that
one server and only the owner's scope (`SHANNON_OWNER_SCOPE_KEY`) has notes. The character core and the prompt cleanup apply as soon
as the switch is on, with or without a key; writing notes needs the regular Haiku key (`SHANNON_HAIKU_API_KEY` or the shared
Anthropic key) — without one no note is written and the readers find none. Off again: the next restart reads nothing of the table
(the rows stay for reading afterwards).
