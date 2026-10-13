# Skill import, common FCA tools and search

Implementation: `codex/shannon/skill-import-shared-tools`, based on `b85625ad`. This document describes the candidate source, not a production acceptance or live game trial.

## Operator-authored procedures

The app bundles the ten validated `standard10/draft-2` procedures under `services/api/artifacts/skill-packs/`. Loading the server does not import them. Owner-paired POST routes at `/v1/autonomy/skills/import/dry-run` and `/apply` select an app-owned pack ID/revision; caller text never becomes a filesystem path. Apply requires the exact reviewed plan hash and a closed approval reference. Dry-run returns bodies, lint, declared tools, conditional tools, capacity and conflicts without writes. A missing disclosure check or tool validator fails closed.

Imports record `operator_authored`, source author/reference/revision, validator revision, exact artifact SHA-256 and immutable receipt ID. Every revision retains ancestry. An import starts on trial, with zero uses and zero successes; it is not sleep-generated knowledge or evidence of a successful action. Sources use an `import:` receipt reference, separate from experience IDs. Only declared existing tools are validated. Conditional FCA controls and Minecraft observations remain conditional and grant no runtime authority.

The complete pack, audits and receipt commit atomically. The result is returned only after SQLite COMMIT succeeds. Same-content retries reconcile the immutable receipt even after editing/pinning/retirement. Name conflicts, capacity, pinned skills, owner versions and other trials are never overwritten. A changed plan must be reviewed again. Forgetting, withdrawn copies, unsafe bodies and revoked source ancestry still block use and historical reads.

The CLI uses owner-device authentication, not direct SQLite writes:

```sh
node node_modules/tsx/dist/cli.mjs services/api/scripts/skill-import.ts dry-run \
  --url https://sh4nnon.com --token-file /private/path/owner-device-token \
  --pack standard10 --revision draft-2
node node_modules/tsx/dist/cli.mjs services/api/scripts/skill-import.ts apply \
  --url https://sh4nnon.com --token-file /private/path/owner-device-token \
  --pack standard10 --revision draft-2 --plan-hash REVIEWED_PLAN_HASH \
  --approval-reference owner-request-reference
```

The token file must remain private. HTTPS or local loopback is required. A client timeout is not proof of failed import: retry the same pack/plan and read its receipt.

## Common FCA execution

Admitted `owner_request` tasks inherit only the existing conversational tool authority. The registry/gate/executor is reused for skill reading, study, dedicated folders, Aether, Notion, Voyager, schedule, places and Web when those ports are configured and offered. Task and memory tools retain their dedicated common bindings; Minecraft uses the current body catalog. VM workspace and own-time-only owner-document tools are excluded. Autonomous roots remain on the existing own-time path: this change does not turn them into owner requests.

Skill names/descriptions are dynamic context; the provider's cached tools/system prefix stays stable. `skill.read` returns a revision ID and provenance. Index metadata and opened bodies pin exact revision sources under the original execution segment before release to the model. Child tasks inherit source lineage. Source/body withdrawal, correction, owner presence and current offers are checked again around awaited calls and before later use.

The original segment owns effects and completion. An uncertain paid request or handed-out write does not become a new retryable action, and stopping it does not falsely acknowledge physical completion. The common adapter keeps the existing file compare-and-swap protection across segments. Successful results retain the original executor receipt and source identities.

## Search controls and limits

Simple query-only calls still work. No new model call is required for local filtering.

| Tool | Advanced controls | Coverage and evidence |
| --- | --- | --- |
| `memory.search` | phrase/all/any, experience/thread/knowledge, after/before, newest/oldest/relevance, limit and offset | Bounded 1,200 indexed candidates plus bounded local scalar recall; final paging after disclosure/forgetting. Returns source IDs, recorded time, evidence and applicability. Advanced responses explicitly say bounded coverage; not a total hit count. |
| `study.search` | title/body/both, note/story, status, phrase/all/any, after/before, newest/oldest, limit and offset; optional trash | Literal matching, versions retained. Informed matches retain their read receipts and mark the session; listing suppression is not a read denial; default relevance retains newest-first order. Results include IDs/version and excerpts; `study.read` reads full bodies/versions. |
| `schedule.upcoming` | title/location words, calendar/promise/task, future time window, limit/offset; existing day/week | Received snapshots only, at most 31 days ahead. Snapshot age uses the current observation time, separately from the requested date. Voyager snapshots cover eight days and expire after six hours. Returns exact source subjects and coverage limits. |
| `aether.search/read` | all/shannonFolder/study scope, multi-word section search, limit, heading section or offset/maxChars read | Existing provider contract, section IDs/version/heading/excerpts and paged reads. No invented provider-side date filters/pagination. |
| `folder.list/search/read` | host, root-relative subfolder, recursive listing, filename/content search, line excerpts, offset reads | Existing paired host protocol and bounded search. A truncated search does not mean no other matches. Dedicated-folder path confinement and read-before-write digest checks remain. |
| Notion/Voyager | existing title/phrase search | Current connected provider projections; no invented whole-account full-text coverage. |

Dates must be valid ISO instants with an explicit timezone. `after` is inclusive and `before` exclusive. Multi-word literal modes accept at most 16 distinct words; excess terms fail rather than silently disappear. Query text is never interpreted as SQL or a regular expression. Refining a query changes its result set; page offsets should be used with unchanged filters and sort order.

Historical Stage2/3 byte proofs retain their original goldens. Explicit test-only profiles pin the intentional schema additions and the known empty/null import schema changes; unexpected receipts, provenance or operator rows are not hidden. Current native schema, transaction and cache tests verify the candidate behavior.

## Generic capability extensions

The common runtime offers `goal.set_conditions`, `goal.verify` and `task.replan` through its FCA catalog. The same mechanism works for Minecraft observations, document versions/content and retrieved research sources. Conditions use a free read-only offered tool (named in either the registry form or the provider form the model sees, e.g. `mc_goal-evidence`, and stored in the registry form; a refusal names the failing condition and lists the free reads), JSON field path and `eq`, `gte`, `contains` or `exists` predicate; verification obtains fresh observations through the original executor, audience/source checks and original segment lease. The checkpoint keeps predicate outcomes, original operation IDs and observation digests together with the committed native round.

Model-suggested conditions remain suggestions: passing them cannot turn the original requested goal into a verified success. A code-owned request/domain binding supplies the authoritative predicates and binding ID. Completion freshly checks that binding; unmet predicates continue the task with an honest pending summary, and five rejected completion proposals pause it. Without a trusted binding, legacy completion remains available and is explicitly recorded as `self_reported`. Tests use a native dragon event, an exact document version and a canonical retrieved source; absent real native boss evidence is not proof of a kill.

`task.replan` records at most three changed approaches, each tied to an actual acknowledged tool failure operation. Unknown outside writes or paid outcomes still throw and retain their original unresolved segment. They never become failure receipts or a new retry permission. At most eight predicates, 16 recent failure receipts and three plans are kept. Internal planning tools cannot erase the existing repeated-tool-failure streak.

`createFcaObservationMonitor` is a common source-pinning, generation-fencing lifecycle. Domains supply bounded observations and explicitly name operations with known cancellation semantics. The common Task Hub adapter polls canonical pending-message IDs and source-visible child phases independently while inference awaits. Changed input fences a stale decision before another action; it never locally cancels an uncertain outside write. The existing model/body/task leases and stop owner remain authoritative, and all monitors drain before the segment receipt is committed. Observation payloads are bounded to 32,000 characters and 5,000 source IDs, with polling between 250 ms and 30 seconds. Minecraft retains its existing physical monitor and reflex cancellation acknowledgements.

Shared memory/search/recall now returns per-item canonical provenance (`kind`, `sourceIds`, `readSourceIds`) through the existing memory writer and disclosure/forgetting checks. No separate learned JSON store or second memory writer is introduced. Forgotten original episodes and withdrawn read sources still withhold derived experience at use time.

These are implemented generic mechanisms, not claims of native Minecraft campaign parity. Minecraft's old native campaign graph, survival tactics, combat statistics and place-memory persistence still need actual domain adapters and live comparisons. The candidate now binds exact original dragon requests to native per-task attack/death evidence via `mc.goal-evidence`; other goals retain the explicit self-reported distinction. Deterministic local fixtures establish verification, fresh reads, bounded replanning, SQLite checkpoint authority, late inbox fencing and provenance. Live combat success, paid-model latency/cost and production acceptance remain unmeasured.

## Lifecycle and verification integration

The [lifecycle procedure and contract](minecraft-lifecycle-contract.md) add a separate `minecraft-lifecycle/draft-1` artifact without changing the reviewed standard10 bytes. The registered tool catalog now has 46 definitions; dynamic body tools and FCA progress controls remain separate. Tools need an available fresh operator and the live gate, not merely a bundled procedure. No artifact is automatically imported.

Final trusted goal checks drain the physical body monitor before native reads and recheck its original revision; changed state defers completion. Task inbox observations continue. Explicit `goal.verify` keeps the body's scoped interruption signals and retains unknown outside failures. Memory provenance traversal shares the current read's canonical-row cache only; fresh use still rechecks disclosure, forgotten sources and provider availability.

Late original lifecycle acknowledgements can release only the original dynamic Minecraft-body resource through the mind worker's immutable resource receipt. Unknown task status, held budgets and other resources remain intact. The action writer rechecks native proof inside its transaction, and body command admission rechecks ownership inside its own write transaction; physical cleanup cannot race resource release.

Local validation and reviewed source hashes are in [the candidate verification receipt](generic-fca-lifecycle-local-verification.json). Production and signed device acceptance are not inferred from these results.
