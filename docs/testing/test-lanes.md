# Test lanes

The server suite (422 vitest files, about 5,300 tests, plus six typechecks) is too slow to run in full on every change on an
8 GB Mac or on the 2-core production VM. It runs in three lanes. Each lane has one job, and no lane needs a secret or the network.

| Lane | Where | What runs | Typical time |
| --- | --- | --- | --- |
| Work | the Mac | `scripts/verify.sh fast`, the test files you touched, `scripts/verify.sh related <changed files>` | seconds to a minute |
| CI | GitHub Actions, every push | typechecks, `verify.sh fast`, every vitest file in four shards | about 3–4 minutes wall clock |
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

## CI (GitHub Actions)

`.github/workflows/api-tests.yml` runs on a push to any branch, unless every changed file is under `apps/` or `docs/`, and on
demand (Run workflow on the Actions tab). A newer push to the same branch cancels the older run.

- `static`: `tsc --noEmit` for `services/api` and every `packages/*` (the incremental state is cached between runs), then
  `scripts/verify.sh fast`. On Linux the one macOS-only step, the icon footprint check that needs CoreGraphics, reports itself
  skipped; everything else runs as on the Mac.
- `tests` (four jobs): `vitest run services packages --shard=i/4 --maxWorkers=2`, with the temporary directory on tmpfs.
- Node 24.20 (production runs v24.20.0), pnpm 11.19.0 through corepack from `packageManager`, the pnpm store cached by the
  lockfile hash. Nothing of `apps/` is built: no Xcode, no Swift. Those lanes stay `scripts/verify.sh ios|app|mac` and Xcode Cloud.
- No secret is configured, and none is needed. The suite was run on 2026-10-12 with a guard on every socket, DNS lookup and
  `fetch`: no test file connected anywhere but the loopback address. A test that needs the network or a model key does not
  belong in this suite (the real-LLM evaluations are separate `*LiveEval.ts` scripts).
- The daily-use evals (`services/api/evals/daily/`, its README) put only their free half here: `tests/dailyEvals.test.ts`
  validates the task definitions and runs the harness over a scripted model with the network refused. Live trials need
  `SHANNON_EVALS_LIVE=1` and a model key and never run in CI.
- Budget: the repository is private, so minutes are billed (2,000 free a month), each job rounded up to a whole minute.
  A full run is five jobs of roughly two minutes, about 10 billable minutes. If the shards grow past two minutes each, three
  shards cost less than four.

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
