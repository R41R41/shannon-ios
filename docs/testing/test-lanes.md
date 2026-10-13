# Test lanes

The server suite (422 vitest files, about 5,300 tests, plus six typechecks) is too slow to run in full on every change on an
8 GB Mac or on the 2-core production VM. It runs in three lanes. Each lane has one job, and no lane needs a secret or the network.

| Lane | Where | What runs | Typical time |
| --- | --- | --- | --- |
| Work | the Mac | `scripts/verify.sh fast`, the test files you touched, `scripts/verify.sh related <changed files>` | seconds to a minute |
| CI | GitHub Actions on the owner's PC (self-hosted runner in WSL2), every push | typechecks, `verify.sh fast`, every vitest file | a few minutes (to be measured on the PC) |
| Deploy | the VM, after the bundle is extracted | `scripts/deploy-check.mjs`: incremental typecheck, the deploy-critical tests, the tests related to the bundle's files | about 1–2 minutes |

## Work (the Mac)

- `scripts/verify.sh fast`: the harness, architecture, layer, code-shape, product-spec and env-example checks (about 10 s).
- The test files you changed: `node node_modules/vitest/vitest.mjs run services/api/tests/<name>.test.ts`.
- `scripts/verify.sh related <changed files>`: every test whose import graph reaches one of those files (`vitest related`).
  A change to a widely imported module (for example `autonomyCore.ts`) reaches 300+ files; leave those to CI.
- Typechecks are incremental: the tsconfig files keep their state in `node_modules/.cache/tsc/` (ignored by git). The first
  run is a full check; a repeat run rechecks only what changed (the API: about 9 s cold, under 2 s warm on the Mac), and still
  reports every error, also one caused in the API by a change in a package. The state is keyed by file content, not time,
  so extracting a bundle or switching branches does not invalidate it. Delete the folder to force a cold check.
- `scripts/verify.sh api` / `cognition-eval` still run the whole suite locally when that is really wanted. Check
  `pgrep -fl "node.*vitest"` first: two full runs at once do not fit in 8 GB.

## CI (GitHub Actions on a self-hosted runner)

`.github/workflows/api-tests.yml` runs on a push to any branch, unless every changed file is under `apps/` or `docs/`, and on
demand (Run workflow on the Actions tab). A newer push to the same branch cancels the older run.

It runs on one self-hosted runner, `shannon-wsl-pc`, in WSL2 Ubuntu 24.04 on the owner's Windows PC (labels `self-hosted,
linux, x64, shannon-wsl`). GitHub's hosted runners are not used: the repository is private and the account's Actions budget is
$0, so hosted minutes are blocked. Setup, keeping WSL alive, security and removal: [`../development/ci-self-hosted-runner.md`](../development/ci-self-hosted-runner.md).
While the PC is off or asleep a run waits in the queue (GitHub cancels a job after 24 hours of waiting).

- One job, `typecheck, fast lane and vitest`, with one install (shards on one runner would only run in turn and reinstall):
  `tsc --noEmit` for `services/api` and every `packages/*` (the incremental state is kept through `actions/cache`, optional),
  `scripts/verify.sh fast`, then `vitest run services packages --maxWorkers=4`. Every check step runs even when an earlier one
  failed. The worker count is the repository variable `SHANNON_CI_MAX_WORKERS` when set.
- On Linux the one macOS-only step, the icon footprint check that needs CoreGraphics, reports itself skipped; everything else
  runs as on the Mac.
- The temporary directory is the run's own folder on tmpfs (`/dev/shm`) when an executable can run there, else `/tmp`; it is
  removed after the run, also on failure or cancellation. `TZ` is pinned to UTC (the hosted runners' zone, where the suite was
  green); WSL would otherwise take the PC's Japan time. The open-file limit is raised to 65536 before vitest.
- Node 24.20 (production runs v24.20.0) from `actions/setup-node`, pnpm 11.19.0 through corepack from `packageManager`. The
  pnpm store stays on the runner's disk; the GitHub cache restores it only when it is empty, and every cache step is
  `continue-on-error`. Nothing of `apps/` is built: no Xcode, no Swift. Those lanes stay `scripts/verify.sh ios|app|mac` and
  Xcode Cloud.
- No secret is configured, and none is needed. The suite was run on 2026-10-12 with a guard on every socket, DNS lookup and
  `fetch`: no test file connected anywhere but the loopback address. A test that needs the network or a model key does not
  belong in this suite (the real-LLM evaluations are separate `*LiveEval.ts` scripts).
- Cost: a self-hosted runner uses no Actions minutes. (Until 2026-10 the suite ran on hosted runners in four shards, about
  10 billable minutes a run, until the free minutes ran out and the $0 budget blocked them.)

Reading the result: the Actions tab of `R41R41/shannon-ios`, or the check mark beside the commit or branch on GitHub. From a
terminal, `gh run list --branch <branch>` / `gh run watch` (GitHub CLI, signed in). The REST API answers for a private
repository only with a token (`curl -H "Authorization: Bearer <token>"
https://api.github.com/repos/R41R41/shannon-ios/commits/<sha>/check-runs`, a fine-grained token with read access to checks
and actions); `git ls-remote` shows refs, never check results.

## Deploy (the production VM)

A commit is deployed only when its CI run is green. After the bundle is extracted (and deleted files removed), on the VM:

```sh
N=/home/azureuser/shannon-ios-runtime/bin/node
cd /home/azureuser/shannon-ios
$N scripts/deploy-check.mjs --files-from /tmp/new-files.txt --files-from /tmp/modified-files.txt
```

It needs the VM's Node and the `node_modules` already there; no pnpm, git or network. It runs:

1. `tsc --noEmit` for `services/api` and each package that changed or depends on one that changed (incremental).
2. vitest with two workers on the fixed deploy-critical set (schema steps, entry closures, request goldens, switches and
   switched-off goldens, own-time privacy, ops, every `stabilization*` file, action-lease equivalence: 22 files) plus the
   files `vitest related` finds for the named paths. When more than 40 related files are found, only those named after a
   changed file run, and the script prints how many it left to CI; `--all-related` runs them all.

`--dry-run` prints the plan. `scripts/verify.sh deploy …` is the same command on a machine with the repository layout.
The VM has two cores, and vitest's default there is one worker; pass `--maxWorkers=2` when the full suite must still run on
the VM.

## Measurements (2026-10-12)

| What | Mac (6 cores, 8 GB) |
| --- | --- |
| Full suite, default workers (5) | 124 s; collect 198 s and tests 308 s summed over workers |
| Full suite, `--no-isolate` | 81 s, but 23 tests in 10 files fail (shared module state): not used |
| One shard of four, 2 workers | 48 s (106 files) |
| Deploy-critical set alone, 2 workers | 31 s (22 files; `actionLeaseEquivalence` alone takes 26 s) |
| `deploy-check.mjs` on commit 0109fc60's 18 files | 51 s (62 test files, warm typecheck 2 s) |
| `vitest related` discovery (no test run) | 3 s |
| Six typechecks, cold / warm | 10.8 s / 3.6 s |
