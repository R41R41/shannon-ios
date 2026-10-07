# Stage 4 rollout and verification

Owner: ライ氏. Scope: Shannon only. Production baseline: `16bdf384`.
This is an operator procedure, not evidence that rollout has occurred.

## Before production mutation

Use the exact independently reviewed candidate and the shared [Azure runbook](/Users/arairyo/Documents/ChatGPT/Syzygy/docs/runbooks/shannon-azure-deploy.md). The owner must have seen its changes and verification results and authorized production delivery. A Stage 4 implementation instruction alone is not its deployment record.

Verify the candidate in a separate VM directory with copied dependencies and synthetic databases. Do not load `api.env`, pair a device, use model credentials, or start an outside Codex/Minecraft action in this check. Run API/package typechecks, deterministic services/package tests, `mindWorkerLifecycle.test.ts` and `scripts/measure-action-thread-ipc.ts`. A hard process death must release ownership, retain uncertain resources, reject old execution rights and permit only the original canonical acknowledgement. Warm IPC targets are p50 ≤ 5 ms / p95 ≤ 10 ms; this does not measure first voice audio.

Before the actual cutover, re-read the production revision, health, DB integrity and canonical open tasks/body requests. Confirm a quiet interval with no outside turn or body action in progress. Do not start Stage 4 in the middle of an unjournaled Stage 3 outside action. Use the existing stop handshake and wait for its real terminal result when necessary; do not fabricate an acknowledgement.

## Install compatible code while OFF

1. Follow the shared runbook's old-file hashes, added/modified/deleted lists, source backup, consistent SQLite backup and integrity checks. Preserve the private environment and effective systemd units in the backup. Record counts for conversation threads/messages, knowledge, tasks and device registrations. Live activity may legitimately change counts; investigate losses instead of requiring every count to freeze.
2. Install the reviewed API/worker source while `SHANNON_ADR8_STAGE4` remains OFF. Install `deploy/azure/shannon-ios-mind.service`, run `daemon-reload`, and enable its unit. Its `ExecCondition` must keep it inactive while OFF. Do not describe that expected inactivity as a service failure.
3. Update both canonical Agent Hosts before turning ON. Azure's host and this Mac's `com.shannon.agent-host` must run the reviewed protocol (`actionThreads: 1`). The Mac launch agent resolves source through `shannon-main`; moving files on the VM does not update this Mac process. Preserve its environment, dedicated Codex directory and project allowlist. Restart each host only in the quiet interval and verify its exact host heartbeat.
4. If the separate TestFlight platform repair is approved for this release, install its reviewed source **and effective** `shannon-testflight-distributor.service`. Back up the prior unit/state, preserve the timer schedule and private configuration, run `daemon-reload`, and verify `WorkingDirectory=/home/azureuser/shannon-ios` and its runtime before restarting the timer. Extracting a repository template alone does not change a running systemd unit. Keep the Agent Host's separate writable checkout untouched.
5. Recheck the five existing services, auth 401, DB integrity and loaded revision while OFF. Record source, unit and environment changes separately in the deploy manifest. Do not change dedicated credentials, Sonnet, budget or the evidence-decay choice as part of this rollout.

## Enable and observe

After the owner authorizes enabling Stage 4, back up `api.env` and set `SHANNON_ADR8_STAGE4=on` while keeping the existing Stage 3 workspace enabled. Bring up the mind worker and reload the API and autonomy worker from the same environment. Check:

- all five existing services plus `shannon-ios-mind` are active;
- one mind owns the private socket (parent 0700, socket/ownership file 0600), with no public listener;
- unauthenticated `/v1/state` is 401; the owner's ops projection reports the new loaded revision;
- the foreground and own-time paths reconnect, uncertain work is not replayed, and pending canonical acknowledgements drain without executing another model/tool request;
- existing conversation, pairing, memory and canonical work records remain reachable, and DB integrity is `ok`;
- ordinary owner conversation and voice work, and first-audio latency is compared with Stage 3 before accepting the enabled rollout;
- canonical stop/finish for a harmless authorized Agent Host/body operation behaves as tested, without false completion or resource release.

Do not spend money merely to fill a validation checkbox. A real cost-bearing outside exercise requires the owner's authorized scope and budget; record deterministic evidence separately when that exercise is not run. Minecraft enablement and Windows body work remain subject to their own owner and repository boundaries.

## Apple delivery

Server first, apps after. Fast-forward and push the approved exact `main` only when the matching iPhone/Mac delivery is authorized: a push starts both Xcode Cloud workflows and internal distribution. Preserve the app's bundle ID, pairing and conversation cache. Track Build, Archive, Upload, Processing, Assignment, Install and Smoke independently for each platform. Local unsigned builds/previews are only Build evidence. Have the owner verify the installed build and existing conversation/voice plus the new stop/resume flow through TestFlight.

## Recovery

Keep the consistent DB/source/unit/environment backups and previous revision in the manifest. If containment is necessary, turning Stage 4 OFF is temporary recovery, with the root defect still open; never delete an uncertain lock or rerun an uncertain outside request. Inspect canonical outcomes and ACK outboxes first. Source rollback restores files, deleted/new-path lists, effective units, environment and loaded revision; restore the DB only for proven migration damage with the owner. Stage 3's memory outbox must remain compatible, as described in the shared runbook.
