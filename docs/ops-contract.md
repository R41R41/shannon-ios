# Operations contract (v1: status, and commands)

How the operational status of the legacy platform runtime (Discord, Minecraft, scheduled posts; another repository, the same VM) reaches the owner's desktop management window. The runtime **pushes a snapshot** to this API with the platform bridge credential; the desktop **reads the latest snapshot** from this API with its device token. The desktop never connects to the legacy runtime, and this API never calls it.

This document and the contract tests `services/api/tests/ops.test.ts` and `opsCommands.test.ts` are what the reporter and the desktop client are built against. The vocabulary and bounds are in `services/api/src/contracts/opsContract.ts`; the routes are in `serverOpsRoutes.ts`; the table is in `opsStore.ts`.

Everything here is additive. No existing route, table, or prompt wording changed.

Stage 1 is the status: the owner can see it and cannot change anything through it. [Stage 2](#stage-2-commands) adds commands, behind a switch that is off by default. With that switch off, everything below up to the stage 2 section is the whole behaviour.

## Privacy rule

A snapshot is operational data. It must not carry conversation text.

- The reporter must never put a message, a quotation, a post body, a prompt, a person's name or account name taken from a conversation, or a credential into any field. `detail`, a task `title` and a step `title` are short operator-facing labels such as `reconnecting (3rd attempt)` or `Collect oak logs`, written by the runtime's own code, not copied from what someone said.
- The server enforces what it can: a closed set of fields (an unknown field refuses the request), closed status vocabularies, tight length bounds, no control characters, and a refusal of credential-shaped strings. It cannot tell a short label from a short quotation; that part is the reporter's duty.
- The snapshot is in no prompt. It is stored in one table that only the two routes below read; the store is not given to the API kernel, a worker, the platform bridge, or the activity loop (asserted structurally in `ops.test.ts`). Shannon does not know it.

## `POST /v1/platform/ops/snapshot`

- `Authorization: Bearer <SHANNON_PLATFORM_BRIDGE_TOKEN>` — the existing service credential of `/v1/platform/*`. A device token is refused. With `SHANNON_PLATFORM_REPLY=on` this token can also make owner-alone conversation turns (`docs/platform-people-contract.md`, Replies), so it is then as powerful as one of the owner's paired apps and must be guarded like one. The device token of her Minecraft body is refused here as any device token is.
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
| `services[].id` | string, 1–80, `[A-Za-z0-9][A-Za-z0-9_.:-]*` | yes | Stable identifier; a stage 2 command names it as its target. |
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
| `kpi.postsToday`, `kpi.postsPlanned`, `kpi.tokensToday`, `kpi.apiCallsToday` | integer, 0–1,000,000,000,000 | no; when `kpi` is sent, all four | Omit `kpi` when the runtime keeps no such counters. Never send zeros that were not counted. |
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
- Reading stores nothing new (with commands on, it marks commands whose time ran out). At most 120 reads a minute per scope; polling every 30 seconds is enough.

```json
{
  "schemaVersion": 1,
  "snapshot": { "reportedAt": "…", "runtime": { }, "services": [ ], "minebot": [ ], "schedules": [ ], "kpi": { }, "skills": [ ] },
  "receivedAt": "2026-10-02T03:00:00.000Z",
  "stale": false,
  "staleAfterSeconds": 180,
  "commands": [],
  "commandsSupported": false,
  "allowed": { "serviceStart": [], "serviceStop": [], "minecraft": false, "scheduleRun": false }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `snapshot` | object \| `null` | The latest accepted snapshot, with the fields and bounds of the request (normalized: strings trimmed, timestamps in UTC `…Z`), without `scopeKey` and `schemaVersion`. Optional fields are absent, not `null`. |
| `receivedAt` | ISO 8601 \| `null` | When the server accepted it (server clock). |
| `stale` | boolean | `true` when no snapshot arrived within `staleAfterSeconds`, by the server's clock. Always `true` when `snapshot` is `null`. |
| `staleAfterSeconds` | integer | 180 now: three missed reports. |
| `commands` | array | `[]` while commands are switched off. See [stage 2](#what-get-v1ops-adds). |
| `commandsSupported` | boolean | `false` while commands are switched off. A client shows command controls only when this is `true`. |
| `allowed` | object | What a command would be accepted for now; nothing while commands are switched off. See [stage 2](#what-get-v1ops-adds). |
| `server` | object, absent | This API's own self-diagnosis: the models it resolved, the persona hash, its tools, the deployed revision, and which integrations are configured. **Only for the owner's scope** (`SHANNON_OWNER_SCOPE_KEY`, default `owner`); absent for any other scope. See [The server's self-diagnosis](#the-servers-self-diagnosis). | With stage 3 of ADR-0008 switched on, `server.mind` adds the mind's state (numbers and booleans only): `workspace` (`faulted`, `faults` since the process started, `busyWrites`: journal writes that met a busy database, which are kept and retried, not faults) and `memoryOutbox` (`pending`, `oldestPendingSeconds`, `failed`); a part switched off is `null`, and with every part off the field is absent.

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

## Model and cache operations

[haiku-model-cache-contract.md](haiku-model-cache-contract.md) owns the current Haiku/native SDK credentials, one-hour cache and usage rules. The diagnostics report the resolved actual model, not an obsolete Luna default. Haiku and Sonnet both use provider `mode: anthropic`; inspect `servedTier` for tier outcomes. `SHANNON_SONNET_ROUTING=off` prevents Sonnet conversation requests while permitting the Haiku base model. Presence of a model/key or cache-control block is not evidence of a real cache write or read; deployment requires content-free native usage receipts.

## The server's self-diagnosis

Added 2026-10-05 (coordinator task taken over from Voyager, approved by the owner the same day). `GET /v1/ops` answers the owner's scope with one more field, `server`: what this API process resolved when it started. It describes the Shannon API itself, not the legacy runtime, and it is read-only. No app shows it yet (server only); read it with an owner device token. Everything else in the answer is unchanged, and the field is absent for a device of any other scope. `GET /health` is unchanged: a request without a device token still answers `401`, which is what the liveness check looks for.

The same summary is written once to the service log at startup, as one line that begins with `Shannon self-diagnosis `.

**Names, counts, a hash and booleans only.** No credential, endpoint, path or token; model names only after validation. An integration is `true` or `false`. A model is the name its gateway resolved, reported only when it matches the model-name rule of the chat model (`[A-Za-z0-9._:-]{1,100}`) and is not credential-shaped (the `looksSecret` guard, or an unbroken run of 32 or more letters, digits and `_` that holds both a letter and a digit); otherwise it is `null`. This matters for names the server does not itself validate, such as `SHANNON_JEV_MODEL`. The code is `services/api/src/infra/ops/serverSelfDiagnosis.ts`; the contract test, which seeds fake secrets into every credential and endpoint variable and asserts that none of them comes back, is `services/api/tests/serverSelfDiagnosis.test.ts`.

```json
{
  "server": {
    "schemaVersion": 1,
    "startedAt": "2026-10-05T12:00:00.000Z",
    "build": { "revision": "5943c29" },
    "models": {
      "text": "claude-haiku-5-5",
      "voice": {
        "reply": "claude-haiku-5-5",
        "routing": "jev-latest",
        "transcription": { "gemini": "gemini-3.5-transcribe-live", "openai": "gpt-4o-mini-transcribe" },
        "speech": { "gemini": "gemini-3.8-flash-lite-tts", "eleven": null },
        "vision": "claude-haiku-5-5"
      },
      "dictation": "gpt-transcribe",
      "autonomy": { "enabled": true, "prose": "gemini-3.8-flash", "research_reading": "gemini-3.8-flash", "planning": "gemini-3.8-flash", "critique": "gemini-3.8-flash", "roomLook": "gemini-3.8-flash" }
    },
    "persona": { "hash": "73b3ed686d94", "algorithm": "sha256" },
    "tools": {
      "enabled": true,
      "count": 17,
      "names": ["study.list", "study.search", "study.read", "study.create", "study.update", "study.rename", "study.move", "study.delete", "study.restore",
        "folder.list", "folder.search", "folder.read", "folder.create", "folder.update", "folder.rename", "folder.move", "folder.delete"],
      "offered": { "text": { "owner_alone": 17, "others": 0 }, "voice": { "owner_alone": 17, "others": 0 }, "autonomy": { "owner_alone": 17, "others": 0 } }
    },
    "integrations": { "voyager": true, "notion": true, "aetherContext": true, "aetherProposals": true, "discordBridge": true }
  }
}
```

(The values are an example. The tool list is whatever `services/api/src/mind/tools/shannonTools.ts` holds; `count` is always the length of `names`.)

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `1` | |
| `startedAt` | ISO 8601 | When this API process started. |
| `build.revision` | string \| `null` | The revision this process loaded: the first word of the file `DEPLOYED_REVISION` in the service's working directory (the deployed source, `/home/azureuser/shannon-ios`), **read once when the process starts** and not again. The deployment writes that file after the source sync and before the restart, atomically (a temporary file in the same directory, then `mv`; `docs/self-improvement-runbook.md`, Azure delivery), so after a restart it names the source the process loaded. A file changed while the process runs is not seen until the next restart. `null` when the file is missing or its first word is not revision-like (`[A-Za-z0-9][A-Za-z0-9._+-]{0,79}`). |
| `models.text` | string \| `null` | The chat model of text replies (`SHANNON_LLM_MODEL` as resolved). `local-stub` when no model key is configured. |
| `models.voice.reply` | string | Spoken replies use the same chat model. |
| `models.voice.routing` | string \| `null` | The voice turn router: the JEV model, the native Haiku fallback (or an explicit GPT router override), or `local-rules`. `null` when the configured name fails the model-name rule above. |
| `models.voice.transcription.gemini`, `.openai` | string \| `null` | Live transcription of a voice call, per provider the app may ask for. `null`: that provider is not configured. |
| `models.voice.speech.gemini`, `.eleven` | string \| `null` | Speech synthesis, per provider. |
| `models.voice.vision` | string \| `null` | A look through the camera during a voice turn. |
| `models.dictation` | string \| `null` | `POST /v1/voice/transcriptions` (recorded voice input). |
| `models.autonomy.enabled` | boolean | `SHANNON_AUTONOMY_ENABLED=true`. Whether the owner paused her is not here (it is in her activity page). |
| `models.autonomy.prose`, `.research_reading`, `.planning`, `.critique` | string \| `null` | The model each purpose of her own activity resolves to now: her preference in the owner's scope, else the default, else any model of the registry whose provider has an explicitly permitted own-time credential (`resolveAutonomyModel`, the rule the activity process uses). Anthropic always requires explicit `SHANNON_AUTONOMY_ANTHROPIC_API_KEY`; equality with a regular Anthropic key is refused unless the owner authorized `SHANNON_AUTONOMY_ANTHROPIC_SHARED_KEY=on`. This is no regular-key fallback and does not change Google/OpenAI distinct-value rules. Read again on every request, so a changed preference shows at once. `null`: no permitted own-time credential can serve it. |
| `models.autonomy.roomLook` | string \| `null` | The model of her look at the room, when its provider has a dedicated credential. |
| `persona.hash` | 12 hex characters | See below. |
| `persona.algorithm` | `sha256` | |
| `tools.enabled` | boolean | `false` when `SHANNON_OWN_TOOLS=off`. |
| `tools.count` | integer | The number of enabled tools of the registry (`SHANNON_TOOLS`); `0` when switched off. |
| `tools.names` | string[] | Their names, in registry order. |
| `tools.offered.<surface>.<audience>` | integer | How many tools `text`, `voice` and `autonomy` offer while only the owner can see or hear the reply (`owner_alone`) and while anyone else may (`others`). Counted from the registry: folder tools are counted only while a PC or Mac is bound to her folder (`SHANNON_AUTONOMY_HOST_FOLDERS_JSON` with a `deviceId`, as the API reads it; they are still named in `tools.names`), and her Minecraft body's tools (`minecraft.*`, `text` and `voice` only, never `autonomy`) only while `SHANNON_MINECRAFT_BODY_JSON` is set (`minecraft.status`, `minecraft.cancel`) and the body is in the game (`minecraft.request`); that is decided per turn and not counted here, so a server without a body still counts them. Her Aether tools (`aether.*`, `aetherFolder.*`; `aether.propose` in `text` and `voice` only) are named and counted only while the Aether client is configured (`SHANNON_AETHER_API_URL` and `SHANNON_AETHER_SHANNON_TOKEN`), so without it `tools` is what it was before Aether access; with it, `others` counts `aether.search`, `aether.read` and `aetherFolder.list` (inside her folder). |
| `integrations.voyager` | boolean | The Voyager integration URL, token and workspace are all configured. |
| `integrations.notion` | boolean | A usable Notion token is configured. |
| `integrations.aetherContext`, `.aetherProposals` | boolean | The Aether context file, and the Aether proposal inbox, are configured. |
| `integrations.discordBridge` | boolean | The platform bridge (Discord and the legacy runtime) is configured. |

**How the persona hash is computed.** `personaHashSource()` builds one JSON array of labelled texts: Shannon's persona prompt for the owner and for a guest, the suite roles, what she can and cannot do for the owner and for a guest (`shannonCapabilityPrompt`), and the one-line voice, all from `packages/cognition/src/persona.ts` and `capabilities.ts`. `persona.hash` is the first 12 hex characters of the SHA-256 of that text in UTF-8. It is the same on every start of the same code and changes whenever any of that text changes, so two servers with the same hash speak with the same persona and the same description of her abilities. The texts themselves are never returned.

## Server switch

`SHANNON_PLATFORM_OPS_INGEST` (default on). `off`, `false`, `0` or `disabled` refuses snapshots with `403 OPS_INGEST_DISABLED` and makes `GET /v1/ops` answer `snapshot: null`. A restart applies it.

## Storage

`ops_snapshots` (`scope_key` primary key, `schema_version`, `reported_at`, `received_at`, `snapshot_json`): one row per scope, replaced on every accepted report. Created with `CREATE TABLE IF NOT EXISTS` outside the numbered migrations; the schema version is unchanged and an older API binary can still open the database.

## Stage 2: commands

The owner's desktop may ask the legacy runtime to start or stop a service, start or stop a Minecraft server, or run a schedule now. The direction is the same as in stage 1: the desktop writes a command to this API with its device token; the legacy runtime **polls, claims, performs and reports** with the bridge credential. This API never calls the runtime, the desktop never does, and nothing on this path carries text: a command is a closed `type` and one `target`, and an outcome is a closed `outcome` and `code`.

The vocabulary, the allowlist and the bounds are in `services/api/src/contracts/opsCommandContract.ts`; the routes are in `serverOpsCommandRoutes.ts`; the record is in `opsCommandStore.ts`; the contract test is `services/api/tests/opsCommands.test.ts`. Stage 1 clients and reporters work unchanged.

### Kill switch

`SHANNON_PLATFORM_OPS_COMMANDS`, **default off**. `on`, `true`, `1` or `enabled` switches commands on; anything else, or nothing, is off. A restart applies it. The owner switches it on when the legacy runtime is deployed with its claimer. It is separate from `SHANNON_PLATFORM_OPS_INGEST`: status keeps flowing with commands off.

| | Off | On |
| --- | --- | --- |
| `GET /v1/ops` | `commandsSupported: false`, `commands: []`, nothing in `allowed` | `commandsSupported: true`, the recent commands, `allowed` |
| `POST /v1/ops/commands` | `403 OPS_COMMANDS_DISABLED` | accepted or refused by the rules below |
| `POST /v1/platform/ops/commands/claim` | `200 { "command": null, "pollAfterSeconds": 60 }` | the next command or `null`, `pollAfterSeconds: 10` |
| `POST /v1/platform/ops/commands/{id}/report` | accepted, so a command claimed before the switch still ends truthfully | accepted |

Switched off, the record is kept and not shown; a command still waiting expires on its own.

### What may be commanded (the allowlist)

| `type` | `target` | Accepted when |
| --- | --- | --- |
| `service.start` | a `services[].id` | the id is one of `discord`, `twitter`, `youtube`, `youtube:live_chat`, `notion`, `minecraft`, `minebot`, and the latest snapshot names it |
| `minebot.start` | a server | the latest snapshot has a service `minecraft:<server>` and a service `minebot:bot` |
| `service.stop` | a `services[].id` | the id is one of `twitter`, `youtube`, `youtube:live_chat`, `notion`, `minebot`, `minebot:bot`, `minecraft`, and the latest snapshot names it |
| `minecraft.start`, `minecraft.stop` | a server | the latest snapshot has a service `minecraft:<server>` |
| `schedule.run` | a `schedules[].name` | the latest snapshot has a schedule with exactly this name |

- **`discord` can be started and cannot be stopped from here.** Stopping it takes Shannon offline on Discord and stops the Discord side of the bridge. `service.stop` with `discord` answers `403 TARGET_NOT_ALLOWED`.
- **Minebot (owner decision 2026-10-02).** The manager `minebot` is an ordinary `service.start` / `service.stop` target, and `minebot:bot` can be stopped with `service.stop`. The body is started with **`minebot.start`** and the Minecraft server it should join as target (`minecraft:<server>` or `<server>`, a server of the latest snapshot; the snapshot must also report `minebot:bot`). Starting the body begins using a paid planner API that the console's budget controls do not cover, so the console must confirm it in those words. `service.start` with `minebot:bot` answers `403 TARGET_NOT_ALLOWED`.
- **Lab servers are not manageable at all.** A target that begins with `progressive-lab-` or `minecraft:progressive-lab-` answers `403 TARGET_NOT_ALLOWED` for every type, whether or not a snapshot names it. (The runtime does not report them.)
- `minecraft` is the server manager, an ordinary service: it is started and stopped with `service.*`. A server is commanded with `minecraft.*` only; `minecraft:<server>` as a `service.*` target answers `403 TARGET_NOT_ALLOWED`.
- **A Minecraft target is accepted as `minecraft:<server>` or as `<server>`.** The server records, lists and hands out the form with the prefix (`minecraft:main`). The runtime strips `minecraft:` to get the server name.
- Any other service the runtime registers is not commandable until it is added to the list in `opsCommandContract.ts`.
- `minecraft.start` has no extra condition here. Whether a lab run is in progress is known to the runtime only: it reports `refused` with `lab_running`.
- `schedule.run` posts publicly. This API does not look at `postedToday`; the desktop has it in the snapshot and should confirm before a second post on the same day.

### `POST /v1/ops/commands`

- `Authorization: Bearer <device token>`. The bridge credential is refused.
- JSON, at most 4 KiB. **No other field is accepted.**

```json
{ "scopeKey": "owner", "idempotencyKey": "3f2b8c1e-7a4d-4e9b-9c1a-5d6e7f8a9b0c", "type": "service.stop", "target": "twitter" }
```

| Field | Type | Notes |
| --- | --- | --- |
| `scopeKey` | string | Replaced with the device's own scope, as on every device route (required from a fixed local token). |
| `idempotencyKey` | string, 8–80, `[A-Za-z0-9][A-Za-z0-9_.:-]*` | One per press of a button; a UUID is right. The same key with the same `type` and `target` returns the command it already made (`200`, `created: false`) in whatever state that command now is, and never makes a second one. With another `type` or `target`: `409 IDEMPOTENCY_KEY_REUSED`. |
| `type` | `service.start` \| `service.stop` \| `schedule.run` \| `minecraft.start` \| `minecraft.stop` | |
| `target` | string | For `service.*` and `minecraft.*`: the rule of `services[].id` (1–80, `[A-Za-z0-9][A-Za-z0-9_.:-]*`, not credential-shaped). For `schedule.run`: the rule of `schedules[].name` (1–80 after trimming, no control character, not credential-shaped). |

Answer: `201` for a new command, `200` for a replay.

```json
{
  "created": true,
  "command": {
    "id": "0b6f1c1e-3d0a-4f0e-9a51-2f6f0c7f5e11", "type": "service.stop", "target": "twitter", "status": "pending",
    "createdAt": "2026-10-02T03:00:00.000Z", "expiresAt": "2026-10-02T03:05:00.000Z", "requestedByDeviceId": "…"
  }
}
```

| Command field | Type | Notes |
| --- | --- | --- |
| `id` | UUID | |
| `type`, `target` | | As recorded; a Minecraft target has the prefix. |
| `status` | `pending` \| `claimed` \| `done` \| `failed` \| `refused` \| `expired` | See [Life of a command](#life-of-a-command). |
| `createdAt` | ISO 8601 | Server clock. |
| `expiresAt` | ISO 8601 | `createdAt` + 300 seconds: the time by which the runtime must have claimed it. |
| `claimedAt` | ISO 8601, absent until claimed | |
| `finishedAt` | ISO 8601, absent while `pending` or `claimed` | |
| `code` | absent, or one of the [codes](#codes) | |
| `requestedByDeviceId` | string | The paired device that asked (`local` for a fixed local token). |

Checks, in this order; a refused request records nothing:

| Status | `error` | Meaning |
| --- | --- | --- |
| `405` | `METHOD_NOT_ALLOWED` | Not `POST`. |
| `401` | `PAIRING_REQUIRED` | Missing or wrong device token, or the bridge credential. |
| `403` | `OPS_COMMANDS_DISABLED` | The kill switch is off. |
| `400` / `413` | `INVALID_REQUEST` / `REQUEST_TOO_LARGE` | Not JSON, or a body over 4 KiB. |
| `429` | `RATE_LIMITED` | More than 30 requests in a minute. |
| `400` | `INVALID_REQUEST` | An unknown field, or a field that breaks its rule. |
| `403` | `TARGET_NOT_ALLOWED` | The allowlist above. `message` says which rule (Discord, Minebot, lab server, not on the list). |
| `200` | | The `idempotencyKey` already made this command: it is returned, `created: false`. |
| `409` | `IDEMPOTENCY_KEY_REUSED` | The `idempotencyKey` already made a different command. |
| `409` | `OPS_STALE` | There is no snapshot, the latest one is stale (`stale: true` in `GET /v1/ops`), or ingest is off. The runtime is not there to act, so nothing is queued for it. |
| `422` | `TARGET_UNKNOWN` | The latest snapshot does not name this target. |
| `429` | `TOO_MANY_OPEN_COMMANDS` | Already 5 open (`pending` or `claimed`) commands in the scope. |
| `429` | `RATE_LIMITED` | Already 20 an hour accepted in the scope (any 60 minutes, counted from the record, so a restart does not reset it). |

### Life of a command

```
pending ──claim──▶ claimed ──report──▶ done | failed | refused
   │                  └─ no report in 120 seconds ─▶ failed (code no_report)
   └─ not claimed in 300 seconds ─▶ expired
```

- **A command that was not claimed within 300 seconds of its creation is `expired` and is never handed out.** An operation must not fire long after the owner pressed the button, in particular a public post, or a start after the VM came back.
- **A claimed command that was not reported within 120 seconds of the claim is `failed` with `no_report` and is never handed out again.** There is no retry of a start, a stop or a post whose effect is unknown. The owner presses again (a new `idempotencyKey`) after looking at the status.
- A command is handed out at most once, whatever happens.
- Expiry is by the server's clock and is applied whenever a command is read or written.

### `POST /v1/platform/ops/commands/claim`

- `Authorization: Bearer <SHANNON_PLATFORM_BRIDGE_TOKEN>`. A device token is refused.
- Body: `{ "scopeKey": "owner" }` and no other field. As for the snapshot, the scope used is the one the credential is bound to.
- Hands out the oldest `pending` command (first in, first out), one per call, and marks it `claimed`. Poll every `pollAfterSeconds` (10); at most 60 claims a minute are accepted. Perform one command, report it, then claim the next.

```json
{
  "command": { "id": "0b6f1c1e-…", "type": "minecraft.start", "target": "minecraft:creative",
    "createdAt": "2026-10-02T03:00:00.000Z", "expiresAt": "2026-10-02T03:02:04.000Z" },
  "pollAfterSeconds": 10
}
```

`command` is `null` when nothing waits. Here `expiresAt` is the claim time + 120 seconds: **the time by which the report must arrive.** An operation that will take longer is reported as `failed` with `timeout` before then, not left unanswered.

How the runtime maps a command to its own surface:

| `type` | Runtime call |
| --- | --- |
| `service.start` / `service.stop` | `dispatchServiceCommand(target, 'start' \| 'stop')` |
| `minecraft.start` / `minecraft.stop` | `dispatchServiceCommand(<target>, 'start' \| 'stop')` — each managed server is its own registered service `minecraft:<server>` (verified against the legacy runtime, 2026-10-02). A start is refused with `lab_running` while a paid lab run is in progress. |
| `minebot.start` | `dispatchServiceCommand('minebot:bot', 'start', <target without "minecraft:">)` — the body joins that server. Refused with `already_stopped` when that server is not running, `already_running` when the body already runs, and `lab_running` while a paid lab run is in progress. |
| `schedule.run` | `getSchedulerPort().callSchedule({ type: 'call_schedule', name: target })` |

The runtime **re-checks its own allowlist** before acting (the same lists as above, and never a `progressive-lab-*` server) and reports `refused` with `not_allowed` for anything else: the server's check is not the only one.

| Status | `error` | Meaning |
| --- | --- | --- |
| `400` | `INVALID_REQUEST` | Not a JSON object, no `scopeKey`, or another field. |
| `401` | `PLATFORM_BRIDGE_UNAUTHORIZED` | Missing or wrong bridge credential. |
| `405` | `METHOD_NOT_ALLOWED` | Not `POST`. |
| `429` | `RATE_LIMITED` | More than 60 claims in a minute. |
| `503` | `PLATFORM_BRIDGE_NOT_CONFIGURED` | The server has no bridge credential. |

A failed claim must never delay or fail the runtime's own work: short timeout, and try again at the next interval.

### `POST /v1/platform/ops/commands/{id}/report`

- Bridge credential. Body: `{ "scopeKey": "owner", "outcome": "done" | "failed" | "refused", "code"? }` and no other field. There is no message, no log and no text.

<a id="codes"></a>

| `code` | Meaning |
| --- | --- |
| `not_registered` | The runtime has no such service, server or schedule. |
| `already_running` | Nothing to start. |
| `already_stopped` | Nothing to stop. |
| `busy` | Another operation on the same target is in progress. |
| `lab_running` | A lab run is in progress on the VM; a Minecraft server is not started now. |
| `timeout` | The operation did not finish in time. |
| `error` | The operation failed. The reason is in the runtime's own log, not here. |
| `unsupported` | The runtime does not implement this type. |
| `not_allowed` | The runtime's own allowlist refuses the target. |
| `no_report` | **Set by the server only**, never accepted in a report: the claimed command was not reported in time. |

`code` is optional with every `outcome` (for example `done` with `already_running`).

Answer, `200`: `{ "id": "…", "status": "done", "code": "already_running", "duplicate": false }`.

- **Idempotent.** The same `outcome` and `code` again answer `200` with `duplicate: true` and change nothing. Report with a retry on a network error.
- A different report for a finished command answers `409 OPS_COMMAND_FINISHED`; the first report stands.
- A report that arrives after the server wrote `no_report` is accepted once and replaces it: what the runtime did is the truer record. The command was not handed out again in between.
- A report for a command that is still `pending` answers `409 OPS_COMMAND_NOT_CLAIMED`; for an `expired` one, `409 OPS_COMMAND_FINISHED`; for an unknown id, `404 OPS_COMMAND_NOT_FOUND`.
- Other answers: `400 INVALID_REQUEST` (an unknown `outcome`, a `code` outside the set, another field), `401 PLATFORM_BRIDGE_UNAUTHORIZED`, `405`, `429 RATE_LIMITED` (more than 60 a minute), `503 PLATFORM_BRIDGE_NOT_CONFIGURED`.

### What `GET /v1/ops` adds

```json
{
  "commandsSupported": true,
  "commands": [ { "id": "…", "type": "service.stop", "target": "twitter", "status": "done", "createdAt": "…", "expiresAt": "…",
    "claimedAt": "…", "finishedAt": "…", "code": "already_stopped", "requestedByDeviceId": "…" } ],
  "allowed": { "serviceStart": ["discord", "twitter"], "serviceStop": ["twitter", "minebot"], "minecraft": true, "scheduleRun": true, "minebotStart": true }
}
```

| Field | Notes |
| --- | --- |
| `commandsSupported` | `true` when the kill switch is on. A client shows command controls only then. |
| `commands` | The last 20 commands of the scope, newest first, with the fields of the command above. `[]` when the switch is off. |
| `allowed.serviceStart`, `allowed.serviceStop` | The service ids for which a start or a stop would be accepted now: the allowlist intersected with the services of the current snapshot, in the snapshot's order. |
| `allowed.minecraft` | `true` when the current snapshot has at least one `minecraft:<server>` service that is not a lab server. Then every such service of the snapshot takes `minecraft.start` and `minecraft.stop`. |
| `allowed.scheduleRun` | `true` when the current snapshot has at least one schedule. Then every schedule of the snapshot takes `schedule.run`. |

`allowed` is always present. Everything in it is empty or `false` when the switch is off, when there is no snapshot, and when the snapshot is stale: the desktop shows only controls that would be accepted. After sending a command the desktop polls `GET /v1/ops` (every few seconds while a command is `pending` or `claimed`) and shows its `status` and `code`; the status in the snapshot follows within a minute.

### Record and privacy

`ops_commands` (`command_id` primary key, `scope_key`, `idempotency_key` unique per scope, `type`, `target`, `status`, `created_at`, `expires_at`, `claimed_at`, `report_by`, `finished_at`, `code`, `requested_by_device_id`): one row for every accepted command, with how it ended. Rows are added and their status advances; none is deleted, and the runtime can only report an outcome for a command it claimed. The table is created with `CREATE TABLE IF NOT EXISTS` on the connection of `ops_snapshots`, outside the numbered migrations.

The record is in no prompt, and no model writes a command. The snapshot store is held by the ops routes alone (asserted structurally in `ops.test.ts`). Only the command journal is also supplied to the fixed home lifecycle broker described below, and the command routes accept a device token or the bridge credential only: Shannon's activity loop has neither, and starting processes is outside her bounded autonomy.

### Open questions

1. **Who else may command.** Any paired device of the owner's scope can send a command now (the device is recorded in `requestedByDeviceId`). Whether this should be the desktop only, and whether a stop or a public post needs a second confirmation, is the owner's decision; the confirmation itself is the client's.
2. **Minecraft against lab runs.** The server does not detect a lab run. The runtime refuses `minecraft.start` with `lab_running`. Whether it should instead wait for the run to end, or whether stopping a server during a run needs a rule, is not decided.
3. **`schedule.run` for a schedule that already posted today** is accepted. A second public post is something that reaches other people; whether the server should refuse it rather than leave it to the desktop's confirmation is not decided.
4. **Starting Minebot** is withheld until its planner budget is under a control the owner accepts.

## `shannon-home` のライフサイクル接続

`SHANNON_MINECRAFT_LIFECYCLE=on`、Stage4、既存の `shannon-home` 登録、mind の実行権、Ops commands スイッチが揃う API は、新しく受け付けた次の操作だけを共通ライフサイクルに接続する。Windows 管理画面のリクエスト・操作 ID・応答 DTO・状態語彙は変更しない。

| 既存 Ops 要求 | 共通操作 |
| --- | --- |
| `minecraft.start` / `minecraft:shannon-home` | `start` |
| `minecraft.stop` / `minecraft:shannon-home` | `stop` |
| `minebot.start` / `minecraft:shannon-home` | `login` |
| `service.stop` / `minebot:bot` | `logout` |

`OpsCommandStore`（`SQLiteOpsStore` の constructor から作成）が追加テーブル `ops_lifecycle_dispatches` を `CREATE TABLE IF NOT EXISTS` で作成する。既存テーブルの再構築・削除はしない。新しい Ops 行と対応するライフサイクル ID は同じ SQLite writer transaction で記録し、その行は旧 runtime の claim/report から除外する。既存の未処理・結果不明の旧コマンドを採用・再実行することはない。起動時のスキーマ確認用 DB clone もこの constructor を通す。

明示的な owner 管理操作は、新しく受け付けた mapping の `execution_kind='respond'` と元 Ops 要求を照合して、会話と同じ foreground 実行枠を使う。background の unknown が二枠を保持していても管理操作を受けられるが、background 上限・unknown・予算・資源の保持は変更しない。追加列の migration は既存行を `minecraft` のまま保存し、その旧 mapping を新枠で実行しない。`execution_kind` の変更は immutable trigger が拒否する。任意の `ops:` source や `ops-command:` 出典は一般の respond 許可に流れず、元要求・固定 mapping・実行 kind・元 lease を全部満たす専用検査を通す。

foreground admission 後の body resource は canonical writer で一度だけ取得を試み、競合する unknown/live body があれば `refused/not_allowed` で終了する。待機して会話枠を占有しない。native 実行は元 Ops の claim 時刻から既存の 120 秒 report window に束縛した signal を使い、その後の既存 cancellation drain で解放を確認できない場合は元 unknown/resource を保持する。

ボットがログアウト中でも、登録 operator の新鮮な観測を待って処理できる。元要求から一つの `owner_request` action を作り、全チャット・FCA・own-time と同じ `minecraft-body` resource を取得する。許可は元の paired-device 要求、固定された操作・対象・ID、source、現在の holder/generation、scope、owner-alone、Ops スイッチの組み合わせを照合する。任意の `ops:` 文字列だけでは権限を得られない。Ops snapshot 全体は引き続きプロンプト・kernel・worker に渡さず、この broker は model を呼ばない。

実行は [Minecraft lifecycle](minecraft-lifecycle-contract.md) の native 判定を使う。起動は確実に停止している場合だけで、既に起動中なら `already_running`。停止は native server thread の fresh な人数検査と参加 barrier を一つの判断として行い、人がいる・人数不明なら停止しない。`changed` の停止成功は `stopGuard` がなければ受理しない。ログアウトも共通の入力解放・接続終了を待つ。状態を読んでから旧 `stop.sh` / tmux 停止を呼ぶ経路には流さない。

正式な native 応答から従来の `done` / `failed` / `refused` と既存 code に投影する。人がいる、権限失効、状態不明などの拒否は `not_allowed`。結果不明は `failed` / `no_report` とし、元 action の unknown・body resource・予算を保持する。後から同じライフサイクル ID の正式な応答が届けば Ops 履歴だけを更新し、操作の再送・新しい実行権・action 全体の成功扱いは行わない。body resource の限定解除は既存の native proof recovery が担当する。

範囲外の登録サーバーは既存の native Ops 経路を保つ。`service.start/stop('minecraft')` と `service.start/stop('minebot')` は manager の状態操作であり、サーバー停止・ボット切断に置き換えない。この変更の人数 guard と共通 body lease が適用されるのは表の home/body 操作だけである。未登録・機能 OFF の経路、他サーバーの人数 guard、manager と進行中 body 操作の直列化はこの接続で保証されない。

ローカル回帰は `opsMinecraftLifecycleWiring.test.ts` が実 HTTP route・設定済み lifecycle・SQLite の元 lease で検証する。実ゲームや有料 API は使用しない。本番 DB constructor 確認と管理画面からの native 応答確認はデプロイ側で行う。
