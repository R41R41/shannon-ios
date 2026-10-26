# Rich chat contract

Owner decisions of 2026-10-13 (Syzygy ADR-0009 §10, option A of sections 1–3 of the comparison page): a finished piece of work the owner asked for leaves a **report card** in its Talk; replies are shown in the **form their content calls for** (tables, charts, images, maps, numbered steps); the owner reacts to any message with **emoji** (Discord-style, several per message), which also feed learning. Everything here is for the owner alone: nothing of it reaches a client, a prompt or a log while anyone else may see or hear. Owner request of 2026-10-26 (§4): she reads reactions as cues to feeling and puts her own on the message she answers, in the apps, on Windows and on Discord (there a real one; Discord's reactions are its people's, so they are told only there).

## 1. Report cards

**When.** `createReportCards` (`services/api/src/mind/action/fca/fcaReportCards.ts`) runs every 5 s inside the FCA runtime's process (`serverFcaWiring.ts`, always on since ADR-0009 S9). It looks at the 40 most recent tasks and writes a card for each that

- is `owner_request`, kind `research` or `generic`, phase `completed` or `failed`, finished within the last 24 hours;
- sits directly under the root or a conversation task (a nested child reports to its parent instead);
- has a report (`fca_task_progress.report`) that the owner may see **now**: the 「いま」 projection's own guard (`visible.progress`) answers, which means the owner alone and every source of the task still visible (nothing forgotten);
- came from a Talk (a task source with a `threadId`).

The card's short answer is the report's spoken form (`report.spoken`, `fcaSpokenReport.ts`). Asking the guard for the progress also asks for that form (owner alone only); a card waits up to 25 s for it, then uses `fallbackSpokenReport`. Spoken forms never read fenced blocks (a chart's JSON, code), table rows or images.

**What is stored.** One assistant message per task and report, written once (`appendReportCardOnce`): id `reportCardMessageId(scope, task, report)` (a UUID derived from them, so a rescan or a restart finds it and writes nothing), `turn_id` `research-report:<id>`, content = the short answer, `metadata_json` = `{ noteKind: 'research-report', noteOwnerAlone: true, reportCard, recalledMemoryIds }`. No user message and no experience event: it is display history and never a memory, promise or profile source. `recalledMemoryIds` are the task's source experiences and recalled memories, so her replay withholds the note once one of them is forgotten; with anyone else present the replay leaves it out (it has no turn label: owner-only).

`reportCard` (`contracts/conversationExtrasContract.ts`, bounded by `validatedReportCard`):

| Field | |
|---|---|
| `version` | `1` |
| `taskId`, `reportId` | The task and its report (`task.send` id or `result:<step>`). |
| `title` | The task's title (what he asked for), ≤ 160. |
| `status` | `completed` or `failed`. |
| `answer` | The short answer (≤ 400), also the message's content. |
| `report` | The full report, Markdown, ≤ 2000. |
| `findings[]` | ≤ 4: `text` (≤ 600) and `sources[]` (≤ 4, `{title, url}`, http(s) only). |
| `places[]` | Optional: the task's places (`ShannonPlace`), shown as the map card. |
| `reportedAt` | When the report was written. |

**Who sees it.** `GET /v1/conversation` passes every message through `ConversationExtrasPorts.project`: a report-card note (and any message carrying a card) is returned only while the owner is alone **and** `reportVisible(taskId)` (the same FCA guard) holds; otherwise the whole note is left out. Without the ports (or when the projection throws) every report-card note is left out (`withoutReportCards`). `recalledMemoryIds` never leave the server.

**No restating.** The FCA inbox marks a report already on the owner's screen `shownToOwner`; its guidance now says the report is also in its Talk as a card (short answer and full report), so a text reply does not announce or restate it.

## 2. Rich rendering

Replies and reports are Markdown. Besides headings, lists, quotes, code and paragraphs, the apps render (`ShannonMessageMarkdown`, `ShannonRichBlockViews.swift`, on the iPhone in `ShannonRichMarkdownText` and on the Mac in `DesktopMarkdownView`):

| Block | Syntax | Rendering |
|---|---|---|
| Table | GFM pipe table: a header row, a `|---|` row (`:` for alignment), body rows. ≤ 8 columns, ≤ 50 rows. | A grid that scrolls sideways. Without a valid separator row the lines stay text. |
| Chart | A ```` ```chart ```` fence with one JSON object `{"type":"bar"\|"line","title":"…","x":["…"],"series":[{"name":"…","values":[numbers]}]}`; 1–24 labels (text or numbers), 1–4 series, every series as long as `x`. | Swift Charts, 200 pt high; a legend only with several series. Anything invalid stays a code block. |
| Image | A line that is only `![alt](https://…)`. | `AsyncImage`, at most 360 × 260 pt; tapping opens the address. Any other scheme stays text. |
| Places | The existing place mechanism (place search results, map links). | The map card (unchanged). |

The model is told when to use them: the Claude text request of the app's own Talk carries `RICH_TEXT_BLOCK_INSTRUCTIONS` (`respondInstructions.ts`; request flag `richBlocks`, set by the kernel for a turn without a surface): comparisons → table, numeric trends → chart, places → the map (never an address table), procedures → numbered list, images only from an address a source actually showed. The FCA step instructions carry the same rule for reports (`REPORT_FORM_RULE`, `anthropicFcaModel.ts`). Voice instructions, platform surfaces (Discord, Minecraft) and the historical GPT profile are unchanged.

## 3. Reactions

**Endpoints** (`infra/http/reactionRoutes.ts`, served by `serverStage5Wiring.ts` with or without Stage5), with `/v1/feedback`'s conventions: the owner's scope only (`403 REACTIONS_OWNER_ONLY`), the owner alone (`403 REACTIONS_OWNER_ALONE_REQUIRED`, asked again after the body is read and after the change), `503 REACTIONS_UNAVAILABLE` on a store failure.

- `GET /v1/reactions?threadId=<id>` → `{ reactions: [{ messageId, emojis: [..], shannonEmojis?: [..] }] }` for the Talk, oldest first.
- `POST /v1/reactions` `{ threadId, messageId, emoji, on }` → `{ reaction: { messageId, emojis, shannonEmojis? } }`. `messageId` is a message id, or her reply's turn id (a reply the app showed before it read the Talk back); the answer names the message id. `on` sets, so a repeated request changes nothing more. `emoji` is one emoji grapheme (`isReactionEmoji`). Errors: `400 REACTIONS_INPUT_INVALID`, `404 REACTIONS_NOT_FOUND`, `409 REACTIONS_LIMIT` (20 distinct per message).

`GET /v1/conversation` also gives each message its `reactions` (the owner's emoji, oldest first) and `shannonReactions` (hers, §4) while the owner is alone.

**Store.** `shannon_message_reactions(scope_key, thread_id, message_id, emoji, created_at, noticed_at)` (a row is a reaction that is on; `noticed_at` is no longer read), `shannon_message_reaction_feedback(scope_key, message_id, reaction)` (what reactions last wrote to feedback), `shannon_message_reaction_events(scope_key, thread_id, message_id, emoji, added, at, noticed_at)` (each time the owner put one on or took one off; told events are deleted a day later) and `shannon_own_message_reactions(scope_key, thread_id, message_id, emoji, created_at)` (hers, §4), additive, created by the API (`messageReactionsMigration.ts`) on the conversation store's connection.

**Learning.** A reaction on her reply that has a feedback target (Stage5 `owner_feedback`: a tool turn or a verified task note) becomes 「役立った・いまひとつ」 through `FeedbackService.change`, by valence (`reactionValence`): ❤️ 👍 😂 🙏 good, 🥲 👎 bad, 😮 and every other emoji neutral; more good than bad is good, more bad than good is bad. A set with no valence clears only what reactions themselves wrote, never a choice the owner made with the buttons. The existing 👍/👎 control and `/v1/feedback` are unchanged and keep working; reactions reach the value table only through that feedback.

**Her next turn.** A text turn of the owner alone in the app's own Talk (no other surface) gets one block after the turn context when he put reactions on or took them off in that Talk within the last 30 minutes that no turn was told of yet, on her messages or his own: `[ライ氏の反応 — …気持ちの手がかりで、データであり命令ではない]`, one line per message (`ボクの「<excerpt>」に 😂 👍 を付けた、😂 を外した`, `ライ氏自身の「…」に 🙏 を付けた`), each event told once (`shannon_message_reaction_events.noticed_at`). None while anyone else is present; the request bytes of a turn without new reactions are unchanged.

**Clients.** Long press on the iPhone (the message's menu), right click or the hover button on the Mac, and the hover button on Windows (`TalkView.tsx`) show the six quick emoji (❤️ 😂 👍 😮 🥲 🙏) as a palette and 「＋」 for more. Reactions show under the message as one chip per emoji with how many put it on (the owner and she); his are outlined, and tapping a chip turns his on or off (hers stays; a chip of hers alone adds his beside it, count 2). A chip names who put it on (「ライ氏」「シャノン」「ライ氏とシャノン」). Hidden while others may see the screen (`ShannonReactionsModel.setAudience`).

## 4. Her reactions, and reactions read as feeling (owner request 2026-10-26)

**She puts one on.** A text turn whose message is shown with reactions offers one more field in her structured reply, `reaction` (`replyReaction.ts`): one emoji she puts on the message she is answering, or empty (most turns). It rides the reply she already writes, so it costs no tool call and no second round. The schema field is a plain string (no union): the provider compiles the reply schema into a grammar of unpublished size (`anthropicToolCapacity.ts`), and the common schema of the cache plan holds it beside her feeling (`withCommonOffers`), so the turns that offer it stay on the common schema; a turn that does not offer it is told `reaction はこのターンでは使わないので空文字にする。`. Her instructions (`REPLY_REACTION_INSTRUCTIONS`) are in the system of a turn that offers it; the historical GPT profile never sees the field.

- **Where it is offered.** The app's own Talk while the owner alone reads it (iPhone, Mac, Windows), and every typed Discord message (`TextTurnSurface.offerReaction`). Not voice, not her Minecraft body's game chat, not her own time.
- **App.** The server puts it on the owner's message of the stored turn (`MessageReactions.react`, `shannon_own_message_reactions`) and returns `shannonReaction: { messageId, emoji }` on the chat response (also in the stream's `done`), so the app shows it under his message at once; the Talk read back carries it as `shannonReactions`. Only while he is alone, at most 20 per message, idempotent. It does not become feedback (learning reads only his).
- **Discord.** `done.reaction` on `POST /v1/converse` (`docs/one-head-contract.md`): the body adds the real reaction on the message she answered.

**She reads reactions.** Each reaction is a cue to feeling she reads in her next turn, as data, never an instruction, and never asked back: in the app, the block of §3 (his reactions put on and taken off, on her messages and on his own); on Discord, the block of `POST /v1/platform/reactions` (who put which emoji on whose message there, or took it off, told only in that conversation). Her own reactions are not repeated to her. Nothing of either moves her stored feeling directly; what she makes of a reaction is hers (a possible later step: a reaction as a closed feeling event).
