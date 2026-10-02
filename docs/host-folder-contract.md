# Host folder contract (v1, stage 1: write-out only)

What the device that works in Shannon's own folder must send and may read. Her folder is one folder the owner chose on the owner's Windows PC or Mac (Syzygy ADR-0002: a free domain, `host_folder`). The process that touches the folder lives in another repository and has no network and no token; the desktop application's main process, paired like any other device, pulls work from this server and hands it over. This document and the contract test `services/api/tests/autonomyHostFolder.test.ts` are what that side is built against. The bounds and codes are in `services/api/src/autonomyHostFolderPath.ts`.

Everything here is additive. No existing route or table changed, and the persona and base prompt are unchanged. (One capability line about the folder was added on 2026-10-02 with the owner's approval; see the last section.)

The contract in one paragraph: in her own time Shannon may **queue a copy** of a note, or of a story she has called 「見せてもいい」, for her folder. The one device bound to that host **claims** at most one step (`POST /v1/autonomy/host-steps/claim`), writes the file inside the folder, and **reports** an outcome and a code (`POST /v1/autonomy/host-steps/{id}/report`). The server never calls the device, never sees the folder, and reads nothing back from it.

## Who decides what

| Check | Where | Notes |
| --- | --- | --- |
| The host is registered and has a bound device | Server, in the gate | Otherwise `unknown_host`, as before. |
| The path is relative and spelled safely, and names a text file | Server, in the gate (lexical only) | See [Path rules](#path-rules). The server cannot resolve a path on the owner's machine. |
| The stop switch, the server switch | Server, in the gate, when she queues **and** when the step is handed out | A paused Shannon hands out nothing. |
| The real location is inside the folder; no symlink, junction, or reparse point is followed | **Device** | Reported as `refused` with a code. The server takes the device's word. |
| Size on disk, existing file, disk errors | **Device** | Reported as `failed` or `refused` with a code. |

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
- Both routes are `POST`. No other field than the ones listed is accepted.
- There is no push and no stream: the device polls. Once a minute is enough; a claim that returns nothing costs one small query and leaves no trace in the activity record.

## `POST /v1/autonomy/host-steps/claim`

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

## `POST /v1/autonomy/host-steps/{id}/report`

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
- There is no field for text. Nothing a device sends reaches a prompt, her study, or her memory.

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

## What is queued, and how much

- **The step** (`copy`, 「自分のフォルダに写しを置く」) is one kind of the activity loop. It calls no model and costs nothing. It asks the gate with domain `host_folder`, its decision and its action are in the activity record, and it is offered to her planning only while a host has a bound device and today's count has room. Without a named piece it takes her newest piece that the folder does not have yet.
- **Only two things can be copied:** a note, and a story whose current version she has called 「見せてもいい」 (status 見せてもいい or 見せた). A draft, a story she is revising after showing it, and anything put away are never queued, by the plan, by the step, or by the queue itself. The title of an unshown story therefore appears nowhere: not in the path, the content, or the record.
- **The content** is the piece's title as a heading, its body, and for a note the title and address of each source. Nothing else.
- **Per day:** at most `SHANNON_AUTONOMY_MAX_HOST_FOLDER_WRITES` steps are queued per owner-local day (default 10, 0–1,000; 0 switches the step off). Steps that later fail still count.
- **Per file:** at most 1,048,576 bytes as UTF-8. Study pieces are far smaller (a story is at most 4,000 characters).
- One version of a piece is queued for a host once while it is waiting, held, or written. If the write failed she may plan the copy again another time, inside the daily count.
- The text of a step is removed from the queue when the step is closed. Table: `autonomy_host_steps`.

## Self-replication

Forbidden, and closed by construction rather than by a check on content: the queue has one entrance (`HostFolderDesk.enqueue`), which takes the id of a study piece and reads the text from her study itself. There is no function, route, or step that queues arbitrary text or a file from the server, so her code, memory, persona, prompts, and process cannot be sent to the folder. The allowed extensions are text formats only, and the gate still refuses any request that declares `replicatesSelf`. `autonomyLoopPrivacy.test.ts` fails if the folder modules import a store other than her study and their own queue.

## Errors

Body: `{ "error": "<code>", "message": "…" }`.

| Status | `error` | Meaning | Retry |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | A field is missing, invalid, or not allowed. | No |
| 401 | `PAIRING_REQUIRED` | Missing or revoked device token. | After pairing |
| 403 | `HOST_NOT_BOUND` | This device is not registered for that host. | No; the owner fixes the registration |
| 404 | `HOST_STEP_NOT_FOUND` | Unknown step, or not this device's. | No |
| 404 | `NOT_FOUND` | Another path or method under `/v1/autonomy/host-steps`. | No |

## Not built

Deliberately, for stage 1:

- **Reading back.** No route returns or accepts file content, a listing, or a file name from the folder. The resident process can list and read; the server does not ask it to.
- **Any other operation.** `append`, `mkdir`, `move`, and put-away exist on the device and are not queued. The table accepts only `write`.
- **Overwrite and delete requests.** The server never asks for either.
- **Anything but copies of study pieces.** No free-form file she composes for the folder, no working files.
- **A server-side folder path for a bound host.** The owner chooses the folder on the device; the server stores no path for it.
- **Mac specifics.** The mechanism is the same; the Mac application needs its own host entry and its own resident process.
- **A dedicated rate limit** for these routes, and an owner route that lists the queue. The owner sees every hand-out and result in the activity record.
- **Wording in her persona.** Since the owner's approval of 2026-10-02 the capability description has one line about the folder (「自分のフォルダ」: only when the owner has set it up, copies only, nothing read back), and 「今日したこと」 counts a copy once the device reports it is in place (「自分のフォルダに写しを1つ置いた」). Her persona text is unchanged.
