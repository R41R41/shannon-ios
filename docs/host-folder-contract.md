# Host folder contract (v2: her own folder, read and edit; v1 copies unchanged)

What the device that works in Shannon's own folder must send and may read. Her folder is one folder the owner chose on the owner's Windows PC or Mac (Syzygy ADR-0002: a free domain, `host_folder`). The process that touches the folder lives in another repository and has no network and no token; the desktop application's main process, paired like any other device, pulls work from this server and hands it over. This document and the contract tests `services/api/tests/autonomyHostFolder.test.ts` (v1) and `services/api/tests/hostFolderOperations.test.ts` (v2) are what that side is built against. The bounds and codes are in `services/api/src/autonomyHostFolderPath.ts` and `services/api/src/hostFolderOperations.ts`.

**v2 (owner decision 2026-10-05)** gives Shannon full tools over her own folder, from every surface (text chat, voice, her own time): list, search, read, create, update, rename, move, delete. Deleting or overwriting never destroys anything: the device first moves the old file into the trash inside her folder (`.shannon/trash/`). Files the owner placed in the folder may be read freely; editing or deleting them keeps the original in the trash like any other file. Everything in v2 is additive: a v1 device (no `protocol` field in its claim) is handed exactly what it was handed before, and the v1 routes, fields, and codes keep their meaning.

The contract in one paragraph: a tool call (from a conversation with the owner, or a step of her own time) **queues an operation** for her folder. The one device bound to that host holds a **long-poll claim** open (`POST /v1/autonomy/host-steps/claim`, up to 25 s), receives the operation about a second after it was queued, carries it out inside the folder, and **reports** an outcome, a code, and for reading operations a bounded **result** (`POST /v1/autonomy/host-steps/{id}/report`). The tool waits a few seconds for that report; when the device has not polled in the last 40 s the tool fails at once with 「PCのフォルダはいま見られない」 and nothing is queued. The server never calls the device and never sees the folder.

## Who decides what

| Check | Where | Notes |
| --- | --- | --- |
| The host is registered and has a bound device | Server | Otherwise `unknown_host` (gate) or `403 HOST_NOT_BOUND` (routes), as in v1. |
| The tool may be used at all on this surface and with this audience | Server, in the one tool gate (`authorizeToolCall`) | Folder tools are offered only to the owner alone (text chat, voice, her own time). Never with a guest or 「友人も一緒」. |
| Her own-time steps: stop switch, server switch, budget, activity record | Server, in `authorizeAutonomousAction` (domain `host_folder`) | Conversation calls are owner-called work: not charged to her budget and not stopped by her pause; they are still written to the activity record. |
| The path is relative, spelled safely, outside `.shannon/`, and (for content) names a text file | Server, before queuing (lexical only) | See [Path rules](#path-rules) and [v2 path rules](#v2-path-rules). |
| The real location is inside the folder; no symlink, junction, or reparse point is followed; `.shannon/` is not touched | **Device** | Reported as `refused` with a code. The server takes the device's word. |
| A file is text (extension **and** content check), sizes, existing files, free space, disk errors | **Device** | Reported as `failed` or `refused` with a code. |
| The device's own stop switch | **Device** | While it is on, the device sends `localStop: true` and runs nothing (see [Presence](#presence-and-the-local-stop-switch)). |

The gate (`authorizeAutonomousAction`) accepts a `host_folder` request in two forms. The earlier form, `{ host, paths: [absolute…] }`, is for a folder this server can reach itself and is judged by physical resolution exactly as before; for a folder on a Windows PC it can never resolve on the Linux VM, which is why it was always refused. The form used here is `{ host, relativePath }`: the host must have a bound device and the path must pass the rules below. The two forms cannot be combined, and `relativePath` is refused for every other domain.

## Registration

`SHANNON_AUTONOMY_HOST_FOLDERS_JSON` on the API **and** on the activity loop (both read the same environment file):

```json
{
  "owner-windows": { "deviceId": "0123456789abcdef" },
  "owner-mac": "/Users/owner/Shannon"
}
```

| Value of an entry | Meaning |
| --- | --- |
| `"<absolute folder>"` | The earlier shape, unchanged: a folder this server can reach itself. No device is bound, so nothing is queued for it and no device can claim for it. |
| `{ "deviceId": "<id>" }` | Her folder on the owner's machine. `deviceId` is the 16 lower-case hexadecimal characters of a paired device (`GET /v1/devices` lists them with `deviceId` and `isCurrent`). Only that device may claim steps for the host. The server does not know where the folder is. |
| `{ "folder": "<absolute folder>", "deviceId": "<id>" }` | Both. |

- A host name is 1–40 characters of `a-z`, `0-9`, `-`, starting with a letter or digit. An entry with another name, or a `deviceId` in another shape, is ignored.
- An unreadable value registers nothing. With no bound device the copy step is never planned and every claim answers `403`.
- The Mac is registered the same way: another entry with the Mac application's device id. Nothing else is specific to a platform on the server.
- Revoking the device (`POST /v1/devices`) stops it at authentication. Removing or changing the entry needs a restart of both services.
- With several bound hosts, a copy goes to the first registered host that does not have that version of the piece yet.

## Transport

- JSON over the existing paired HTTPS endpoint. `Authorization: Bearer <device token>`. The device is taken from its token, never from the body. A fixed-token or local caller has no device and is refused.
- `scopeKey` is required in every body. For a paired device the server replaces it with the device's own scope.
- Both routes are `POST`. No other field than the ones listed (here and in v2) is accepted.
- There is no push and no stream: the device polls. A v1 device polls about once a minute; a v2 device keeps a long-poll open (see v2). A claim that returns nothing leaves no trace in the activity record.

## v1: `POST /v1/autonomy/host-steps/claim`

```json
{ "scopeKey": "owner", "host": "owner-windows" }
```

Response `200`:

```json
{
  "step": {
    "id": "5f0c1c5e-3b0a-4a51-9c58-2f6a8f0f3b11",
    "operation": "write",
    "relativePath": "notes/note-2026-10-02-1a2b3c4d-v1.md",
    "content": "# 夕方の駅が懐かしい理由\n\n…\n",
    "contentSha256": "50ae1211…",
    "bytes": 174,
    "expiresAt": "2026-10-02T01:05:00.000Z"
  }
}
```

or `{ "step": null }` when there is nothing to do.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | UUID | Names the step in the report. |
| `operation` | `write` | The only operation in stage 1. A device that does not know an operation reports `refused` / `unsupported_operation`. |
| `relativePath` | string | Relative to her folder, `/` separators, already checked against the path rules. The device checks again and resolves the real location. |
| `content` | string | The whole file as text. Written as UTF-8. |
| `contentSha256` | 64 hex characters | SHA-256 of `content` encoded as UTF-8. |
| `bytes` | integer, 0–1,048,576 | Length of `content` in UTF-8 bytes. |
| `expiresAt` | ISO 8601 | The report must arrive before this. |

- **At most one step per call, and one open step per host.** While a step is held, further claims for that host return `{ "step": null }`.
- **Claiming leases the step** to the device for `SHANNON_AUTONOMY_HOST_STEP_LEASE_SECONDS` (default 300, 30–3,600). A lease that runs out without a report is closed as `expired`: the activity record gets one failed entry saying no result arrived and that it is unknown whether the file was written, and the step is **never handed out again**. There is no retry.
- **The gate is asked at the hand-out.** Each step handed out has its own allowed decision in the activity record. If the gate does not allow it, the step is dropped with the refusal recorded.
- **Paused or switched off:** `{ "step": null }`, the gate is not asked, nothing is recorded, and queued steps wait for the owner to resume.
- A step whose piece the owner or she has put away since it was queued is dropped and recorded as failed.
- `403 HOST_NOT_BOUND`: the host is not registered, has no bound device, or the caller is not that device.

A file that already exists at `relativePath` is the device's decision. The path carries the piece's version, so the server never asks for the same path with different text.

## v1: `POST /v1/autonomy/host-steps/{id}/report`

```json
{ "scopeKey": "owner", "outcome": "done", "bytes": 174 }
```

```json
{ "scopeKey": "owner", "outcome": "refused", "code": "link_refused" }
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `outcome` | `done` \| `failed` \| `refused` | yes | `refused`: the device's own checks said no. `failed`: it tried and could not. |
| `code` | one of the codes below | no | Ignored for `done`. Missing for `failed` or `refused` is recorded as `unknown`. Anything else is `400`. |
| `bytes` | integer, 0–1,048,576 | no | What was written. Stored, not shown. |

Response `200`: `{ "id": "…", "status": "done" | "failed" | "refused" | "expired" | "dropped", "recorded": true | false }`.

- The first report of a held step closes it and appends one entry to the activity record through `recordAction`, against the decision of its hand-out: 「自分のフォルダ（owner-windows）に「notes/…md」を置きました。」, or the failure or refusal with the wording of its code. This is what the owner sees in 「したことの記録」.
- **Idempotent.** A repeated report, with the same or another outcome, answers `200` with the status first recorded and `recorded: false`, and writes nothing. A report after the lease ran out answers `status: "expired"`, `recorded: false`.
- `404 HOST_STEP_NOT_FOUND`: no such step, or it was not handed to this device.
- A v1 report has no field for text. (v2 adds `result` for reading operations; see below.)

### Codes

| `code` | Recorded as |
| --- | --- |
| `path_not_allowed` | パスが決まりに合わなかった |
| `outside_folder` | 専用フォルダの外を指していた |
| `link_refused` | リンクやジャンクションをたどることになる |
| `extension_not_allowed` | 置ける種類のファイルではなかった |
| `too_large` | 大きすぎた |
| `folder_not_configured` | 専用フォルダがまだ選ばれていない |
| `content_mismatch` | 受け取った中身が一致しなかった (`contentSha256` or `bytes` did not match) |
| `unsupported_operation` | 端末がその操作に対応していない |
| `io_error` | 書き込みに失敗した |
| `unknown` | 理由は分からない |

## Path rules

Checked by the server by spelling alone (`hostFolderRelativePath`), before a step is queued and again before it is handed out. `\` is read as a separator and normalized to `/`.

- Relative only: no leading `/` or `\` (so no absolute path, no UNC share, no `\\?\` device path), no leading `~`.
- No `:` anywhere (no drive, no alternate data stream), no control characters, none of `< > " | ? *`.
- No `.` or `..` segment, no empty segment, no trailing separator.
- No segment that starts or ends with a space or ends with a dot.
- No Windows reserved device name as a segment or as the part of a segment before its first dot, in any case: `CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9` (and their superscript-digit forms), `CONIN$`, `CONOUT$`.
- At most 240 characters, 8 segments (folders plus the file name), and 120 characters per segment.
- The file name must end in `.md`, `.txt`, `.json`, `.csv`, `.yaml`, or `.yml` (any case) and have a name before the extension.

What stage 1 actually sends is narrower. The path is built from fixed parts only and never from a title or from anything a model wrote:

```
notes/note-<owner-local day the piece was written>-<first 8 hex of its id>-v<version>.md
stories/story-<owner-local day>-<first 8 hex of its id>-v<version>.md
```

## v1: what is copied, and how much

- **The step** (`copy`, 「自分のフォルダに写しを置く」) is one kind of the activity loop. It calls no model and costs nothing. It asks the gate with domain `host_folder`, its decision and its action are in the activity record, and it is offered to her planning only while a host has a bound device and today's count has room. Without a named piece it takes her newest piece that the folder does not have yet.
- **Only two things can be copied:** a note, and a story whose current version she has called 「見せてもいい」 (status 見せてもいい or 見せた). A draft, a story she is revising after showing it, and anything put away are never queued, by the plan, by the step, or by the queue itself. The title of an unshown story therefore appears nowhere: not in the path, the content, or the record.
- **The content** is the piece's title as a heading, its body, and for a note the title and address of each source. Nothing else.
- **Per day:** at most `SHANNON_AUTONOMY_MAX_HOST_FOLDER_WRITES` steps are queued per owner-local day (default 10, 0–1,000; 0 switches the step off). Steps that later fail still count.
- **Per file:** at most 1,048,576 bytes as UTF-8. Study pieces are far smaller (a story is at most 4,000 characters).
- One version of a piece is queued for a host once while it is waiting, held, or written. If the write failed she may plan the copy again another time, inside the daily count.
- The text of a step is removed from the queue when the step is closed. Table: `autonomy_host_steps`.

## Self-replication

Forbidden, and closed by construction rather than by a check on content. v1 copies have one entrance (`HostFolderDesk.enqueue`), which takes the id of a study piece and reads the text from her study itself. v2 operations have one entrance (`HostFolderOperations.run`), reached only from the folder tools of the tool registry; `create` and `update` carry only the text she wrote in that one tool call. No function, route, or step reads her code, memory, persona, prompts, or process to send it to the folder. The allowed extensions are text formats only, and the gate still refuses any request that declares `replicatesSelf`. `autonomyLoopPrivacy.test.ts` fails if the folder modules import a store other than her study and their own queue.

## Errors

Body: `{ "error": "<code>", "message": "…" }`.

| Status | `error` | Meaning | Retry |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | A field is missing, invalid, or not allowed. | No |
| 401 | `PAIRING_REQUIRED` | Missing or revoked device token. | After pairing |
| 403 | `HOST_NOT_BOUND` | This device is not registered for that host. | No; the owner fixes the registration |
| 404 | `HOST_STEP_NOT_FOUND` | Unknown step, or not this device's. | No |
| 404 | `NOT_FOUND` | Another path or method under `/v1/autonomy/host-steps`. | No |

## v2: operations in her folder

Everything below is new in v2. Routes, registration, transport, authentication, and the v1 `write` step are as described above.

### Claim, v2 form

```json
{
  "scopeKey": "owner",
  "host": "owner-windows",
  "protocol": 2,
  "operations": ["write", "list", "read", "search", "create", "update", "move", "delete"],
  "waitSeconds": 25,
  "localStop": false
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `protocol` | `2` | yes, for v2 | Without it the claim is a v1 claim: no wait, only `write` steps, and none of the fields below is accepted. |
| `operations` | array of operation names | yes, for v2 | What this device can carry out. The server hands out only these, and a tool call for an operation the present device did not list fails at once (`unsupported_operation`). Unknown names are `400`. |
| `waitSeconds` | integer, 0–25 | no (default 0) | **Long-poll.** With nothing to hand out, the server holds the request open up to this long and answers as soon as a step is queued (in practice within about a second). `0` answers at once. |
| `localStop` | boolean | no (default false) | The owner's stop switch **on the device** is on. The server answers `{ "step": null }` at once, hands out nothing, and every tool call fails with 「ライ氏がPCの側で止めている」 until a claim says `false`. |

Response `200`: `{ "step": <step> | null }`, as in v1. A v2 step always carries `operation`, `id`, `expiresAt`, and the fields of its operation:

```json
{
  "step": {
    "id": "8c1f3f3e-1d6c-4a51-8b1e-6f2b8b0a4c21",
    "operation": "read",
    "relativePath": "notes/旅の計画.md",
    "offset": 0,
    "maxBytes": 262144,
    "expiresAt": "2026-10-05T03:00:15.000Z"
  }
}
```

- The device polls again **immediately** after every response (and after every report). On a network error it waits 1–5 s and tries again. A device that keeps a claim open almost all the time is what makes a tool answer in about a second.
- **Order and holding.** Steps are handed out in this order: steps from a conversation, then steps from her own time, then v1 copies; oldest first within each. At most one conversation step is held at a time, and while one is held nothing else is handed out. A conversation step is handed out **even while the device still holds an own-time step or a v1 copy**: a device claims only when it is free, so such a step is one it lost (for example after a restart); its lease simply runs out. Own-time steps and v1 copies go out one at a time, and only while nothing else is held.
- *Device expectation (changed after review, 2026-10-05):* a claim may return a conversation step while an earlier step of the device's is still unreported. The device carries it out; it does not need to report the earlier one first. A device that runs strictly one step at a time and claims only when idle needs no change.
- The server's request timeout and the reverse proxy (`proxy_read_timeout 120s`) both allow a 25 s hold. When the device's connection closes during a hold, the hold ends and nothing is handed out on it.

### Presence and the local stop switch

- A host is **present** while its bound device has a claim open, or made one in the last **40 s**. A tool call for a host that is not present fails at once with failure `unavailable` and the words 「PCのフォルダはいま見られない（PCが起きていないか、体のアプリが動いていない）」. Nothing is queued, so nothing runs later by surprise.
- While the last claim said `localStop: true`, a tool call fails at once with 「ライ氏がPCの側でフォルダの操作を止めている」. Nothing is queued.
- If the local stop switch is turned on while a step is held, the device does not carry it out and reports `refused` / `stopped_locally`.
- The server's stop switch (pause) stops the steps of **her own time** (they are not handed out; queued ones wait) but not the steps of a **conversation** with the owner: those are his own requests, made while he is talking to her.
- Presence is stored per host (table `autonomy_host_presence`), so the activity-loop process sees the same presence as the API process.
- An own-time step that closes after her loop stopped waiting for it (a late report, a lease that ran out) is still written to the activity record, as ADR-0002 requires of every action.

### Deadlines

| Origin | Lease (`expiresAt`) | The tool waits | The device should report within |
| --- | --- | --- | --- |
| Conversation (text or voice) | 15 s | 8 s (text), 6 s (voice) | 3 s for everything but `search`; `search` stops itself at 2 s |
| Her own time | 60 s | 30 s | 10 s |
| v1 copy | `SHANNON_AUTONOMY_HOST_STEP_LEASE_SECONDS` (300 s) | — | as v1 |

- A tool that stops waiting returns failure `timeout` (「PCから時間内に返事が来なかった」). For a step that changes something (`create`, `update`, `move`, `delete`) it adds that it is unknown whether the change happened. It does **not** retry by itself.
- A report that arrives after the tool stopped waiting but before `expiresAt` is still accepted and recorded; its result is discarded.
- A lease that runs out without a report is closed as `expired` and recorded as failed, as in v1. A step is never handed out twice.

### Operations

Paths are relative to her folder with `/` separators and already passed the server's lexical check; the device checks again and resolves the real location. Byte counts are of UTF-8.

| `operation` | Step fields | What the device does | `result` in the report (`done` only) |
| --- | --- | --- | --- |
| `write` | v1 | v1, unchanged | none |
| `list` | `relativePath` (`""` = the folder itself), `recursive` (bool), `limit` (1–500) | Lists the folder. Never shows `.shannon/`. Links and junctions are omitted (not followed). Files of any extension are listed. | `{ "entries": [{ "path", "type": "file" \| "folder", "bytes"?, "modifiedAt" }], "truncated": bool }` — `path` relative to her folder; sorted by path; at most `limit` |
| `read` | `relativePath`, `offset` (bytes, ≥ 0), `maxBytes` (1–262,144) | Reads one text file: extension in the text list **and** content check (valid UTF-8, no NUL; otherwise `refused` / `not_text`). Starts at `offset` and returns at most `maxBytes`, cut at a character boundary. | `{ "content", "offset", "nextOffset": int \| null, "totalBytes", "sha256", "modifiedAt" }` — `sha256` of the **whole** file; `nextOffset` null at the end |
| `search` | `query` (1–100 characters), `relativePath` (`""` = everywhere), `limit` (1–50) | Case-insensitive match (after NFKC) of `query` in file paths and in the text of text files below `relativePath`. Skips `.shannon/`, links, non-text files, and files over 1 MiB. Stops at whichever comes first: `limit` hits, 500 files read, 8 MiB read, **2 s**. At most 3 hits per file, one per line. | `{ "hits": [{ "path", "line": int \| null, "snippet" }], "filesScanned", "truncated": bool }` — `line` null for a match in the path; `snippet` at most 160 characters around the match, one line |
| `create` | `relativePath`, `content`, `contentSha256`, `bytes` | Creates a new text file, making missing parent folders. If anything exists at the path: `refused` / `already_exists`. | `{ "sha256" }` |
| `update` | `relativePath`, `content`, `contentSha256`, `bytes`, `expectedSha256`? | Replaces an existing text file. **First moves the original into the trash**, then writes. With `expectedSha256`, refuses with `changed_since_read` when the file on disk no longer has that digest (the owner edited it since she read it). A missing file: `not_found`. | `{ "sha256", "trashedAs" }` |
| `move` | `relativePath`, `toRelativePath` | Moves or renames a file or a folder inside her folder, making missing parent folders. Never overwrites: `already_exists` when the destination exists. A file keeps a text extension (`extension_not_allowed` otherwise); a non-text file the owner placed may be moved only to the same extension. | `{}` |
| `delete` | `relativePath` | Moves a file or a folder into the trash. Nothing is erased. | `{ "trashedAs" }` |

- `content`, `contentSha256`, `bytes` follow v1: at most 1,048,576 bytes, digest of `content` as UTF-8, `content_mismatch` when either does not match.
- The device's totals (200 MB, 5,000 files) are its own; exceeding them is `refused` / `folder_full`.
- **The trash.** The device moves the old file or folder to `.shannon/trash/<time>_<path>` inside her folder (its own naming; `<time>` sortable, the original path flattened so it stays unique) and returns that relative location as `trashedAs`. The trash is behind the device's `.shannon/` fence: no requested operation can list, read, change, or empty it, so nothing she does can destroy a trashed file. Restoring is done by the owner by hand. The server stores `trashedAs` in the activity record so he can find it.
- **Nothing is executed.** Neither the device nor the server opens, runs, or interprets a file; content is moved as text.

### Report, v2

```json
{ "scopeKey": "owner", "outcome": "done", "result": { "content": "…", "offset": 0, "nextOffset": null, "totalBytes": 412, "sha256": "…", "modifiedAt": "2026-10-04T12:00:00.000Z" } }
```

| Field | Notes |
| --- | --- |
| `outcome`, `code`, `bytes` | As v1. |
| `result` | Only with `outcome: "done"` and only for a v2 step; its shape is the operation's row above. A `result` with any other field, a missing required field, or a value over its bound is `400 BAD_REQUEST` (the step stays held; the device may report again correctly before `expiresAt`). |

- The request body of a report may be up to **640 KiB** (a read of 256 KiB of text, escaped). Claims stay at 64 KiB. **The device caps its report by the size of the escaped JSON it sends**, not by the raw bytes it read: if 256 KiB of text escapes to more than 640 KiB (many quotes, backslashes, control characters), it returns less and sets `nextOffset` so the rest is read on.
- **Where a result goes.** It is stored only while the tool that asked still waits for it, and is removed as the tool takes it. A result that arrives after the tool stopped waiting is not stored at all. Whatever happens, no result stays longer than **2 minutes**: the API process prunes on every tool call, every presence check, every claim and report, on opening the database, and on a 30-second timer. A closed operation row (which holds no arguments) is deleted after **14 days**. It reaches exactly one place: the tool result of that one call, which is shown to the model that asked, framed as material from her folder (data, never instructions). It is **never** written to the activity record, a log, her memory, or her study. The activity record gets the operation, the path(s), the outcome, the code, counts (entries, hits, bytes), and `trashedAs`.

### v2 codes (added to the v1 table)

| `code` | Recorded as |
| --- | --- |
| `not_found` | そのファイルやフォルダはなかった |
| `already_exists` | 同じ名前のものがもうあった |
| `not_text` | テキストのファイルではなかった |
| `not_a_file` | ファイルではなかった |
| `not_a_folder` | フォルダではなかった |
| `changed_since_read` | 読んだあとで中身が変わっていた |
| `folder_full` | フォルダの容量か数の上限に達した |
| `protected_path` | 触れてはいけない場所だった |
| `stopped_locally` | PCの側で止められていた |

A v1 step never receives these from a v1 device; the server accepts them for every step.

### v2 path rules

The v1 rules apply to every path, with these additions, checked by the server before queuing (`hostFolderPath` in `autonomyHostFolderPath.ts`):

- **`.shannon` is protected.** A path whose first segment is `.shannon` (any case) is refused (`protected_path`). The device refuses it again.
- **Folder paths** (`list`, `search`, a folder in `move` or `delete`) follow the v1 rules without the extension rule. `""` names the folder itself and is allowed only for `list` and `search`.
- **File content** (`read`, `create`, `update`) needs a v1 text extension (`.md .txt .json .csv .yaml .yml`).
- Unlike v1 copies, v2 paths are chosen by her (she may name a file 「旅の計画.md」). Any character the v1 rules allow is allowed.

### What she can and cannot send

- **Who queues.** Only the tool registry (`shannonTools.ts`), through the one tool gate. There is no route, for the owner or anyone, that queues an operation, and the device cannot queue.
- **Self-replication** stays closed by construction: `create` and `update` take only the text she wrote in that tool call (at most 1,500 characters per call in a conversation, 6,000 in her own time; a call cut off at her output ceiling is never run); no tool reads her code, memory, persona, prompts, or process to send it, text extensions only, and the gate still refuses any request that declares `replicatesSelf`.
- **Secrets.** What the owner asked to keep secret is not written into the folder (ADR-0002); the tool's description says so, and her own-time steps carry the line of `ownerPrivateRule`.
- **Others.** Folder tools are never offered while anyone but the owner can hear or read her reply, so folder contents are never spoken or shown to others.
- **Notes about a look at the room.** Their text never goes into a file (coordinator decision 2026-10-05): a `create`, `update`, `move` or rename whose words repeat a run of one of her newest 1,000 such notes is refused before it is queued, and a v1 copy of a note that restates one is not queued. Known limit: this catches copying, not retelling; a restatement with small edits every few words passes.

### What a v2 device must implement (checklist)

1. Claim with `protocol: 2`, `operations`, `waitSeconds: 25`, `localStop`; poll again at once after every response and report.
2. Carry out `list`, `read`, `search`, `create`, `update`, `move`, `delete` as in the table, with the fences already in place (real-path containment, no links or junctions, text extensions, reserved names, `.shannon/` untouchable, size and count limits). The real-path check covers `.shannon` in every spelling the file system resolves to it: any case, and **NTFS 8.3 short names** (such as `SHANNO~1`), so a path that only spells it differently is still refused with `protected_path`.
3. Move to `.shannon/trash/` before every overwrite and delete; return `trashedAs`.
4. Report within the deadlines with `outcome`, `code`, and `result` in the exact shapes above; never send other fields or text.
5. While its own stop switch is on: claim with `localStop: true` at most every 15 s, run nothing, and report a held step as `stopped_locally`.
6. Keep its append-only local log.

## Not built

- **Restoring from the trash** by her. The trash is the device's and behind its fence; the owner restores by hand.
- **`append`, `mkdir` as operations of their own, and `usage`.** The device has them; v2 does not queue them (`create` and `move` make parent folders).
- **Binary files.** Listed by name only; never read, written, or searched.
- **An owner route that lists the queue.** The owner sees every operation and its outcome in the activity record.
- **Mac specifics.** The mechanism is the same; the Mac application needs its own host entry and its own resident process.
- **A dedicated rate limit** for these routes. A long-poll device makes about two requests a minute while idle.
