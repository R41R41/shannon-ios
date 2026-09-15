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

The Mac launchd label is `com.shannon.agent-host`; the staged Azure unit is `shannon-agent-host.service`. After changing Agent Host or bridge code:

1. Run API verification.
2. Restart the launch agent.
3. Confirm the intended host is running and the task is routed only to its exact host ID.
4. Confirm its authenticated heartbeat reaches Azure.
5. For lifecycle changes, start a harmless task and verify start, progress, reconnect, and completion events.

The Agent Host must launch Codex only inside an allowlisted project. Its saved state contains task, Codex thread, turn, and pending-approval checkpoint identifiers used for reattachment after restart. A cloud host must use a dedicated writable checkout, never the live API deployment directory.

For cloud TestFlight delivery, work on `shannon/task-<task-id>`. Do not integrate or push `main` until tests pass and the user explicitly requested delivery. The push/integration operation needs a fresh approval at execution time. Xcode Cloud, not Azure Linux, performs the iOS build and signing.

An approval belongs to the live Codex connection that requested it. If the Agent Host restarts while waiting for approval, never infer that the old request was accepted and never leave Azure in `waiting_approval`. Discard the expired request, preserve the Shannon task goal, continue from the same working tree in a clean Codex thread, publish a `started` recovery event so Azure clears the stale approval, and ask for a fresh approval only if the remaining operation still requires it. A clean thread is intentional: the expired request can leave an unmatched tool call in the old Codex history.

If a saved turn is no longer active after restart, resume the same Codex thread automatically and inspect the working tree before continuing. Do not create a duplicate task or repeat changes that are already present.

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
5. Restart only affected services: `shannon-ios.service`, `shannon-ios-worker.service`, and/or `shannon-ios-world.service`.
6. Verify health, logs, database access, and preserved conversation/task counts.

Recovery means restoring the backed-up database and the previous source files, then restarting the same affected services.

## Physical iPhone delivery

1. Discover the currently connected device; do not assume a stale identifier.
2. Build with the configured signing team and bundle identifier `com.r41r41.shannon`.
3. Install over the existing app. Do not uninstall it, because that can remove local cache and Keychain state.
4. Launch the installed bundle.
5. Check conversation restoration, pairing, the changed flow, and one adjacent flow.

## Shannon Release Runner

`scripts/release-runner.sh` is the single local entry point for routine Xcode Cloud/TestFlight delivery. It reuses the Azure TestFlight distributor; it does not create a second build-assignment system. The shell entry point locates the same bundled Node.js fallback as the repository verifier.

1. `inspect` confirms `R41R41/shannon-ios`, `main`, the exact HEAD, staged-change safety, and visible uncommitted paths.
2. `prepare` runs the deterministic API/iOS/app checks plus an unsigned iPhone Release build.
3. `publish` requires both the exact prepared HEAD and `--confirm-external-release`. Use that flag only after a fresh user approval. It skips an already-pushed commit and never force-pushes.
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
