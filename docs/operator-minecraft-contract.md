# Operator Minecraft requests

Status: implemented behind `SHANNON_OPERATOR_MINECRAFT` (default **off**). Owner decision 2026-10-14: 「Minecraft だけに限って作る」.

An operator on the production VM, as the service user, may ask the running API to do one of three things for the owner:

1. a Minecraft lifecycle operation (`start`, `stop`, `login`, `logout`, `set_day`) on a registered server;
2. one Minecraft work request, as the same common task `minecraft.request` and the in-game intent create;
3. the cancel of a request that the operator itself started.

Nothing else is offered. There is no conversation message as the owner, no memory or note, no other tool, no setting, and no
credential. Anything else is refused as `out_of_scope` and audited.

## Channel

- A Unix socket beside the database: `<dirname(SHANNON_DATABASE_PATH)>/operator-runtime/operator.sock`. The directory is `0700`
  and the socket `0600`, both owned by the service user; who can open it is who can already read the database.
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
| `start`, `stop`, `login`, `logout`, `set_day` | `serverId` (optional when one server is registered) |

The reply is `{ operationId, outcome: accepted|refused, code, message, taskId?, lifecycleId?, actionId?, deadlineAt?, budgetYen? }`:
`202` accepted, `403` out of scope, `409` any other refusal.

## Gates

Every invocation is audited before anything else, then refused when:

- it is outside the operations above (`out_of_scope`) or malformed (`invalid_input`);
- the switch is off (`disabled`);
- 20 invocations were accepted in the last hour (`rate_limited`; counted from the audit, so a restart does not reset it).

A request is also refused when someone other than the owner is present (`owner_not_alone`), the body is not exactly one connected
body (`body_unavailable`), a lifecycle operation is unresolved (`unresolved_operation`), a `minecraft` action is live
(`lease_conflict`), or any Minecraft-bound task is still running, stopping or unknown (`minecraft_busy`). `budgetYen` above the
Minecraft request cap is `budget_above_cap`.

A lifecycle operation goes through the conversation's detached path (`minecraftLifecycleWiring.ts`): its own `minecraft` action
with the operation id as its only source, the body taken once, and the native operation carried to its receipt. The lifecycle
authority allows it only when the audit holds an `invoked` row of that operation with the same action and server and no refusal,
the owner is alone, and the command id is that source. `set_day` additionally needs a running server with nobody else on it.

## The request

- A child of the root, origin `owner_request`, kind `generic`, with `MINECRAFT_REQUEST_CRITERIA` and the request working note,
  bound to the body in the same write lock as the owner's admission. It is therefore an admitted Minecraft request
  (`admittedMinecraftRequest`): the same budget, the same gates, the same body binding. The origin is not new: a new origin would
  either silently pass the owner's gates or be silently refused by them.
- `budgetYen` only lowers the Minecraft request cap (2000 yen) for that one task (`fcaBudget` `taskCapYen`); it never raises it.
- `maxMinutes` is the operator's time limit. Past it the API stops the task through the owner's stop path (`runtime.stop`, which
  waits for the body's stop acknowledgement), once, and audits `time_limit`. The limit holds with the switch turned off too.

## Attribution

Who handed a request over is never written as the owner's words. It is marked in four places:

1. the task title starts with 「（運用者経由）」;
2. its first inbox line: 「この依頼は運用者（label）がライ氏の代わりに渡したものです。ライ氏が直接言った言葉ではありません。」;
3. a note in the owner's Talk (note kind `operator-note`) when a request starts, is cancelled or reaches its time limit, and when a
   lifecycle operation is asked;
4. the audit (below), and the activity record (自律活動 › 記録), domain `minecraft_lifecycle`, whose summary names
   「運用者（label）」. The activity record's actor column admits only `shannon` and `owner`, so the actor is `owner` and the
   sentence says it was the operator.

The Observer shows the admission as a run of surface `operator_cli`; the task itself appears in 「いま」 like any other.

## Cancel

`cancel` stops only a task with an `accepted` audit row of command `request`. The owner's own task is `not_operator_task`, an id
that is no task is `not_found`, a finished or stopping one `not_running`. It uses the owner's stop path, audits `stopped`, writes
the activity record and notes the Talk. `--latest` takes the newest accepted request of the last two days that is still running.

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
$N --import tsx services/api/src/opsCli.ts minecraft login --operator ryo --server shannon-home
```

`status` opens the database read-only (socket present or not, step 012 applied / missing / changed, open operator requests, the
last ten audit rows) and writes nothing. Every other command is one request on the socket; the CLI never writes the database.
Exit codes: `0` accepted, `1` refused or failed (also when the socket is absent), `2` usage. `SHANNON_OPERATOR` may stand in for
`--operator`.

## Switch

`SHANNON_OPERATOR_MINECRAFT`, `explicit_on`, default off. A restart of `shannon-ios.service` applies it. Off: no socket; nothing new
is accepted. Off after it was on: the audit stays open so running operator requests keep their lower cap and time limit.

## Code

`contracts/operatorContract.ts`, `infra/ops/operatorSocket.ts`, `infra/ops/operatorCli.ts`, `infra/ops/store/operatorAuditStore.ts`,
`wiring/operatorServerWiring.ts`, `wiring/operatorMinecraftWiring.ts`, `wiring/operatorMinecraftRequests.ts`,
`wiring/operatorLifecycleWiring.ts`; tests `tests/operatorMinecraft.test.ts`, `tests/operatorLifecycle.test.ts`.
