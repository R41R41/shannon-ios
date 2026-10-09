# Voyager open-task read

The additive Syzygy 1.1 read is
`GET /api/integrations/syzygy/v1/tasks/open?workspaceId=...&limit=20`, authenticated
with the same integration bearer token, configured owner/workspace and
`X-Syzygy-Contract-Version: 1.1` as task search. No keyword is required.

The envelope has `contractVersion`, `workspaceId`, `limit`, `items`, and `hasMore`.
Each item has the existing task projection fields (`id`, `title`, bounded
`details`, `status`, `projectIds`, `revision`, `updatedAt`) plus nullable ISO
`dueAt` and integer `priority` (0–4). Open means `thinking`, `pending`, or
`inProgress`; completed, cancelled, deleted, and other-owner tasks are excluded.
Subtasks are included. The stable order is dated tasks first, chronological due
time, descending stored priority, then immutable ID. It applies no AI ranking.
The default limit is 20, maximum 50, and `hasMore` reports explicit truncation.

Shannon derives this endpoint from `SHANNON_VOYAGER_INTEGRATION_URL`, with an
optional `SHANNON_VOYAGER_TASK_OPEN_URL` override. The existing token/workspace
configuration and owner-only disclosure gate still apply. No new permission,
write route, database migration, or autonomous read is added. Generic task
questions use this read with limit 6 in text and voice. Specific quoted/task
keywords keep the existing search contract. The empty-query `voyager.tasks`
read tool uses exactly the same projection through `readToolPorts`. Results are
data, never instructions, and retain task source IDs for provenance.

Only a successful, complete, empty response supports saying that no open tasks
exist in the configured workspace. Truncation, missing configuration, denied
access, timeout, unsupported older server and other read failures are described
explicitly. Due dates are metadata; the overview is not filtered to today. A task
write still requires the existing organize proposal/review/apply flow.

Source verification is offline: Voyager loopback route tests over synthetic
SQLite records and Shannon adapter/projection/read-tool wiring tests. The
Voyager endpoint must be deployed before production can use it; an older server
returns an unsupported-read result rather than a fake keyword search. This
change does not replace the separately configured upcoming-task snapshot read.
