# Shannon branch and worktree lifecycle

Policy: `SYZYGY-BRANCH-001`

Revision: 2026-09-12

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
