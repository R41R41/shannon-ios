# Operations contract (v1, stage 1: read-only)

How the operational status of the legacy platform runtime (Discord, Minecraft, scheduled posts; another repository, the same VM) reaches the owner's desktop management window. The runtime **pushes a snapshot** to this API with the platform bridge credential; the desktop **reads the latest snapshot** from this API with its device token. The desktop never connects to the legacy runtime, and this API never calls it.

This document and the contract test `services/api/tests/ops.test.ts` are what the reporter and the desktop client are built against. The vocabulary and bounds are in `services/api/src/opsContract.ts`; the routes are in `serverOpsRoutes.ts`; the table is in `opsStore.ts`.

Everything here is additive. No existing route, table, or prompt wording changed.

Stage 1 is read-only: the owner can see the status and cannot change anything through it. Commands are [Stage 2 (not built)](#stage-2-not-built).

## Privacy rule

A snapshot is operational data. It must not carry conversation text.

- The reporter must never put a message, a quotation, a post body, a prompt, a person's name or account name taken from a conversation, or a credential into any field. `detail`, a task `title` and a step `title` are short operator-facing labels such as `reconnecting (3rd attempt)` or `Collect oak logs`, written by the runtime's own code, not copied from what someone said.
- The server enforces what it can: a closed set of fields (an unknown field refuses the request), closed status vocabularies, tight length bounds, no control characters, and a refusal of credential-shaped strings. It cannot tell a short label from a short quotation; that part is the reporter's duty.
- The snapshot is in no prompt. It is stored in one table that only the two routes below read; the store is not given to the API kernel, a worker, the platform bridge, or the activity loop (asserted structurally in `ops.test.ts`). Shannon does not know it.

## `POST /v1/platform/ops/snapshot`

- `Authorization: Bearer <SHANNON_PLATFORM_BRIDGE_TOKEN>` — the existing service credential of `/v1/platform/*`. A device token is refused.
- JSON, at most 64 KiB. Report once a minute (`reportAfterSeconds` in the answer), and once more right after a change if wanted; at most 30 a minute are accepted.
- The whole snapshot is sent every time. The server keeps only the latest one per scope (one row, replaced); there is no history.

```json
{
  "scopeKey": "owner",
  "reportedAt": "2026-10-02T02:59:58.000Z",
  "runtime": { "release": "v2026.10.02-1", "startedAt": "2026-10-01T20:00:00.000Z" },
  "services": [
    { "id": "discord", "label": "Discord", "category": "platform", "status": "running" },
    { "id": "minecraft-main", "label": "Minecraft", "category": "game", "status": "degraded", "detail": "reconnecting (3rd attempt)" }
  ],
  "minebot": [
    { "id": "bot-1", "server": "main", "status": "running",
      "task": { "title": "Build a storage room", "steps": [
        { "title": "Collect oak logs", "status": "done" },
        { "title": "Place the chests", "status": "running" } ] } },
    { "id": "bot-2", "server": "creative", "status": "stopped" }
  ],
  "schedules": [
    { "name": "morning-post", "time": "08:00", "postedToday": true },
    { "name": "evening-post", "time": "0 21 * * *" }
  ],
  "kpi": { "postsToday": 3, "postsPlanned": 5, "tokensToday": 182340, "apiCallsToday": 97 },
  "skills": [ { "name": "get-weather", "description": "Reads the forecast for a city" } ]
}
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `scopeKey` | string, 1–160 | yes | Any non-empty value. The snapshot is stored under the owner scope the bridge credential is bound to (`SHANNON_PLATFORM_BRIDGE_SCOPE_KEY`), never under the one named here. |
| `schemaVersion` | `1` | no | Refused if present with another value. |
| `reportedAt` | ISO 8601 | yes | The reporter's clock. Shown to the owner; not used for staleness. |
| `runtime.release` | string, 1–80 | yes | A tag or a short commit id. A full 40-character commit id is refused as credential-shaped. |
| `runtime.startedAt` | ISO 8601 | yes | |
| `services` | array, 0–40 | yes | `id` unique within the array. |
| `services[].id` | string, 1–80, `[A-Za-z0-9][A-Za-z0-9_.:-]*` | yes | Stable identifier; a stage 2 command would name it as its target. |
| `services[].label` | string, 1–80 | yes | |
| `services[].category` | string, 1–40 | yes | Free grouping label, e.g. `platform`, `game`, `infra`. |
| `services[].status` | `running` \| `stopped` \| `degraded` \| `unknown` | yes | |
| `services[].detail` | string, 1–120 | no | Short operator-facing label. Omit it rather than send an empty string. |
| `minebot` | array, 0–10 | yes | `id` unique within the array. |
| `minebot[].id` | as `services[].id` | yes | |
| `minebot[].server` | string, 1–80 | yes | |
| `minebot[].status` | `running` \| `stopped` \| `degraded` \| `unknown` | yes | |
| `minebot[].task` | object | no | Omit when the bot has no task. |
| `minebot[].task.title` | string, 1–120 | yes | Short operator-facing label. |
| `minebot[].task.steps` | array, 0–20 | yes | |
| `minebot[].task.steps[].title` | string, 1–120 | yes | Short operator-facing label. |
| `minebot[].task.steps[].status` | `pending` \| `running` \| `done` \| `failed` \| `skipped` | yes | |
| `schedules` | array, 0–60 | yes | |
| `schedules[].name` | string, 1–80 | yes | |
| `schedules[].time` | string, 1–40 | yes | A display label such as `08:00` or a cron expression; the server does not parse it. |
| `schedules[].postedToday` | boolean | no | |
| `kpi.postsToday`, `kpi.postsPlanned`, `kpi.tokensToday`, `kpi.apiCallsToday` | integer, 0–1,000,000,000,000 | yes, all four | |
| `skills` | array, 0–100 | yes | |
| `skills[].name` | string, 1–80 | yes | |
| `skills[].description` | string, 1–160 | yes | The skill's own fixed description. |

Rules that hold for every field:

- **No other field is accepted, at any level.** `messages`, `log`, `text`, `prompt` and the like refuse the request.
- Strings are trimmed. A string that is empty after trimming, or longer than its bound, refuses the request.
- A control character refuses the request: C0 and C1 controls (including newline and tab), DEL, U+2028/2029, zero-width characters and bidirectional overrides.
- A credential-shaped string refuses the request. The server reuses the guard of Shannon's knowledge drafts (`looksSecret` in `packages/cognition/src/shannonKnowledge.ts`: `sk-…`, `AKIA…`, `ghp_…`, `xox?-…`, a JWT, a private key header, and `password:` / `api key =` / `パスワード：` / `トークン：` followed by a value) and adds two rules: three long dot-separated parts (a bot token), and an unbroken run of 32 or more characters of `[A-Za-z0-9_+/=]` that contains both a letter and a digit. A UUID with hyphens passes.
- A malformed request is refused as a whole and the stored snapshot is unchanged.

Answer, `200`:

```json
{ "schemaVersion": 1, "receivedAt": "2026-10-02T03:00:00.000Z", "reportAfterSeconds": 60, "staleAfterSeconds": 180 }
```

| Status | `error` | Meaning | Retry |
| --- | --- | --- | --- |
| `400` | `OPS_SNAPSHOT_INVALID` | The body is not JSON or breaks a rule above. `message` names the field (`services[1].detail looks like a credential`) and never echoes a value other than an unknown field's name (cut to 40 characters) or a duplicated `id`. | No; fix the reporter |
| `401` | `PLATFORM_BRIDGE_UNAUTHORIZED` | Missing or wrong bridge credential. | No |
| `403` | `OPS_INGEST_DISABLED` | `SHANNON_PLATFORM_OPS_INGEST=off`. | Keep reporting at the normal interval; drop the snapshot |
| `405` | `METHOD_NOT_ALLOWED` | Not `POST`. | No |
| `413` | `REQUEST_TOO_LARGE` | Over 64 KiB. | No |
| `429` | `RATE_LIMITED` | More than 30 snapshots in a minute. | At the next interval |
| `503` | `PLATFORM_BRIDGE_NOT_CONFIGURED` | The server has no bridge credential. | At the next interval |

A failed report must never delay or fail the runtime's own work: send it in the background, with a short timeout, and drop it on any error.

## `GET /v1/ops?scopeKey=`

- `Authorization: Bearer <device token>` — a paired device (`POST /v1/pair`). The bridge credential is refused.
- `scopeKey` is replaced with the device's own scope, as on every device route. (A server run locally with a fixed token requires it.)
- Reading writes nothing. At most 120 reads a minute per scope; polling every 30 seconds is enough.

```json
{
  "schemaVersion": 1,
  "snapshot": { "reportedAt": "…", "runtime": { }, "services": [ ], "minebot": [ ], "schedules": [ ], "kpi": { }, "skills": [ ] },
  "receivedAt": "2026-10-02T03:00:00.000Z",
  "stale": false,
  "staleAfterSeconds": 180,
  "commands": [],
  "commandsSupported": false
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `snapshot` | object \| `null` | The latest accepted snapshot, with the fields and bounds of the request (normalized: strings trimmed, timestamps in UTC `…Z`), without `scopeKey` and `schemaVersion`. Optional fields are absent, not `null`. |
| `receivedAt` | ISO 8601 \| `null` | When the server accepted it (server clock). |
| `stale` | boolean | `true` when no snapshot arrived within `staleAfterSeconds`, by the server's clock. Always `true` when `snapshot` is `null`. |
| `staleAfterSeconds` | integer | 180 now: three missed reports. |
| `commands` | array | Always `[]` in stage 1. |
| `commandsSupported` | boolean | Always `false` in stage 1. A client shows command controls only when this is `true`. |

What the desktop shows:

| Answer | Meaning | Show |
| --- | --- | --- |
| `snapshot: null`, `receivedAt: null` | Nothing was ever received, the bridge is not configured, or ingest is switched off. | Hide the screen. |
| `snapshot` present, `stale: false` | Current. | The status. |
| `snapshot` present, `stale: true` | The runtime stopped reporting. The VM is a Spot instance and may have been stopped; the runtime may also be down while the VM is up. | The last status, marked as old with `receivedAt`, and "no report received". Do not show `running` as current. |

**A missing snapshot is `200` with `snapshot: null`, not `404`.** With ingest off, a snapshot stored earlier is hidden (not deleted) and shown again when ingest is switched back on.

| Status | `error` | Meaning |
| --- | --- | --- |
| `400` | `INVALID_REQUEST` | `scopeKey` missing (fixed local token only). |
| `401` | `PAIRING_REQUIRED` | Missing or wrong device token, or the bridge credential. |
| `405` | `METHOD_NOT_ALLOWED` | Not `GET`. |
| `429` | `RATE_LIMITED` | More than 120 reads in a minute. |

If the API itself is unreachable (the same VM), the request fails at the network level; the client treats that as the API being down, which is a different message from `stale`.

## Server switch

`SHANNON_PLATFORM_OPS_INGEST` (default on). `off`, `false`, `0` or `disabled` refuses snapshots with `403 OPS_INGEST_DISABLED` and makes `GET /v1/ops` answer `snapshot: null`. A restart applies it.

## Storage

`ops_snapshots` (`scope_key` primary key, `schema_version`, `reported_at`, `received_at`, `snapshot_json`): one row per scope, replaced on every accepted report. Created with `CREATE TABLE IF NOT EXISTS` outside the numbered migrations; the schema version is unchanged and an older API binary can still open the database.

## Stage 2 (not built)

**Nothing in this section exists.** `POST /v1/ops/commands` and every `/v1/platform/ops/commands/*` path are not routed: they answer `404` to a paired device and `401` to anything else. It is a proposal, shaped so that stage 1 clients and reporters keep working unchanged when it is added: the snapshot request and the `GET /v1/ops` answer keep their fields; `commands` starts to carry entries and `commandsSupported` becomes `true`.

The direction stays the same: the desktop writes a command to this API, the legacy runtime **polls and claims** it with the bridge credential, and reports the result. This API still never calls the runtime, and the desktop still never does.

Device side:

- `POST /v1/ops/commands` — device token. `{ "scopeKey", "idempotencyKey", "type", "target" }`.
  - `type`: `schedule.run` \| `service.start` \| `service.stop` \| `minecraft.start` \| `minecraft.stop`.
  - `target`: an identifier from the latest snapshot — a `schedules[].name` for `schedule.run`, a `services[].id` for `service.*`, a `minebot[].id` or server for `minecraft.*`. No free text, no arguments, no shell.
  - `idempotencyKey`: the same key with the same content returns the same command; with other content, `409`.
  - Answer: `{ "id", "status": "queued" }`.
- `GET /v1/ops` then lists recent commands in `commands`: `{ id, type, target, status: queued | claimed | succeeded | failed | expired | refused, requestedAt, finishedAt?, reason? }`, where `reason` is a closed code, not text.

Bridge side:

- `POST /v1/platform/ops/commands/claim` — bridge credential. Returns at most one queued command and marks it `claimed` with a lease; an unclaimed command expires after a short time (a command queued while the VM is stopped must not run when it comes back hours later).
- `POST /v1/platform/ops/commands/{id}/report` — bridge credential. `{ "status": "succeeded" | "failed" | "refused", "reason"? }`. Reporting twice with the same content is a duplicate.

Rules the proposal assumes: every command is appended to a record the runtime cannot rewrite; the runtime re-checks an allowlist of targets on its side and refuses anything else; a kill switch separate from `SHANNON_PLATFORM_OPS_INGEST` turns commands off while status keeps flowing; Shannon's activity loop has no access to these routes (starting processes is outside her bounded autonomy).

Open questions for the owner, none decided:

1. **Minecraft start competes with lab runs.** The VM has 2 cores and 15 GB. Starting a Minecraft server while a lab run is in progress can starve both. Should `minecraft.start` be refused while a lab run is active (the runtime answers `refused` with a reason code), queued until it ends, or allowed with a warning in the desktop?
2. **`progressive-lab-*` is excluded from management.** The proposal is that services with this prefix are never a valid `target` and the runtime refuses them even if asked. Should they still appear in the snapshot as read-only status, or be left out entirely?
3. **Who confirms.** Is a click in the desktop window enough, or does a command that stops something need a second confirmation there (and for which types)? Is the paired desktop the only device allowed to send commands, or any paired device including the iPhone?
4. Which services may be stopped at all — stopping the Discord adapter stops Shannon's presence there; stopping the bridge reporter itself would make the console go stale.
5. Whether `schedule.run` may run a schedule that already posted today (a second public post is something that reaches other people).
