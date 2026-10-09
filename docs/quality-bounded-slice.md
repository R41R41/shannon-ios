# Quality improvements: bounded implementation

Implementation candidate, 2026-10-09. Scope approved for at most two hours: Q00, a narrow Q02/Q07, Q03, Q01 and Q05. Q04 voice lifecycle and Q06 embodiment projections are excluded. This is not a claim that the entire audit blueprint is implemented. Production, main push and client distribution are separate work.

## Result evidence (Q02/Q07)

Executors project their existing outcomes into optional `ToolExecutionEvidence`: queued, applied, failed or unknown, action and target, and canonical IDs/revision only when the original port supplies them. No new receipt database or success authority is created. Host folder operations expose no operation ID; the projection does not invent one. Aether document versions/proposal IDs, Minecraft request IDs and lifecycle receipts retain their original authorities.

The model receives this evidence in its tool-result round **before final generation**, through the existing `SHANNON_TURN_VERIFY`/stage-2 switch. OFF keeps old tool-result bytes. Queued Minecraft work is not goal completion; proposal admission is not document modification; a server-start receipt is not a mining/dragon result. The deterministic verifier additionally checks supported action/domain and explicitly quoted target labels/IDs. Mixed successful/negated clauses are checked separately. `turnDoing` learns an applied outcome rather than queued/unknown as completion.

This is bounded coverage, not a complete proof of arbitrary natural-language claims or all tools. Untagged legacy tools retain their previous success rule. The post-generation correction still follows streamed text/audio; this change does not retract speech already emitted, buffer voice or redesign Q04.

## Temporal recall (Q03)

`SHANNON_TEMPORAL_KNOWLEDGE_RECALL=on` opts into a read-only projection of revisions of the **same Shannon-derived note** for explicit historical-change questions. Default OFF. The existing recall selects at most two notes; each adds at most two previous revisions and its current revision. `recordedAt` is storage time, not the underlying event time. Old text is superseded reference data, not a current user/external fact. Missing versions and the reason for change stay unknown.

Owner-alone live presence, disclosure, forgetting/correction, source existence and current note/state versions are checked before projection. Retired/withheld material is excluded. Historical source experience IDs are pinned alongside the note ID so existing generation-time forgetting checks and reply lineage cover old sources too. No writer, guessed person/entity association, new DB or model call is added. A general person/event timeline and broader FCA recall propagation are outside this slice.

## Open Voyager tasks (Q01)

See [the additive open-task contract](voyager-open-tasks-contract.md). Generic task questions and empty-query `voyager.tasks` read a bounded open-task list; specific keywords keep search. Due date, priority, revision, explicit truncation and source IDs survive projection. Empty, unconfigured, denied, timed-out and unsupported reads are distinguished. Rows remain complete JSON even with long escaped text.

Voyager branch `codex/voyager/quality-open-tasks`, commit `4968ee7afb5b2326509078adbabe34fce71fafe1`, provides the authenticated Syzygy 1.1 endpoint. Deploy that paired endpoint before expecting the production list to work. An older server gives unsupported, never a fake empty list.

## Fixed comparisons (Q00/Q05)

Use the existing Reach harness, not a new quality framework:

```sh
scripts/reach-measures.sh run --only quality.result.
scripts/reach-measures.sh run --only quality.affect.
```

These scenarios are model-free in scripted and live modes; no credentials or real user/game data are used. Reports include the existing scenario/fixture fingerprints, metrics and zero model calls.

Two result fixtures exercise actual `verifyWriteClaims`: queued Minecraft request versus goal completion, and file A's success versus file B's claim. The original verifier from base `037681a548136d3f7441774ac875f55a7af15bdd` fails both unsupported-claim checks; the candidate passes both, while preserving correctly scoped statements. This is a deterministic engineering comparison, not an LLM capability score. Before/after reports: `artifacts/reach/2026-10-09T13-07-02-347Z-037681a54813-scripted.json` and `2026-10-09T13-07-02-348Z-quality-boun-scripted.json`.

Six synthetic emotion histories cover repeated failure then success, a positive comment from another task, welcome/refusal touch appraisal, idle time, restart/duplicate and withheld cause. The real SQLite companion writer/AffectCoordinator is compared to existing pure `affectDynamics` functions with fixed learning rate 0.5, same initial emotion, IDs and clock. The comparator is RAM-only, **not the runtime PredictionShadow fold**. Reports include each observed state/time/current expressive kind, valence/arousal/openness differences, maximum valence step and receipt counts. Restart tests the committed companion only; touch tests the reducer with synthetic outcomes; privacy tests the coordinator visibility callback/public projection, not the whole source-disclosure pipeline.

All six pass boundedness, deterministic replay and their scenario-specific condition. Final report: `artifacts/reach/2026-10-09T13-08-41-677Z-037681a54813-scripted.json`. Current versus comparator differences are observations, not a score proving one more natural. Human naturalness, live speech/Live2D consistency, full personality continuity and runtime shadow persistence are unmeasured. No production emotion parameter or rule is changed.

## Verification and disposition

Focused boundary tests cover genuine executor/session evidence before generation, failed/wrong-target/mixed-result claims, secret/others gates, switched-off compatibility, historical source forgetting during generation, open-task authentication/error/truncation and emotion replay. API full run: 359 files / 4,414 tests; 4,405 passed initially. The nine failures were independent historical Voyager display wording, the additive Reach scenario estimate list, and the explicitly reviewed runtime-module allowlist. After fixing those expectations/profiles, all four affected files passed (24 tests). Stored OFF golden files were not regenerated: the existing historical profile pins only the former read-capability and Voyager display/schema wording while retaining real gates/model loops/executors. Native Q01 capability/registry tests use current wording and pass. Cognition/evaluation: 303 initially passed, two compactness failures caused by a global capability edit were resolved by moving the new wording to the offered read-tool line; those two files pass (27 tests). API/cognition/evaluation type checks, layer/500-line checks and fast harness pass. Candidate commit is recorded in the owning Shannon status and shared topic knowledge. No paid models, live Minecraft experiment, production configuration, push or release is part of this task.
