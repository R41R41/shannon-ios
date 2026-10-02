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
  - Never: spending money beyond the daily model/API budget, contacting or publishing to others without approval, careless external access, impersonation, writing what the owner asked to keep secret into a work or a note (by the owner's decision of 2026-10-02 her own stories and notes, which the owner reads, may be about him and the people he knows; showing a work to anyone else needs his approval), changing core without approval, and self-replication (copying her code, memory, persona, or process to run elsewhere, or starting additional instances of herself).
  - Every autonomous step calls `authorizeAutonomousAction` first, and every decision and action is appended to the activity record, which nothing she can edit may rewrite or delete. The owner's stop switch and the daily budget are checked by that gate.
  - Her activity runs in its own leased process (`services/api/src/autonomyLoop.ts`, entry `autonomyWorker.ts`), one small step at a time, and stays off unless `SHANNON_AUTONOMY_ENABLED=true`, the owner has not paused her, and a dedicated model credential is set. Never give it the conversation keys, a second runner, or a way to start processes. By the owner's decision of 2026-10-02 (Syzygy ADR-0003) she paces her own day: within the daily budget she runs in sessions at times of her choosing (`autonomyLoopPacing.ts`), each until she rests with `rest`, which says in how many minutes she comes back and why, in her own words, or until a bound stops it (what one session may spend, its wall clock, its steps, the sessions of a day, the shortest rest; `SHANNON_AUTONOMY_SESSION_*`), with the reason in her record either way. A session stands still while the owner is talking and goes on afterwards with the same plan. Every thinking step of a session ends with the facts of her budget as the server counted them. Work the owner calls her for (conversation, agent tasks, a look he asks for) is never charged to this budget. `SHANNON_AUTONOMY_PACING=cycles` restores the fixed cycles; together with `SHANNON_AUTONOMY_OWNER_CONTEXT=off` it restores the loop exactly as it was. Its prompts are built from her pursuits, her study, public reading, allowed Notion reading, and reader feedback, and, by the owner's decisions of 2026-10-02, from these things of the owner's: (1) her own note of what she saw through her body's camera (`study_pieces.origin = 'room_look'`), material for her thinking and her stories (while `SHANNON_AUTONOMY_OWNER_CONTEXT` is off, with the earlier rule line that it is never written into a story as seen); and (2) the owner's upcoming items, so that she can speak up about what is near: calendar events the apps share, promises and reminders she remembers that have a due time, and dated Voyager tasks when that integration is configured. Upcoming items reach her only through `upcomingForOwner` (`ownerUpcoming.ts`) as at most twelve lines of kind, title and time for the next 24 hours, only in the thinking prompt and in the prompt of a message about them, and only while she may speak up; and (3), by the owner's decision of 2026-10-02 (Syzygy ADR-0003, 「基本的に全部見ていい」), the owner's context: her thinking may draw on what a conversation with him alone draws on (what she knows about him, the recent talk between them, memories that fit what she is pursuing, people she remembers, today's focus), as one bounded block built on the spot by `autonomyOwnerContext.ts` through the conversation's own memory entry points (the disclosure gate, the replay under forgetting, the deterministic recall, people memory) and never copied into a store of the loop. What he asked her to forget is gone there as everywhere. What stays protected is what leaves her head, and `ownerPrivateRule` (`autonomyLoopOwnerContext.ts`) is the one place that says it: by his decision of the same day (「ボクのことを物語やメモに書いていい。友達のことも」) a story or a note may be about him and the people he knows, by name, as they are, and is given that block without what he asked to keep secret, what he marked 機微 by hand, and what was said with an unnamed guest present; what she writes is read by the owner, and showing it to anyone else still needs his approval; a message of hers is given the block with the same things left out, and with other people present keeps the speak-time check and the guarded markers; what she saw of the room she may write as she saw it, except other people who appeared and text on screens or documents; those secrets reach her thinking only, and free text of hers that repeats them (an idea, an aim, a pursuit, a note, a search, a reason for resting, the thought that goes into her record) is dropped; a thought made with his context in front of her reads only pages she was shown, never an address she makes up; folder copies stay limited to her own notes and the stories she called 「見せてもいい」. `SHANNON_AUTONOMY_OWNER_CONTEXT=off` gives her none of it and every prompt is what it was. The old rule "never pass private knowledge into the loop" is replaced by this list and these output rules. By the owner's decision of 2026-10-02 (act, observe, think again) a thinking step may also be given what her own steps led to, as closed facts and nothing freer (`autonomyLoopObservations.ts`, worded in `autonomyLoopObservePrompts.ts`): a step's kind, outcome and reason code; after a message of hers, whether the owner wrote or spoke afterwards in any Talk (a yes or no and a number of seconds, taken from timestamps, never what he said), what her body reported about showing that message (`shown_spoken`, `shown`, `away`, `hidden`, `muted`, or nothing), and what the server already knows of the body (her window showing, the owner away or back, others present). From such a thinking step she may call once more after an unanswered message (`follow_up`: one per message, `SHANNON_AUTONOMY_MAX_FOLLOW_UPS` a day, not counted among the three, never once he has written or spoken; by the owner's decision of 2026-10-02, ADR-0003, the prompt of that second call also receives the words of her own first message, read from her initiative, and nothing the owner said), look at the room, write a short note, or let it go; a cycle thinks again at most `SHANNON_AUTONOMY_CYCLE_MAX_RETHINKS` times and stays inside its step count. `SHANNON_AUTONOMY_MAX_FOLLOW_UPS=0` switches all of it off and every prompt is what it was. An observation stays facts whatever she may see elsewhere: what the owner said never enters `autonomyLoopObservePrompts.ts` or the observation table. The loop's process holds no conversation model key and no Voyager credential; it opens the conversation's stores only in `autonomyOwnerContextWiring.ts`, reads through them and writes nothing through them, and the loop modules are handed an interface, never a store. Apart from that, its process makes exactly one write to the companion state, in `autonomyAwakeClock.ts` (owner decision 2026-10-02): a step of her own is time she is awake, so the content-free reducer event `awake-observed` advances her emotional clock; that module opens no conversation store, writes back only the clock and what fades with it, and hands the loop nothing, so the loop receives no emotion. From her own activity she may write the owner up to three short messages an owner-local day (`reach_out`, `SHANNON_AUTONOMY_MAX_REACH_OUTS`), not while a conversation is in progress; with other people present the message is still sent and its prompt carries the speak-time privacy check and guarded markers. A new step kind needs a bounded executor, a domain the gate knows, and tests for the guarantees in `autonomyLoop.test.ts`, `autonomyLoopSessions.test.ts` and `autonomyLoopPrivacy.test.ts`; a prompt that is given owner-private material, or text that may come from it, carries the line of `ownerPrivateRule`.
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
