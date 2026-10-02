# Chat sentence stream contract (v1, stage 1)

How a client receives a text reply of `POST /v1/chat` sentence by sentence. It is meant for a client that speaks and subtitles the reply, such as Shannon's body on the desktop. Code: `chatSentenceStream.ts`, `chatSentenceSplitter.ts`, `serverChatSentenceStream.ts`; tests: `chatSentenceStream.test.ts`, `chatSentenceSplitter.test.ts`.

Everything here is additive and opt-in. A request without `stream` is answered exactly as before the field existed: the same JSON document, the same model request, the same stored turn.

**Stage 1 — what this version does and does not do.** The server completes the turn first (model call, source list, face, storage) and only then writes the lines, all at once. The client therefore gets ready-cut sentences and one stable wire format, but the first sentence does not arrive earlier than the single JSON response would have. Sending sentences while the model is still writing is stage 2 and is not implemented; see [Stage 2](#stage-2-not-implemented).

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
{"type":"start","threadId":"…","turnId":"…","audience":"owner"}
{"type":"sentence","index":0,"text":"はい、聞こえています。\n\n"}
{"type":"sentence","index":1,"text":"「元気？うん！」と言いましたね。"}
{"type":"done","response":{ "…": "the object the non-streaming response returns" }}
```

| Line | Fields | Meaning |
| --- | --- | --- |
| `start` | `threadId`, `turnId` (when the response has one), `audience` | The turn exists. `audience` is what the server applied. |
| `sentence` | `index` (0, 1, 2, …), `text` | One sentence of the reply. |
| `done` | `response`, optional `fallback` | Terminal. `response` is exactly the object a request without `stream` returns for this turn, including `reply`, `messageEmotion`, `state`, and any `artifacts` and `uiBlocks`. |
| `error` | `status`, `error` | Terminal. The stream failed after it began. |

There is no per-sentence emotion. Text chat has one face per reply (`messageEmotion`, computed from the whole reply); it is in `done.response`. The voice route's `voicePlan` is a per-turn acting plan from a different source and is not reused here.

### Ordering

- Streamed turn: exactly one `start`, then one or more `sentence` lines with `index` rising by one from 0, then exactly one `done`. Nothing follows `done` or `error`; the client need not wait for the connection to close.
- Fallback turn: exactly one line, `done` with `fallback` set. No `start`, no `sentence`.
- Unknown line types and unknown fields must be ignored.

### Equality rule

For a streamed turn, the `text` values joined in `index` order with nothing between them are `done.response.reply`, character for character (the same UTF-16 code units). Nothing is trimmed, collapsed or re-encoded: whitespace and newlines that follow a sentence are the end of that sentence's `text`. A client that speaks a sentence trims it itself and strips Markdown itself.

A reply to which the server appended a list (`### 参照した情報源`, `地図で開く`) is never cut: those turns fall back, so no `sentence` ever holds part of a source or map list.

### Sentences

Deterministic; the same reply always gives the same sentences.

- A sentence ends after `。` `！` `？` `!` `?`, together with any further terminators and closing marks that directly follow (`」』）)】]〉》”"'`), and the whitespace after them.
- A newline ends a sentence; all whitespace up to the next visible character stays with the sentence before.
- No cut inside `「」『』（）()【】[]〈〉《》“”`. A blank line ends a quotation that was never closed.
- No cut inside a ``` code fence, an inline code span on one line, or a URL starting with `http://` or `https://`. An ASCII `!` or `?` directly followed by a letter, digit or one of `=&/_-` is not a terminator.
- A sentence is at most 200 UTF-16 units plus trailing whitespace. A longer run is cut at the last comma, colon or space in its second half, otherwise at 200, never inside a surrogate pair or a joined emoji.
- No sentence is empty or whitespace-only.

## Which turns are streamed

| Turn | Answer | `fallback` |
| --- | --- | --- |
| Ordinary reply, owner alone | streamed | |
| Ordinary reply, `audience: "others"` | streamed | |
| Reply with `artifacts` or a work proposal (`uiBlocks: agent_task_proposal`) | streamed; they are in `done.response` | |
| Explicit command (a fixed reply: 「〜をタスクにして」, 「〜をノートに残して」, an answer to a reminder, a work or memory command) or an organize turn (整理して) | single `done` | `command` |
| Request with `attachments` | single `done` | `attachments` |
| Request with `webSearch: true` | single `done` | `web_search` |
| Place search (a place request; `uiBlocks: place_search`) | single `done` | `place_search` |
| Reply with a source list from a Notion, Aether or Voyager read | single `done` | `sources` |

When several apply, the first in the order attachments, web search, place search, sources is named. The set may change; a client must handle either form for any turn and must not treat `fallback` as an error.

## Safety

The lines are made from the finished response and from nothing else.

- The reply is the one the non-streaming path returns: the model's `reply` field after the structured-output checks, with the source or map list appended. No other transformation of the reply text exists on the text path today; a marker such as `【機微:…】` is placed on prompt input, and keeping it out of the reply is the model's instruction, streamed or not.
- What reaches the model is decided before the model is called and is the same with and without `stream` (the audience gate, withheld memories, capability reads). The field is not read until the response is returned.
- For `audience: "others"` the lines are cut from the response after it was reduced for that audience (`systemPrompt` empty, no `thread`, reduced `state`). `start` carries only the thread id, the turn id and the audience.
- Commands, proposals, artifacts, the thread title and summary, the face, the stored feeling and the background work are handled before the first line and are not affected by the stream.

So a streamed turn exposes exactly the text its single JSON response exposes, to the same reader.

## Errors and disconnects

- A refused request (`400`), a rate limit or busy answer (`429`), an authentication failure (`401`) and a model failure (`502 MODEL_UNAVAILABLE`) are plain JSON with the same status and body as without `stream`. In stage 1 the model has finished before any line is written, so a model failure is never an `error` line.
- If writing fails after the stream began, the server writes `{"type":"error","status":502,"error":"STREAM_FAILED"}` and ends the response.
- The turn is stored before the first line. A client that disconnects at any point, or receives `error`, loses only the lines: the user message and the reply are in the thread, and `GET /v1/conversation?threadId=…` returns them. The client must not send the message again to recover; that would be a second turn.
- A stream that ends without `done` or `error` is a broken connection: refetch the conversation.

## Timeouts

Unchanged. The whole request must arrive within 30 seconds; the model call is bounded at 30 seconds (a place-search turn makes two); an idle connection is closed after 120 seconds, the same as the proxy's read timeout. The proxy does not buffer (`proxy_buffering off`), and the response also says so (`x-accel-buffering: no`). Because nothing is written until the turn is complete, a stage 1 client waits for `start` as long as it waited for the JSON response.

## What a client does on `done`

1. Replace whatever it assembled from the `sentence` lines with `done.response`: it is the authority for `reply`, `turnId`, `messageEmotion`, `state`, `thread`, `artifacts` and `uiBlocks`, exactly as the JSON response is.
2. If `fallback` is present, or no `sentence` arrived, speak and show `done.response.reply` as it would a JSON response.
3. Apply `messageEmotion` and `state` then; no earlier line carries a face.

## Stage 2 (not implemented)

Sending sentences while the model writes needs a decision by the owner, because the response path is core:

- The text model call returns one strict JSON object in which `reply` is a field. Streaming means reading the Responses SSE stream and decoding the `reply` string as it grows, in the chat-model adapter.
- The checks on the rest of that object (work decision and proposal, artifacts, intent plan) run on the complete object and today reject the whole turn with `502`. With real streaming, sentences of a turn that is then rejected would already be shown, and the turn would end with an `error` line and nothing stored. That is weaker than today and must be accepted or designed away.
- `turnId` is created when the turn is stored, after the reply. `start` would need an identifier allocated beforehand, or would carry none.
- The face is computed from the whole reply and stays in `done`.
- `sources`, artifacts and proposals are known only at the end; the fallback for source lists would have to be decided before the model call (from the capability read) instead of from the finished reply.
- An `audience: "others"` turn has no output-side check to run per sentence; it is as safe streamed as not only as long as that remains true. It should keep the stage 1 behaviour until the owner decides otherwise.

The wire format above is written so that stage 2 changes when lines arrive, not what they are.
