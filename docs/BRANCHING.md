# Shannon branch and worktree lifecycle

Policy: `SYZYGY-BRANCH-001`

Revision: 2026-10-07

## Baseline and naming

- The registered canonical repository is the `shannon-ios` checkout; another old Shannon tree is not a product or release authority unless the user explicitly selects it.
- `main` is the accepted reproducible baseline. Release work starts only from a clean `main` whose intended commit matches `origin/main`.
- New independent outcomes use `codex/shannon/<work-id>`. Existing branch names remain valid until their current work is integrated or retired.
- Parallel work uses a worktree of the canonical repository, not another standalone clone.

## Lifecycle

1. Inspect `git status`, `git worktree list`, `main`, `origin/main`, and existing owner branches without changing them.
2. Reuse the worktree that owns the outcome, or create one branch/worktree from the latest accepted baseline.
3. Preserve unrelated dirty files and record any exclusive Apple, device, port, signing, or production resource before use.
4. Keep one coherent outcome per branch and use separate commits for unrelated harness or product changes.
5. Run `scripts/verify.sh fast` during work and the complete relevant gate before integration.
6. Integrate without force-pushing accepted history. Release only from a clean, current `main` and follow `docs/self-improvement-runbook.md`.
7. After integration, update Shannon's registered app status and remove a worktree/local branch only after its path and recoverable commit are recorded.

## Audit classifications

Every non-main branch or worktree is one of:

- `active`: a current task owns it.
- `waiting`: valid work has a named next action or user dependency.
- `integrated`: accepted `main` contains it and it is eligible for deliberate cleanup.
- `abandoned`: it will not be integrated, with a recorded reason and recoverable commit.
- `unknown`: ownership or outcome is unclear; do not delete it until audited.

Prunable or detached entries are never deleted merely because Git labels them stale. Audit containment, dirty files, owner, and exact commit first.

## Replay, then rebase or merge: the code-layout waves

The API sources move into folders in six waves (Syzygy ADR-0008 §6, `docs/architecture.md` "Code layout (target)"). A wave renames many files at once, and a branch that predates it would meet modify/delete conflicts and imports of paths that no longer exist. A branch that is older than a wave on `main` therefore replays the script on its own tip before it takes `main`:

1. Commit or stash the branch's work; `scripts/layout/apply.mjs` refuses a tree with uncommitted changes.
2. Look at which waves `main` has: `git log --oneline origin/main -- scripts/layout/moves.json services/api/src` names each wave commit ("Layout wave N: …").
3. On the branch tip, take `scripts/layout/` from `main` if the branch does not have it (`git checkout origin/main -- scripts/layout`), and commit that alone.
4. Replay the waves `main` has: `node scripts/layout/apply.mjs --through N` (or `--wave N` for one). It moves the branch's copies of the files, rewrites the branch's own new imports and tests, and updates its `autonomyCore.ts`; a file the branch added and `moves.json` does not list stays where it is. Commit the result as "Replay layout waves 1–N".
5. Then take `main`: merging `origin/main` is the simplest, since both sides now made the same renames and the same rewrites, so only real edits conflict. A branch that must stay linear rebases instead (`git rebase origin/main`): git follows its older commits across the renames by rename detection, and the replay commit keeps only the rewrites of the branch's own files. `autonomyCore.ts` changes too much in a wave for rename detection: if the branch edited it, take `main`'s version and re-apply the branch's own lines.
6. Run `node scripts/check-api-layers.mjs` and move any new file of the branch into its folder (add it to `moves.json` when it belongs to a later wave), then the usual gates.

The script is idempotent: a wave already applied moves nothing and rewrites nothing, so replaying it twice is harmless. A wave that would change the set of core files fails before it touches the disk.
