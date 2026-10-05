# Chat sentence stream contract (v1)

How a client receives a text reply of `POST /v1/chat` sentence by sentence. It is meant for a client that speaks and subtitles the reply, such as Shannon's body on the desktop. Code: `chatSentenceStream.ts`, `chatSentenceSplitter.ts`, `serverChatSentenceStream.ts`, and in the provider adapter `chatModelStream.ts`, `chatReplyStreamDecoder.ts`, `chatModelTurn.ts`. Tests: `chatSentenceStream.test.ts`, `chatSentenceEarly.test.ts`, `chatSentenceSplitter.test.ts`, `chatReplyStreamDecoder.test.ts`, `chatModelStream.test.ts`, `chatModelGolden.test.ts`.

Everything here is additive and opt-in. A request without `stream` is answered exactly as before the field existed: the same JSON document, the same provider request bytes, the same stored turn.

There are two ways an opted-in turn is sent, and the lines are the same in both:

- **While the model writes** (owner decision 2026-10-02). For a turn only the owner reads, sentences are sent as the model produces them. The first sentence arrives before the reply is complete. Such a turn can be **retracted**: see [Errors](#errors-retraction-and-disconnects).
- **After the turn is complete.** Every other streamed turn is completed, checked and stored first, and then its lines are written together. Nothing arrives earlier than the JSON response would have.

Which turn is sent which way is listed under [Which turns are streamed](#which-turns-are-streamed). `SHANNON_CHAT_STREAM_EARLY=off` (API environment, applied by a restart) sends every turn the second way.

## Request

`POST /v1/chat` with the usual body plus one field:

```json
{ "scopeKey": "owner", "threadId": "…", "message": "聞こえてる？", "audience": "owner", "stream": "sentences" }
```

- `stream` absent: one JSON document (`content-type: application/json`), unchanged.
- `stream: "sentences"`: a successful turn is answered as NDJSON (below).
- Any other value: `400` `stream is invalid`, no model call, nothing stored.

It is a field on the existing route, not a second route, so authentication, the per-device rate limit (20 chat requests a minute), the two-concurrent-chats limit, request validation and the 64 KiB body limit are the same code for both forms. A server older than this contract ignores the field and answers with JSON; a client must therefore look at `content-type` and accept both.

## Response

`200`, `content-type: application/x-ndjson; charset=utf-8`, `cache-control: no-store`, `x-accel-buffering: no`. Each line is one JSON object followed by `\n`. These are the headers and the writer of the voice route `POST /v1/voice/gemini/cascade/delegations/stream`.

```json
{"type":"start","threadId":"…","audience":"owner"}
{"type":"sentence","index":0,"text":"はい、聞こえています。\n\n"}
{"type":"sentence","index":1,"text":"「元気？うん！」と言いましたね。"}
{"type":"done","response":{ "…": "the object the non-streaming response returns" }}
```

| Line | Fields | Meaning |
| --- | --- | --- |
| `start` | `threadId`, `audience`, optional `turnId` | Sentences follow. `audience` is what the server applied. `turnId` is present only when the turn was already stored when the line was written; a turn sent while the model writes has none here. The turn id is always in `done.response.turnId`. |
| `sentence` | `index` (0, 1, 2, …), `text` | One sentence of the reply. |
| `done` | `response`, optional `fallback` | Terminal. `response` is exactly the object a request without `stream` returns for this turn, including `reply`, `turnId`, `messageEmotion`, `state`, and any `artifacts` and `uiBlocks`. |
| `error` | `status`, `error` | Terminal. See [Errors](#errors-retraction-and-disconnects). |

There is no per-sentence emotion. Text chat has one face per reply (`messageEmotion`, computed from the whole reply); it is in `done.response`. The voice route's `voicePlan` is a per-turn acting plan from a different source and is not reused here.

### Ordering

- Streamed turn: exactly one `start`, then one or more `sentence` lines with `index` rising by one from 0, then exactly one `done` or one `error`. `start` is written together with the first sentence, never alone. Nothing follows `done` or `error`; the client need not wait for the connection to close.
- Fallback turn: exactly one line, `done` with `fallback` set. No `start`, no `sentence`.
- Unknown line types and unknown fields must be ignored.

### Equality rule

For a turn that ends with `done`, the `text` values joined in `index` order with nothing between them are `done.response.reply`, character for character (the same UTF-16 code units). Nothing is trimmed, collapsed or re-encoded by the stream: whitespace and newlines that follow a sentence are the end of that sentence's `text`. A client that speaks a sentence trims it itself and strips Markdown itself.

The stored reply has no leading or trailing whitespace (the adapter trims the model's `reply`). While the model writes, leading whitespace is therefore never sent and whitespace is held until a visible character follows it, so the rule holds for early sentences as well. The server checks it before `done`: if what it sent early is not the beginning of the finished turn's lines, it ends the stream with `error` instead.

A reply to which the server appended a list (`### 参照した情報源`, `地図で開く`) is never cut: those turns fall back, so no `sentence` ever holds part of a source or map list.

### Sentences

Deterministic; the same reply gives the same sentences however the model's output was cut into pieces on the way.

- A sentence ends after `。` `！` `？` `!` `?`, together with any further terminators and closing marks that directly follow (`」』）)】]〉》”"'`), and the whitespace after them.
- A newline ends a sentence; all whitespace up to the next visible character stays with the sentence before.
- No cut inside `「」『』（）()【】[]〈〉《》“”`. A blank line ends a quotation that was never closed.
- No cut inside a ``` code fence, an inline code span on one line, or a URL starting with `http://` or `https://`. An ASCII `!` or `?` directly followed by a letter, digit or one of `=&/_-` is not a terminator.
- A sentence is at most 200 UTF-16 units plus trailing whitespace. A longer run is cut at the last comma, colon or space in its second half, otherwise at 200, never inside a surrogate pair or a joined emoji.
- No sentence is empty or whitespace-only.

While the model writes, a sentence is sent once the characters that decide its end have arrived; the last sentence is sent when the turn is complete.

## Which turns are streamed

| Turn | Lines | When | `fallback` |
| --- | --- | --- | --- |
| Reply to the owner alone, with or without an Aether note or Voyager task read, and no Notion page read | `start`, sentences, `done` | **while the model writes** | |
| The same turn producing `artifacts` or a work proposal (`uiBlocks: agent_task_proposal`) | the same; they are in `done.response` | **while the model writes** | |
| `audience: "others"` | `start`, sentences, `done` | after the turn is complete | |
| `SHANNON_CHAT_STREAM_EARLY=off`, or a model that cannot stream (`local-stub`) | `start`, sentences, `done` | after the turn is complete | |
| Reply with a source list (a Notion read) | single `done` | after | `sources` |
| Explicit command (a fixed reply: 「〜をタスクにして」, 「〜をノートに残して」, an answer to a reminder, a work or memory command) or an organize turn (整理して) | single `done` | after | `command` |
| Request with `attachments` | single `done` | after | `attachments` |
| Request with `webSearch: true` | single `done` | after | `web_search` |
| Place search (a place request; `uiBlocks: place_search`) | single `done` | after | `place_search` |

All of this is decided before the model is called. When several fallbacks apply, the first in the order attachments, web search, place search, sources is named. The set may change; a client must handle either form for any turn and must not treat `fallback` as an error.

## Safety

- The reply is the one the non-streaming path returns: the model's `reply` field after the structured-output checks, with the source or map list appended. No other transformation of the reply text exists on the text path; a marker such as `【機微:…】` is placed on prompt input, and keeping it out of the reply is the model's instruction, streamed or not.
- What reaches the model is decided before the model is called and is the same with and without `stream` (the audience gate, withheld memories, capability reads).
- An `audience: "others"` turn is never sent while the model writes. Its lines are cut from the response after it was completed and reduced for that audience (`systemPrompt` empty, no `thread`, reduced `state`), so a streamed `others` turn exposes exactly the text its JSON response exposes. `start` carries only the thread id, the turn id and the audience.
- A turn is sent while the model writes only when nothing after the model call can change its reply text: no list is appended (no web search, no place search, no Notion page read). An Aether note or a Voyager task read happens before the model call and does not change the reply text, so such a turn is sent while the model writes (owner decision, 2026-10-02). Only the `reply` field of the model's structured output is ever decoded; the title, summary, work decision, proposal, plan and artifacts are never sent as text.
- What early streaming gives up, by the owner's decision, is one thing: the checks on the *rest* of the model's output (work decision and proposal, artifacts, intent plan, a truncated or malformed turn) run when the model has finished. If they reject the turn, sentences of it have already been shown. The turn is then ended with `error`, nothing of it is stored, and the client discards what it showed. Without `stream` the same turn is a `502` and nothing is shown.
- Commands, proposals, artifacts, the thread title and summary, the face, the stored feeling and the background work are not affected by the stream.

## Errors, retraction and disconnects

**Before any line** — a refused request (`400`), a rate limit or busy answer (`429`), an authentication failure (`401`), and a model failure before the first sentence (`502 MODEL_UNAVAILABLE`) are plain JSON with the same status and body as without `stream`.

**`error` after `sentence` lines** — the client must **discard every sentence of this response**: remove the subtitles, stop the speech, show no reply. Then it reads `GET /v1/conversation?threadId=…` once:

| `error` | Meaning | Stored? |
| --- | --- | --- |
| `{"status":502,"error":"MODEL_UNAVAILABLE"}` | The model call failed or its completed turn was rejected after sentences were sent (retraction). | No. The thread has neither the user message nor a reply; the client may offer to send the message again. |
| `{"status":502,"error":"STREAM_FAILED"}` | Writing failed, or the early sentences did not match the finished reply. | Yes, the turn is complete. The conversation has the authoritative reply. |

The conversation is the authority in both cases; a client need not distinguish them by code.

**Disconnects** — the turn never depends on its reader. A client that disconnects at any point, including while the model writes, loses only lines: the model call continues, the turn is completed and stored, and `GET /v1/conversation` returns it. A stream that ends without `done` or `error` is a broken connection: discard the sentences and read the conversation. Do not send the message again unless the conversation shows that the turn is absent.

## Timeouts

Unchanged. The whole request must arrive within 30 seconds. The model call has one budget of 30 seconds from the request to its last event, streamed or not (a place-search turn makes two calls and is not streamed). An idle connection is closed after 120 seconds, the same as the proxy's read timeout. The proxy does not buffer (`proxy_buffering off`), and the response also says so (`x-accel-buffering: no`). The server does not wait for a slow reader: lines are queued and the model call is never held back by the connection.

## What a client does on `done`

1. Replace whatever it assembled from the `sentence` lines with `done.response`: it is the authority for `reply`, `turnId`, `messageEmotion`, `state`, `thread`, `artifacts` and `uiBlocks`, exactly as the JSON response is.
2. If `fallback` is present, or no `sentence` arrived, speak and show `done.response.reply` as it would a JSON response.
3. Apply `messageEmotion` and `state` then; no earlier line carries a face.

## Provider side

- The streamed call sends the non-streaming request body with `"stream": true` appended and nothing else changed: the same model, instructions, schema, token limit and identifiers (`chatModelTurn.ts`; `chatModelGolden.test.ts` holds the non-streaming bytes to a fixture recorded before the split, and `chatModelStream.test.ts` holds the streamed body to those bytes plus the one field).
- The completed response is read by the same code as the non-streaming response: parse and check the structured turn, then record usage in the `chat` lane, then build the result. A turn rejected by the checks records no usage, streamed or not. A stream the provider failed records usage only when the provider reported it.
- `reply` is decoded from the JSON text as it grows (`chatReplyStreamDecoder.ts`). If `reply` is not the first field, or is not a string, nothing is sent early and the turn is sent after it is complete. Every other field of the structured output comes after `reply` (the feeling she decides for the reply, `feeling`, directly after it), so none delays the first sentence, and the decoder reads none of them.

## The voice route

`POST /v1/voice/gemini/cascade/delegations/stream` (the iPhone's voice conversation; `serverLiveVoiceStreamRoute.ts`) uses the same headers and writer, with its own lines. Unknown line types are not tolerated by apps up to Build 136, so new information is added as optional fields, never as a new line type.

| Line | Fields | Meaning |
| --- | --- | --- |
| `plan` | `voicePlan` | The acting plan of the turn; it may be sent again, reconciled with the first sentence. |
| `segment` | `text`, `voicePlan` | One complete spoken sentence (the waiting phrase is the first, with its own acting plan). |
| `completed` | `response` | Terminal. `response` is the body of `POST /v1/voice/gemini/cascade/delegations` for this turn. |
| `error` | `status`, optional `code` | Terminal. The reply failed. `code: "content_filter"`: the provider withheld it, and a client drops what it was saying. Without a code, sentences already said may be kept as a reply cut off (the iPhone does so from Build 137). A `502` before any line carries the same optional `code` in its JSON body. |

- **A reply cut at its length limit** (owner decision 2026-10-05). When the model stops at its output ceiling, the turn still ends with `completed`. The reply ends at its last complete sentence: the unfinished sentence is in no `segment` and not in `response.reply`, and `response.truncated` is `true` (absent otherwise). If not one sentence was finished, the words written are kept and sent as one `segment`. The non-streaming `/delegations` response is cut and marked the same way. A client that does not know the field treats the turn as an ordinary completed reply, which it is.
- **Timeouts.** The model call of a streamed voice reply has no total limit: 20 seconds to its first word (30 seconds when the turn searches the web) and 30 seconds with nothing arriving afterwards. Text chat keeps the single 30-second budget above.
