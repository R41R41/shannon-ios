# Shannon development instructions

This repository contains the current Shannon iOS app, its API, background workers, and the Mac Agent Host used for user-directed self-improvement.

## Instruction authority

For every task, use this order when sources disagree:

1. The user's current request.
2. This file.
3. `README.md` for the canonical-document index and product policy.
4. `docs/architecture.md` and `docs/DESIGN.md` for the current implemented system and UI contract.
5. `docs/self-improvement-runbook.md` and `docs/BRANCHING.md` for verification, deployment, and worktree lifecycle.

HTML files under `docs/archive/` are design history and operational evidence. They are useful context, but they are not current implementation authority unless the user explicitly names one.

## Product invariants

- Keep the internal product, target, and scheme names as `ShannonApp` / `ShannonDesk`; the user-facing app and character display name is `シャノン`.
- Ordinary chat must not wait for emotion updates, memory extraction, sleep consolidation, web exploration, push delivery, or self-improvement work.
- v1 uses a fixed LLM. Personality, emotion, interests, user knowledge, recalled memories, and current task state are prompt/shared-state inputs. Do not introduce per-user fine-tuning or prediction-error training.
- Shannon's persona, the suite role dictionary, and the description of what she can and cannot do have one source: `packages/cognition/src/persona.ts` and `capabilities.ts`. Do not restate them in a path-specific prompt. A change that adds or removes an ability updates `capabilities.ts` and `services/api/tests/shannonCapabilityEvidence.test.ts` in the same change. Fixed sentences spoken as Shannon use that voice (`ボク`, `ライ氏`, です・ます); status and error text stays neutral.
- Aether data enters Shannon only through the bounded projection. Shannon writes suggestions to Aether's proposal inbox; it does not silently rewrite Aether.
- Bounded autonomy (Syzygy ADR-0002). Shannon may propose a change from background activity, including a change to herself; applying one happens only after the owner approves it.
  - Core needs the owner's approval: purpose, base prompt and persona, emotion source, authentication, memory storage and forgetting, the approval and budget guard, the activity record, the response path, and deployment. `services/api/src/autonomyCore.ts` maps these areas to paths. The same applies to Aether and Voyager app code, the owner's documents and tasks, and anything that reaches a person other than the owner (sending, posting, publishing).
  - Free without approval, and nothing else: her own folder on the owner's Windows PC and Mac, her non-core code in the Azure VM workspace kept apart from the production service, her own study in Aether, and her own task list in Voyager.
  - Never: spending money beyond the daily model/API budget, contacting or publishing to others without approval, careless external access, impersonation, using private conversation content as-is in a work, changing core without approval, and self-replication (copying her code, memory, persona, or process to run elsewhere, or starting additional instances of herself).
  - Every autonomous step calls `authorizeAutonomousAction` first, and every decision and action is appended to the activity record, which nothing she can edit may rewrite or delete. The owner's stop switch and the daily budget are checked by that gate.
  - Her activity runs in its own leased process (`services/api/src/autonomyLoop.ts`, entry `autonomyWorker.ts`), one small step at a time, and stays off unless `SHANNON_AUTONOMY_ENABLED=true`, the owner has not paused her, and a dedicated model credential is set. Never give it the conversation keys, a second runner, or a way to start processes. Its prompts are built only from her pursuits, her study, public reading, allowed Notion reading, and reader feedback; never pass a conversation, the profile, a person memory, or private knowledge into `autonomyLoopPrompts.ts`. A new step kind needs a bounded executor, a domain the gate knows, and tests for the guarantees in `autonomyLoop.test.ts` and `autonomyLoopPrivacy.test.ts`.
  - Her study (`studyStore.ts`) is her own text: owner routes read it, add a reaction, or ask her to put a piece away, and never edit it. A story she has not called 「見せてもいい」 is shown to the owner without title or text.
- `agent_tasks` and their event stream are the durable authority for task status. Chat summaries are projections, not the source of truth.
- Preserve conversation history, memory, device pairing, Keychain credentials, and the production SQLite database across updates.

## Repository map

- `Shannon.xcworkspace`: sole interactive Xcode entry point for both Apple apps and their shared local package graph.
- `apps/ios`: Swift package containing Shannon's SwiftUI screens, models, local cache, and tests.
- `apps/ios-app`: signed iOS application shell and Xcode project.
- `services/api`: HTTPS API, SQLite persistence, workers, Agent Host bridge, Aether projection, and tests.
- `packages/cognition`: pure prompt/state transitions without database, timer, or network ownership.
- `deploy/azure`: production service templates.
- `deploy/macos`: Mac Agent Host launch configuration.
- `docs/architecture.md`: concise current architecture.
- `docs/DESIGN.md`: current design authority, evidence map, and screen-contract entrypoint.
- `docs/BRANCHING.md`: branch/worktree lifecycle and release-branch safety.
- `docs/self-improvement-runbook.md`: definition of done and recovery steps.

## Data ownership

- Azure SQLite is the durable source of truth for conversations, knowledge, memories, background activity, and agent tasks.
- The iOS conversation cache is an offline/display cache and must reconcile with the server without erasing newer local entries.
- Database changes must be additive and restart-safe. Back up the production database before a migration and verify row counts or health afterward.
- Secrets belong in ignored `.env` files, the Azure environment file, launchd environment, or iOS Keychain. Never copy secret values into source, logs, tests, prompts, or documentation.
- Cross-app payloads use versioned contracts and deterministic fixtures. If a change requires Aether, Voyager, or shared Syzygy ownership, do not silently edit a sibling repository: preserve compatibility, identify the owning contract, and return the decision to the coordinating task.

## Working method

1. Inspect `git status` before editing. The worktree may contain valuable unfinished user changes; preserve unrelated work.
2. Resolve the requested surface to its owning layer, then read the relevant current source and tests.
3. Implement a coherent vertical slice. Do not report a partial UI or a compile-only result as complete.
4. Run `scripts/verify.sh fast` during work, the narrowest useful target next, then `scripts/verify.sh all` for cross-layer work.
5. Open only `Shannon.xcworkspace` in Xcode. Never open the iOS and Mac `.xcodeproj` files in separate Xcode windows; both consume the same local `ShannonAppCore` package.
6. If the user requests Azure or physical-device delivery, follow the runbook and complete that delivery. Do not uninstall the app as part of an update.
7. If an external prerequisite is unavailable, leave the durable task state accurate and name the exact remaining step.

## Verification commands

```sh
scripts/verify.sh fast
scripts/verify.sh api
scripts/verify.sh ios
scripts/verify.sh app
scripts/verify.sh all
```

Use the real-LLM evaluations only when a change affects extraction, proposal decisions, or model behavior and credentials are deliberately available. Normal regression tests must remain deterministic and free of billable calls.
