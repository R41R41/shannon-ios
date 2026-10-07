# Shannon self-improvement runbook

Revision: 2026-09-05

This is the operational authority for user-directed Shannon changes.

## Definition of done

A task is complete only after every applicable layer succeeds:

1. **Source** — requested behavior is implemented without overwriting unrelated work.
2. **Regression** — API typecheck/tests and Swift package tests pass for cross-layer changes.
3. **App build** — the unsigned generic iOS build succeeds for iOS changes.
4. **Azure delivery** — production files are backed up, deployed, services restarted, and the health endpoint succeeds when server delivery was requested.
5. **Physical device** — a signed build is installed and launched on the connected iPhone when device delivery was requested. A successful compile alone is not device completion.
6. **Background behavior** — an agent task remains queryable after the app backgrounds or the Agent Host restarts when task orchestration changed.

If a prerequisite is unavailable, keep the task non-complete and report the exact remaining action.

The Agent Host must distinguish a finished Codex turn from a finished Shannon task. Every Codex turn ends with the `SHANNON_TASK_RESULT` contract supplied by the host prompt. `completed` is accepted only when all applicable conditions above are satisfied. A missing contract, failed recorded verification, unavailable build environment, pending approval, or unfinished deployment is stored as `paused` together with the next concrete action; it must never be projected as completion.

## Local verification

### Xcode entry point

Open only the repository-root `Shannon.xcworkspace` in Xcode. `ShannonApp` and
`ShannonDesk` both depend on the same local `apps/ios` package, so opening their
`.xcodeproj` files in separate Xcode windows creates competing package graphs and
can surface `Missing package product 'ShannonAppCore'`. Select the required scheme
inside the single workspace for development, device runs, Archive, and distribution.

If an older project window is already open, close it before opening the workspace.
Use the guarded launcher (`Open Shannon in Xcode.command` in Finder) so both package
consumers are resolved and checked before Xcode opens:

```sh
scripts/xcode.sh open
```

For a non-GUI check, run `scripts/xcode.sh preflight`. The focused workspace guard
also checks the workspace and both project-level lockfiles against the exact WebRTC
version, the exported `ShannonAppCore` product, and both project product links.

Do not delete package caches as a routine fix. The repository verifier builds both
apps through the canonical workspace. `scripts/xcode.sh` owns all Xcode command-line
profiles, while the focused workspace guard and its tests fail if that invariant is
removed.

### App Store Connect account preflight

The repository guard fixes the release identity to automatic signing, Team
`66TZ23L7ZJ`, and bundle identifier `com.r41r41.shannon`. It intentionally cannot
read or repair the private App Store Connect session stored by Xcode. Before starting
an Archive distribution, open **Xcode > Settings > Accounts** and confirm that the
signed-in Apple account can access Team `66TZ23L7ZJ`. If Xcode shows “Unable to
authenticate” or “No App Store Connect access for the team”, stop before retrying
Upload, refresh that account in Xcode, and confirm the team again. Never place Apple
credentials, app-specific passwords, or API keys in this repository or its scripts.

Use the single repository entry point:

```sh
scripts/verify.sh fast
scripts/verify.sh api
scripts/verify.sh ios
scripts/verify.sh app
scripts/verify.sh all
```

- `fast`: Canonical documentation, screen contracts, cross-app fixtures, and architecture boundaries. No network, production, signing, Simulator, or device access.
- `api`: TypeScript typecheck and deterministic API tests.
- `ios`: Swift package tests.
- `app`: generic unsigned iOS application build.
- `all`: fast checks, API tests, Swift package tests, unsigned iOS build, Mac tests, and Release Runner tests in sequence.

Real-LLM evaluations are opt-in because they cost money. Run them only for changes to extraction, proposal decisions, or model behavior and record that cost-bearing tests were intentionally used.

## Agent Host

The Mac launchd label is `com.shannon.agent-host`; the Azure unit is `shannon-agent-host.service` (present in the recorded Stage 4 production baseline). After changing Agent Host or bridge code:

1. Run API verification.
2. Restart the launch agent.
3. Confirm the intended host is running and the task is routed only to its exact host ID.
4. Confirm its authenticated heartbeat reaches Azure.
5. For lifecycle changes, start a harmless task and verify start, progress, reconnect, and completion events.

The Agent Host must launch Codex only inside an allowlisted project. Its saved state contains task, Codex thread, turn, and pending-approval checkpoint identifiers used for reattachment after restart. A cloud host must use a dedicated writable checkout, never the live API deployment directory.

For cloud TestFlight delivery, work on `shannon/task-<task-id>`. Do not integrate or push `main` until tests pass and the user explicitly requested delivery. That explicit request authorizes the matching push, integration, and distribution; do not ask for a second approval at execution time. If the target or scope changes, clarify the new action before proceeding. Xcode Cloud, not Azure Linux, performs the iOS build and signing.

An approval belongs to the live Codex connection that requested it. If the Agent Host restarts while waiting for approval, never infer that the old request was accepted and never leave Azure in `waiting_approval`. Clear the stale approval projection, retain the same task and original execution as unknown, and inspect its canonical action/Host receipt. Never create a clean thread or fresh command to replay a possibly dispatched operation. Continue only after a definite original outcome or the owner’s reviewed recovery establishes what remains. Ask for a fresh approval only if the remaining operation independently requires one. An explicit delivery request continues to authorize its matching release after recovery. An unmatched historical tool call is not evidence that its external operation failed to execute.

If a saved turn is no longer active after restart, inspect the original execution receipt and working tree before any resume; do not automatically replay an unknown dispatched action. Do not create a duplicate task or repeat changes that are already present.

## Azure delivery

Production locations:

```text
/home/azureuser/shannon-ios/
/home/azureuser/shannon-ios-data/shannon.sqlite
/home/azureuser/.config/shannon-ios/api.env
```

Before a schema or persistence change:

1. Record the service state and health result.
2. Make a timestamped copy of the SQLite database and its WAL/SHM companions when present.
3. Deploy only reviewed files; never upload local `.env` files or DerivedData.
4. Run the production typecheck/tests needed by the change.
5. Write the revision **after the source sync and before any restart**, atomically, in the deployed source directory: `cd /home/azureuser/shannon-ios && printf '%s\n' <commit> > DEPLOYED_REVISION.tmp && mv -f DEPLOYED_REVISION.tmp DEPLOYED_REVISION`. The temporary file is in the same directory, so `mv` is a rename and a process never reads a half-written file. The API reads this file once when it starts and reports it as the revision it loaded (`build.revision` of `server` in `GET /v1/ops`, `docs/ops-contract.md`), so a restart before this step would report the previous revision for the new code.
6. Restart only affected services: `shannon-ios.service`, `shannon-ios-worker.service`, `shannon-ios-world.service`, and/or `shannon-ios-autonomy.service`.
7. Verify health, logs, database access, and preserved conversation/task counts. The API's startup line `Shannon self-diagnosis {…}` names the revision written in step 5.

Recovery means restoring the backed-up database and the previous source files, writing the previous commit to `DEPLOYED_REVISION` the same way, then restarting the same affected services.

Release order: when a client relies on a new server field or flag (for example `roomLook` on `GET /v1/initiatives`, which the Mac notifications read), deploy the server first and ship the iPhone or Mac build after it; clients still judge an older server on the safe side, but the server is never the one that lags.

## Shannon's activity loop

The loop (Syzygy ADR-0002 step 3) is `services/api/src/autonomyWorker.ts`, run as `shannon-ios-autonomy.service`. It is off until all three hold: the server switch, no owner pause, and a dedicated credential.

To turn it on:

1. At the provider, create an API key used for nothing else and set a spending limit on it. This limit is the real backstop; the application's daily counter is not.
2. In `/home/azureuser/.config/shannon-ios/api.env` (mode 0600) set `SHANNON_AUTONOMY_GEMINI_API_KEY` (and/or `SHANNON_AUTONOMY_OPENAI_API_KEY`), never the conversation key, then `SHANNON_AUTONOMY_ENABLED=true`. Optionally set `SHANNON_AUTONOMY_MODEL_PRICES_JSON`; without it a model whose price is not in the code is counted at a high fail-safe rate.
3. Back up the database as for any persistence change. The loop adds tables with `CREATE TABLE IF NOT EXISTS`; the schema version does not change.
4. Install `deploy/azure/shannon-ios-autonomy.service`, then `systemctl enable --now shannon-ios-autonomy.service` and restart `shannon-ios.service` so the API reads the same switch.
5. Check `journalctl -u shannon-ios-autonomy.service`: the first line names the readiness (`ready`, `disabled`, or `no_credential`), later lines only the loop state. In the app, 設定 → シャノンの自律 shows 動いています.

Pacing and what she may see (owner decisions 2026-10-02, Syzygy ADR-0003): by default she runs in sessions at times of her choosing inside the daily budget (`SHANNON_AUTONOMY_PACING=sessions`, bounds `SHANNON_AUTONOMY_SESSION_*`), and her thinking is given one bounded block of the owner's context (`SHANNON_AUTONOMY_OWNER_CONTEXT=on`). For that block the autonomy service opens the same stores as the API on the same database, so it is restarted with the API after a persistence change, after the usual backup. `SHANNON_AUTONOMY_PACING=cycles` and `SHANNON_AUTONOMY_OWNER_CONTEXT=off` in `api.env`, followed by a restart of both services, restore the fixed cycles and the prompts as they were; the two switches are independent and both are needed for that.

To pause: 設定 → シャノンの自律 → 「自律活動を一時停止」, or the same switch in 「したことの記録」. It takes effect before the next step; a step already under way is finished and recorded. Chat, voice, memory, and work the owner started are not affected.

To read what she did: 頭の中 → シャノンのやりたいこと → 「したことの記録」 (each day's short log, every step with its cost, today's spend against the cap) and 「書斎」 (her notes, and the stories she is willing to show).

To roll back: set `SHANNON_AUTONOMY_ENABLED=false` and restart `shannon-ios.service` and `shannon-ios-autonomy.service`, or `systemctl disable --now shannon-ios-autonomy.service`. Either stops every step; the record, the budget history, and her study stay in the database and stay readable. Revoke the dedicated key at the provider if spending must stop for certain. An older API binary can open the database with the added tables.

## iPhone TestFlight delivery

1. Build the intended source with Xcode Cloud and confirm the signed build, bundle identifier `com.r41r41.shannon`, and build number.
2. Confirm App Store Connect processing and assignment to `Shannon Internal` through the Release Runner.
3. Have the owner update the existing app through TestFlight. Do not directly install or upload a development build to the iPhone for verification.
4. Confirm the installed build number when it is available, then check conversation restoration, pairing, the changed flow, and one adjacent flow through the TestFlight app. Record owner-reported checks separately from directly observed checks.

### Distribution platform

The timer runs the reviewed source and dependencies in `/home/azureuser/shannon-ios`, not the writable Agent Host task checkout.
Stop it during deployment and restore it after the source and dependency checks.
The Azure timer selects iPhone builds with App Store Connect's `filter[preReleaseVersion.platform]=IOS`.
`SHANNON_ASC_PLATFORM` defaults to `IOS`; a separately configured Mac distributor may use `MAC_OS` with its own state file.
The Mac Xcode Cloud workflow continues to assign its builds to Shannon Internal in its post-action.
Never compare build numbers across platforms when choosing the next iPhone release.

## Shannon Release Runner

`scripts/release-runner.sh` is the single local entry point for routine Xcode Cloud/TestFlight delivery. It reuses the Azure TestFlight distributor; it does not create a second build-assignment system. The shell entry point locates the same bundled Node.js fallback as the repository verifier.

1. `inspect` confirms `R41R41/shannon-ios`, `main`, the exact HEAD, staged-change safety, and visible uncommitted paths.
2. `prepare` runs the deterministic API/iOS/app checks plus an unsigned iPhone Release build.
3. `publish` requires both the exact prepared HEAD and `--confirm-external-release`. Use that operator flag when the current user request explicitly includes this external delivery; it does not require another user confirmation. It skips an already-pushed commit and never force-pushes.
4. `monitor` reads only the safe Azure distributor projection until the expected Build is assigned to `Shannon Internal`.
5. Every phase writes a credential-free summary to `.build/release-runner/latest.json`.

The end-to-end form is:

```sh
scripts/release-runner.sh run \
  --expected-head EXACT_COMMIT_SHA \
  --expected-build EXPECTED_BUILD_NUMBER \
  --confirm-external-release
```

The Runner may report unrelated unstaged files, because only committed content is pushed. Any staged file stops the run until it is deliberately committed or unstaged. A failed or timed-out run is not completion; inspect the JSON summary and existing TestFlight history before retrying.

## Retiring the Mac Electron app (A18 S4)

The SwiftUI Mac app (`ShannonDesk`) hosts her folder, her desktop body and the menu bar, and opens at login. The Electron app in `/Users/arairyo/shannon-desktop` is no longer used on the Mac. By the owner's decision of 2026-10-06 its files are kept and renamed, never deleted. The owner does these steps himself; an agent does not touch those files.

1. Quit the Electron app (its menu bar item, 終了).
2. System Settings › General › Login Items: remove 「Electron」 (the Electron app's login item). Leave `com.shannon.agent-host` (the Mac Agent Host) alone; it is not the Electron app.
3. Rename `/Users/arairyo/shannon-desktop` to `/Users/arairyo/shannon-desktop-retired-2026-10` and `~/Library/Application Support/shannon-desktop` (its settings) to `~/Library/Application Support/shannon-desktop-retired-2026-10`.
4. Keep `~/Desktop/シャノン用` as it is and choose it in ShannonDesk, 設定 › 専用フォルダ (it already has `.shannon/folder.json`). Its earlier copies stay in the folder.
5. If a server host entry still names the Electron app's device, remove that entry from `SHANNON_AUTONOMY_HOST_FOLDERS_JSON` (API and loop) and restart both; `owner-mac` names ShannonDesk.

The same steps are shown in 設定 › 専用フォルダ › 古い Mac 版（Electron）.

Its stream output for OBS (A18 S5) is ShannonDesk's 設定 › すがた › 配信用の出力（OBS）, at the same address (`http://127.0.0.1:41760/stream.html`), so an OBS browser source made for the Electron app keeps working. Both use port 41760: while the Electron app runs with its 配信用の出力 on, ShannonDesk cannot take the port and switches its own back off with the reason under the switch. Quit the Electron app first (step 1). Two builds of ShannonDesk cannot share the port either: the second says it is taken.

## Data-preservation checks

For persistence-affecting work, compare before/after evidence for:

- conversation thread and message counts
- knowledge and memory records
- active/past agent tasks
- device pairing registrations
- API health and worker startup

Migrations must be additive, idempotent, and safe to retry after interruption.

## Completion report

Report:

- what changed in user terms
- which verification targets passed
- whether Azure and/or the iPhone were actually updated
- what was deliberately not run, especially live-LLM tests
- any remaining blocker without presenting it as completion

## Stage 4 shared mind rollout

The explicit switch, private IPC, device protocol order, stop/unknown recovery, and checks are in [action-threads-contract.md](action-threads-contract.md). Stage 4 was released at `8200c128` with its switch ON and Build 169/168 owner-device confirmation recorded 2026-10-08. The following initial rollout procedure remains applicable to a fresh environment; a successful unsigned build is not authorization or evidence of production deployment. Run independent core review and the existing production/Apple gates before enabling `SHANNON_ADR8_STAGE4=on`. Install the API route and updated Agent Host with the switch OFF first. The new `shannon-ios-mind.service` exits its main Node launcher successfully when OFF, and imports the existing worker in the same process when ON. `Restart=on-failure` still recovers actual worker failures; a skipped `ExecCondition` would be retried by the VM's systemd 245. Inspect canonical outcomes before reconciling an unknown action; never replay it to test whether the previous attempt worked.

## Stage 5 rollout and recovery

The maintained implementation contract is [adr8-stage5-contract.md](adr8-stage5-contract.md). The branch is under verification and Stage5 is not deployed. Keep `SHANNON_ADR8_STAGE5` OFF for the initial API/worker/Host installation. After the full existing checks, original proof and current-audience tests, and reviewed backup/health/authentication checks, the reviewed release may enable it. OFF supplies no new ports/tools or prompts; it leaves additive tables and all receipts intact. Never use rollback/OFF to erase bans, forgotten material, uncertain Host effects or original operation IDs.

For uncertain reactions/interests/tree operations, retrieve the saved operation or proposal with GET and its original ID. Do not retry POST to discover its outcome. For task/self-revision unknown state, verify the original action generation/holder, Host turn and physical before/after snapshots before reconciliation; do not create a fresh attempt. A revision failure freeze is attached to the work, survives new candidate IDs and requires explicit owner resume. Host costs remain unreported unless actual per-task accounting becomes available; do not describe the existing zero sentinel as measured free work.
