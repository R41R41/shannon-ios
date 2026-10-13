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
  (`soothingIn`, or `apologyIn` for an apology anywhere in a short message), a tease (`teasingIn`), a reply she felt at moderate or
  stronger; when her `until` comes; when her day ends. Events within 1.2 s (at most 5 s) are one reflection; reflections run one at
  a time, after the turn; at most 96 a day (a cost guard).
- **Gates (code, not prompt).** An event moves `intent` at most one step toward letting go; `until` is at most an hour for
  `ordinary`, and `day` needs a reason of a kind (`intentional`, `repeated`, `big`) and ends with her day. Marks for the Observer:
  `gateStopped`, `untilClamped`, `dayDowngraded`, `forgaveWhileHigh` (the numbers still high), `apologyOnlyReason` (a heuristic of
  the words; the ADR's Jev question is deferred).
- **Her day.** Ends at the earliest of 3:00 in the owner's time zone (0:00–3:00 belongs to the day before), the nightly sleep job
  for that day completing, or his goodnight (`goodnightIn`). She then reflects once more and the note is **closed** (intent `none`,
  with a one-sentence summary of the day). A failed closing reflection still closes the newest note. A closed note is never read
  as her present attitude; the next day's first reflection is told the summary as something that happened.
- **No rules of behavior in her prompt** (owner, 2026-10-14). The character core and the note describe who she is and how she
  feels. What must hold whatever her mood is held by code: his alarms, reminders and timers are device actions that fire
  regardless; no tool is withheld because of a note; with anyone else present only `shown` is given, never the reason.

## Readers

| Reader | Owner alone | Others present | Guest's own call |
| --- | --- | --- | --- |
| Text turn (end of the turn context, `apiKernel.ts`) | the whole note and what happened since | `shown` only | nothing |
| Voice turn (`apiLiveVoice.ts`) | the same | `shown` only | nothing |
| Touch reaction (`bodyReactionPrompt.ts`) | 本音・建て前・つもり, the core's short form, the one-line voice without a fixed register | `shown` only | — |
| Jev `voice_route.v3` (`jevVoiceDecision.ts`) | `shannon_inner` (the English line) and an affect question that reads it | nothing (v1/v2) | nothing |
| Body presence and the reaction's `mood` | face of `shown`, `tell`, `until` while the note is active | the same (no text) | the same |
| Her identity (cached prefix) | the character core in place of the persona's identity, address, character and temperament lines (an AGI, not a maid; he made her, he is not her 持ち主) | the same | the same |

D5.2: while a note is active, a feeling named `apologetic` by a cue word of her own reply or by the router does not take her face;
`shown` does. An apology she decided herself (a text reply's feeling at moderate or above) and the overrides stay.

D5.1 prompt cleanup behind the switch: the reply-feeling block without 「すでに謝ってもらった…」「今回の発言そのもの…」「ふだんの会話は
nullかsubtle」; the lingering line without easing by apology; the expressive-emotion line without "must stay light"; the voice route's
"Prioritize emotional presence…" replaced so she does not take his feeling as hers; the voice instructions' "lively maid personality"
without "maid".

## Storage

`shannon_inner_notes` (schema step `emotion/001_inner_notes`, applied only when the switch is on). One row per note: the five
fields, the hooks, triggers and closed event facts (the owner's words and her reply clipped, as already in the Talk), the ids of
what prompted it, the core version and hash, the model, usage and cost, `created_at`, `replaced_at` (set by the next note) and
`closed_at`. A note whose source turn the owner had her forget is deleted on the next sweep (every minute).

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
  read from the cache; only the facts of the call are uncached.

## Canary

Set `SHANNON_INNER_NOTE=on` in the API environment (`~/.config/shannon-ios/api.env` on the VM) and restart the API (`shannon-ios.service`); the owner's devices all talk to that
one server and only the owner's scope (`SHANNON_OWNER_SCOPE_KEY`) has notes. It needs the regular Haiku key
(`SHANNON_HAIKU_API_KEY` or the shared Anthropic key); without one nothing is written and nothing else changes. Off again: the next
restart reads nothing of the table (the rows stay for reading afterwards).
