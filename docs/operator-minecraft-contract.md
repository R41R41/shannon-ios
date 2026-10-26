# Operator Minecraft requests

Status: implemented behind `SHANNON_OPERATOR_MINECRAFT` (default **off**). Owner decision 2026-10-14: 「Minecraft だけに限って作る」.

An operator on the production VM, as the service user, may ask the running API to do one of four things for the owner:

1. a Minecraft lifecycle operation (`start`, `stop`, `login`, `logout`, `set_day`) on a registered server;
2. one Minecraft work request, as the same common task `minecraft.request` and the in-game intent create;
3. the cancel of a request that the operator itself started;
4. a body re-check (`release`, Minecraft run 6, owner decision 2026-10-14 「直しを入れてから自動で解放」): the API asks the body
   again whether it is stopped with every input released, and releases only what the body's own receipt proves (below). It is a
   request to check, never a force release; the owner's release (`release-retained`) is a separate path and is not offered here.

Nothing else is offered. There is no conversation message as the owner, no memory or note, no other tool, no setting, and no
credential. Anything else is refused as `out_of_scope` and audited.

## Channel

- A Unix socket beside the database: `<dirname(SHANNON_DATABASE_PATH)>/operator-runtime/operator.sock`. The directory is `0700`
  and the socket `0600`, both owned by the service user. The API makes the directory at every start, switch on or off, because
  the other units hide it and need it to exist.
- **The real boundary is the service user (`azureuser`), not the operator.** Every VM service runs as that user, and
  `ProtectHome=read-only` does not stop an AF_UNIX `connect`. So every unit in `deploy/azure` except the API's
  (`shannon-ios.service`) has `InaccessiblePaths=/home/azureuser/shannon-ios-data/operator-runtime`; the agent host, which runs
  Codex, is the one that matters most. What can still connect: an interactive login of `azureuser`, a cron job, and any process
  of that user outside those units; and a same-user process that can read another process's `/proc/<pid>/root` could reach the
  path through it. Only running the API as its own user would close those (not done here).
- There is no TCP route. nginx forwards every path of `127.0.0.1:4319` under `/companion/` to the internet-facing site, so a new
  TCP route would be reachable from outside, and a loopback secret would be a new credential to mint, store and keep unprinted.
- Only `POST /operator/v1/minecraft` is served (8 KiB body). A request with `X-Forwarded-For` is refused.
- The socket exists only while the switch is on and the API runs. A socket that still answers stops a second API from taking it;
  a stale one is removed.

Envelope: `{ "v": 1, "operator": "<label>", "domain": "minecraft", "op": "<op>", "args": { ... } }`. The operator label
(`[A-Za-z0-9._@-]`, at most 64) is a name for the audit, not a credential. Unknown fields are refused.

| `op` | `args` |
| --- | --- |
| `request` | `goal` (1..1000 characters, no control characters), `maxMinutes` (1..120, default 30), `budgetYen` (1..2000, default 2000) |
| `cancel` | `taskId` (a task UUID) or `latest: true` |
| `budget` | `taskId` (a task UUID) or `latest: true`, and `budgetYen` (a whole number, 1..2000): see [Changing a running request's budget](#changing-a-running-requests-budget) |
| `start` | `serverId` (optional when one server is registered), `keepWorld` (optional boolean; `true` only) |
| `stop`, `login`, `logout`, `set_day` | `serverId` (optional when one server is registered) |
| `release` | none (`serverId` accepted and ignored: there is one configured body) |

The reply is `{ operationId, outcome: accepted|refused, code, message, taskId?, lifecycleId?, actionId?, deadlineAt?, budgetYen? }`:
`202` accepted, `403` out of scope, `409` any other refusal.

## Gates

Every invocation is audited before anything else, then refused when:

- it is outside the operations above (`out_of_scope`) or malformed (`invalid_input`);
- the switch is off (`disabled`);
- 20 invocations were accepted in the last hour (`rate_limited`; counted from the audit, so a restart does not reset it);
- 120 invocations were made in the last hour, refused ones and socket refusals included (`flooded`, `429`). A flood is not
  audited one by one: one coalesced audit row a minute (`code = flooded`, `detail = suppressed=N`), nothing in the activity record.

Refusals reach the owner's activity record only for the first 10 an hour; the 11th writes one line saying the rest of the hour
is in the audit only. Every refusal before a flood is still its own audit row.

A refusal at the socket itself (another path or method, a forwarded request, an unreadable or oversized body) is audited without
anything of the request: operator `unknown`, command `socket`, code `socket_not_found`, `socket_forwarded` or
`socket_invalid_body`, arguments `{}`.

A request is also refused when someone other than the owner is present (`owner_not_alone`), the body is not exactly one connected
body (`body_unavailable`), a lifecycle operation is unresolved (`unresolved_operation`), a `minecraft` action is live
(`lease_conflict`), or any Minecraft-bound task is still running, stopping or unknown (`minecraft_busy`). `budgetYen` above the
Minecraft request cap is `budget_above_cap`.

A lifecycle operation goes through the conversation's detached path (`minecraftLifecycleWiring.ts`): its own `minecraft` action
with the operation id as its only source, the body taken once, and the native operation carried to its receipt. The lifecycle
authority allows it only when the audit holds an `invoked` row of that operation with the same action and server and no refusal,
the owner is alone, and the command id is that source. `set_day` additionally needs a running server with nobody else on it.
Right after a login the player count may still be unknown (RCON `list uuids` is slow while a world generates; run 6): `set_day`
then looks again for up to 12 s, and answers `not_settled` (「ログイン直後で…まだ確かめられません」) if it is still unknown;
a stopped server or another player is `refused` with that reason. The command line prints the code and the message.
When it ends, her notice (【知らせ:作業終了】) names it as the operator's: the tool is `operator.minecraft.<action>` (its source is
`operator:<uuid>`, which only this audited path makes) and the line reads 「運用者がライ氏の代わりに頼んだ〈minecraft.start〉が終わった」,
never 「受け付けた…」 as if she had accepted it.

## The body re-check (`release`)

An FCA step whose outcome stayed unknown keeps the Minecraft body retained until a release proof (ADR-0009 §9). Run 6: a stop handed
over during a 10 s stall of the API never reached the body, so no receipt could ever prove the body released. The API
(`minecraftBodyRecheckWiring.ts`) sends the body a `release` of the same lease and session under a new id (`recheck:<sha256>`);
the body cancels what of that session may remain and answers `stopped` only once its actuator confirmed every physical input
released. That original receipt, with nothing of the lease sent after it left unsettled, is the domain proof
(`minecraftFcaReleaseProof`) the action store re-reads under its writer lock before it ends the retained record
(`mind_action_retained_releases`: `domain`, `domain_proof`, `proof:fca-release:<sha256>`). The action itself stays `unknown`.

- The API does it on its own for every retained body of an unknown step, every 5 s once the body is connected, at most three
  physical attempts per step and process; waiting for the body to connect does not count.
- The Minecraft recovery (`fcaBodyRecovery.ts`, 2026-10-19) uses the same command and proof for the lost step of a Minecraft request
  at once, without waiting for the unknown exit to record the body as retained (`releaseStep`, log `origin=recovery`), asking with a
  backoff of 10 s doubling to 5 min and at most ten unconfirmed times per lost step (then the task is paused with
  `fca_body_release_unproven` and the step stays open, never closed without the proof; the count is kept across restarts), and then
  closes the step and returns the task to the queue with a notice (see the *Provider errors and lost Minecraft steps* section of
  [fca-runtime-contract.md](fca-runtime-contract.md)). `SHANNON_FCA_BODY_RETURN_MINUTES` (default 30) is how long it waits for the body.
  A task that is paused meanwhile keeps its lost step open, so the body stays held for other requests; the recovery goes on asking
  for the proof (a minute doubling to 30 minutes, at most 20 times per lost step) and, when the body proves it, closes the step and
  frees the body while the task stays paused. If the proof never comes, the pause summary says the body stays held, and this
  `release` (`opsCli.ts minecraft release --operator <label>`) is the way to ask the body again by hand.
- `release` asks for a pass now, whatever those attempts. Codes: `released` (accepted), `not_retained`, `body_unavailable`,
  `not_confirmed` (the body could not confirm: still retained), `proof_refused`, `recheck_busy`. Audited as `invoked`, `accepted`
  and `settled` with the result code.

## The request

- A child of the root, origin `owner_request`, kind `generic`, with `MINECRAFT_REQUEST_CRITERIA` and the request working note,
  bound to the body in the same write lock as the owner's admission. It is therefore an admitted Minecraft request
  (`admittedMinecraftRequest`): the same budget, the same gates, the same body binding. The origin is not new: a new origin would
  either silently pass the owner's gates or be silently refused by them.
- `budgetYen` only lowers the Minecraft request cap (2000 yen) for that one task (`fcaBudget` `taskCapYen`); it never raises it
  above that cap (`minecraft budget` below changes it later, within 1..2000).
  It caps the request itself, the root of its work: a child the request starts has its own cap, as for the owner's requests.
- `maxMinutes` is the operator's time limit. Past it the API stops the task through the owner's stop path (`runtime.stop`, which
  waits for the body's stop acknowledgement). It is enforced until the task's phase is terminal, not until a stop was audited: a
  cancelled task whose stop did not take is stopped again at the limit. `time_limit` is audited, recorded and noted once. The
  limit holds with the switch turned off too.

## Attribution

Who handed a request over is never written as the owner's words. It is marked in four places:

1. the task title starts with 「（運用者経由）」;
2. its first inbox line: 「この依頼は運用者（label）がライ氏の代わりに渡したものです。ライ氏が直接言った言葉ではありません。」;
3. only with `SHANNON_OPERATOR_TALK_NOTES=on` (off by default since 2026-10-19: these notices were a quarter of her lines in a week),
   a note in the owner's Talk (note kind `operator-note`) when a request starts, is cancelled or reaches its time limit, and when a
   lifecycle operation is asked. The conversation store keeps only `user` and `assistant` messages (a CHECK of
   `conversation_messages`), so the note is stored as `assistant`; its words are therefore a marked, neutral notice in the third
   person (「［運用者の操作のお知らせ］運用者がライ氏の代わりに…」), never her voice and never his request;
4. the audit (below), and the activity record (自律活動 › 記録), domain `minecraft_lifecycle`, whose summary names
   「運用者（label）」. The activity record's actor column admits only `shannon` and `owner`, so the actor is `owner` and the
   sentence says it was the operator.

The Observer shows the admission as a run of surface `operator_cli`; the task itself appears in 「いま」 like any other.

Its result is never told as something he asked for; whether a task is the operator's is read from the audit (an accepted
`request` row naming it, `operatorRequester`), never from its title, so his own request that starts with the same words stays his.
When the audit cannot be read, the doubtful case never claims he asked: a title with 「（運用者経由）」 gets the operator's line,
and any other task the neutral fixed line 「依頼「…」の結果が届いています。詳しくは画面にあります。」 (no model, no 「頼まれ」). The spoken form of its report (what a call says, and a report card's short
answer) is the fixed line 「運用者がライ氏の代わりに渡した依頼「…」の結果が届いています。詳しくは画面にあります。」, written without a
model (`handedOverReportLine`); the report itself stays on the screen. Such a request has no source Talk, so no report card is
written for it.

## Cancel

`cancel` stops only a task with an `accepted` audit row of command `request`. The owner's own task is `not_operator_task`, an id
that is no task is `not_found`, a finished or stopping one `not_running`. It uses the owner's stop path, audits `stopped`, writes
the activity record and notes the Talk. `--latest` takes the newest accepted request of the last two days that is still running.

A stopped task stays `paused` with `pauseReason = 'fca_stopped'`: that is the common runtime's finished `stopped` phase (resumable
only by an explicit resume), not a stop still in flight. A task that was waiting holds no step, so its stop needs no body
acknowledgement and is `stopped` at once, body or no body (Minebot lane run 1, 2026-10-14: the task had waited since before the VM
was evicted). `stop_requested = 1` stays on the checkpoint as the mark of that stop. A stopped task counts toward nothing: the
admission's `minecraft_busy`, `cancel` and the time limit all treat `stopped` as finished, and it holds no lease.

## Changing a running request's budget

`opsCli.ts minecraft budget --operator <label> (<task-id> | --latest) <yen>` (run 39, 2026-10-26: the owner said "continue to 45 minutes, up to
1,600 yen", nothing could change the cap of a running task, and its request's 1,000 yen ended it). The cap in force is the newest
accepted `budget` row of the task's audit, else the request's own `budget_yen` (`OperatorAuditStore.budgetYen`, the one resolution the
budget check reads at every decision, so a change holds from the task's next decision, with no restart). The request's row is never
written over: a change appends a row (`command = budget`, `event = accepted`, `budget_yen` = the new cap, `detail = from=… to=… spent=…`,
the operator, the time and the task). Raising is free up to the request cap, 2000 yen (`budget_above_cap` above it); lowering is allowed
down to what the task has used, confirmed plus estimated (`budget_below_spent` below it). Zero, negative, fractional and non-numeric
yen are `invalid_input`; a task the operator did not start is `not_operator_task`, an unknown one (or `--latest` with none running)
`not_found`. A task that has already stopped or finished (also one stopped by its budget) is `not_running`: the answer says the budget
change does not resume it, and nothing is written. The time limit is not changed by it (the deadline stays the request's `--max-minutes`).

## Waiting

Nobody can answer a task the operator handed over: the CLI only starts and stops. Such a task (`operatorRequester` = `operator`)
with no unfinished child is told so in each decision (`waiting`, closed values, `fcaWaitGate.ts`); a wait it proposes anyway is
turned away and the step continues, at most `FCA_WAIT_REFUSALS` (2) times; a wait after that is committed with her own summary and
the task is stopped (`wait_without_counterpart`). Nothing is written or said for her. The owner's own requests are not affected.

## Audit

`operator_audit` (schema step `execution/012_operator_audit`): one row per event (`invoked`, `accepted`, `refused`, `settled`,
`stopped`, `time_limit`) with the operation id, the operator label, `via = 'operator_cli'`, the command, the code, the envelope's own
`domain`/`op`/`args` (bounded), and the ids produced (task, lifecycle, action, deadline, yen). Triggers refuse `UPDATE`, `DELETE` and
`INSERT OR REPLACE`. The table is created only when the switch is first on; a database that never had it keeps its schema. Rolling
the build back leaves the table, which an older build does not read.

## Command line

`services/api/src/opsCli.ts`, as the service user. It needs only `SHANNON_DATABASE_PATH` (absolute); do not source `api.env`:

```sh
cd /home/azureuser/shannon-ios
export SHANNON_DATABASE_PATH=/home/azureuser/shannon-ios-data/shannon.sqlite
N=/home/azureuser/shannon-ios-runtime/bin/node
$N --import tsx services/api/src/opsCli.ts minecraft status
$N --import tsx services/api/src/opsCli.ts minecraft request --operator ryo --max-minutes 20 --budget-yen 500 石を16個集めて
$N --import tsx services/api/src/opsCli.ts minecraft cancel --operator ryo --latest
$N --import tsx services/api/src/opsCli.ts minecraft budget --operator ryo --latest 1600
$N --import tsx services/api/src/opsCli.ts minecraft login --operator ryo --server shannon-home
$N --import tsx services/api/src/opsCli.ts minecraft start --operator ryo --server shannon-home --keep-world
$N --import tsx services/api/src/opsCli.ts minecraft release --operator ryo
```

**`start` follows the owner's 「新しいワールドで始める」 switch** ([ops-contract.md](ops-contract.md#fresh-world-switch)): with the switch on, the server stopped and the body able to do it, an operator's `start` also makes a new world (the previous one is kept under another name, never deleted), because it is the owner's own request made through the operator. `--keep-world` (`keepWorld: true`, `start` only; any other operation refuses it as `invalid_input`) opts out for that one start: the current world is kept and the activity record says `fresh_world_keep_world`. It is a **bare flag only**: `--keep-world=false` (or any `=value`) is a usage error, never read as "not given" (to follow the switch, leave the flag out). The audit's `settled` row names the new world (`worldId=…  movedTo=…`) when one was made for a command that asked for one, and also for one whose world moved while the start could not be confirmed (`unknown  worldId=…  movedTo=…  start_unconfirmed`).

`status` opens the database read-only (socket present or not, step 012 applied / missing / changed, open operator requests (an accepted request
not stopped, not timed out, and whose task has not ended by any path: completed, failed, retired, cancelled or stopped, read from
`agent_tasks`, fix 2026-10-14), the last ten audit rows) and writes nothing. Every other command is one request on the socket; the CLI never writes the database.
Exit codes: `0` accepted, `1` refused or failed (also when the socket is absent), `2` usage. `SHANNON_OPERATOR` may stand in for
`--operator`.

## Skill import (`skills import`)

This is the one operation outside Minecraft. It was added by the coordinator's choice on the owner's behalf (2026-10-14), because the owner holds no paired-device token outside the apps.

```sh
$N --import tsx services/api/src/opsCli.ts skills import dry-run --operator ryo --pack legacy-minecraft --revision draft-2
$N --import tsx services/api/src/opsCli.ts skills import apply --operator ryo --pack legacy-minecraft --revision draft-2 \
  --plan-hash <planHash from the reviewed dry-run> --approval-reference <owner approval reference>
```

- **Same import as the paired route.** The API runs exactly what `POST /v1/autonomy/skills/import/*` runs (`runSkillImport`, `infra/http/skillImportCommand.ts`):
  - the same importer and app-owned packs only;
  - the same validation, capacity check, plan hash and transaction;
  - the same immutable receipt, which keeps `--approval-reference`.
- **Reply.** The reply's `skillImport` is the paired route's body. The CLI prints the plan hash, capacity, each skill's name and SHA-256 (never the bodies), the problems, and the receipt.
- **Exit code.** A dry-run that finds problems exits `1`.
- **Retries.** Applying the same pack again answers its existing receipt (`idempotent=true`).
- **Refusals.** A changed state is refused as `stale_plan`, and a failed validation as `validation_failed`.
- **Records.**
  - The audit names the operator (command `skill_import`).
  - An applied pack is written to the activity record as adopted through the operator, with its approval reference.
- **Gates.** It needs her skills on (`SHANNON_SKILLS`) and this socket (`SHANNON_OPERATOR_MINECRAFT`). It does not depend on who is present, a Minecraft body, or a lease.

## Switch

`SHANNON_OPERATOR_MINECRAFT`, `explicit_on`, default off. A restart of `shannon-ios.service` applies it. Off: no socket (only its
empty directory); nothing new is accepted. Off after it was on: the audit stays open so running operator requests keep their lower cap and time limit.

## Deploy

The units' `InaccessiblePaths=` fails a unit's start when the directory is missing (status 226 on systemd 245), so the
directory is made at boot by systemd-tmpfiles, before any unit, not by the API's start order:
`deploy/azure/shannon-operator-runtime.tmpfiles.conf` (`d /home/azureuser/shannon-ios-data/operator-runtime 0700 azureuser
azureuser -`). On the first deploy of this change:

1. `sudo install -m 0644 deploy/azure/shannon-operator-runtime.tmpfiles.conf /etc/tmpfiles.d/shannon-operator-runtime.conf`
2. `sudo systemd-tmpfiles --create /etc/tmpfiles.d/shannon-operator-runtime.conf`, then check the directory is `0700 azureuser`;
3. install the changed unit files, `sudo systemctl daemon-reload`, and restart every changed unit, the agent host included
   (`shannon-agent-host.service`), not only the API; check each is active.

The API also makes the directory at each start (a second guard; it changes nothing when tmpfiles made it).

## Code

`contracts/operatorContract.ts`, `infra/ops/operatorSocket.ts`, `infra/ops/operatorCli.ts`, `infra/ops/store/operatorAuditStore.ts`,
`wiring/operatorServerWiring.ts`, `wiring/operatorMinecraftWiring.ts`, `wiring/operatorMinecraftRequests.ts`,
`wiring/operatorLifecycleWiring.ts`; tests `tests/operatorMinecraft.test.ts`, `tests/operatorLifecycle.test.ts`.
