# Shannon implementation plan

Revision: 2026-09-28
Status: current roadmap

## Goal

Shannon is the conversation-first upper interface for user-directed Codex work.
The iPhone and Mac clients let the user request, follow, steer, approve, review,
verify, and release development work without writing code. The local Mac remains
the preferred execution host, with the isolated Azure host as an explicit fallback.

Ordinary conversation, Gemini realtime voice, memory, background activity,
Aether and Voyager integration, and development work keep their existing ownership,
privacy, and cost boundaries.

## Status language

- **Implemented**: source, deterministic tests, and applicable unsigned builds pass.
- **Deployed**: the reviewed server or host source is running in its intended environment.
- **Distributed**: the Apple build passed Archive, Upload, Processing, and Assignment.
- **Accepted**: Install and the product-specific physical-device Smoke also pass.

These terms are not interchangeable.

## Current snapshot

| Area | Current state | Remaining acceptance |
| --- | --- | --- |
| Architecture | Production files are responsibility-owned and remain under the 500-line ceiling. The iPhone voice/photo flow, Waterlight renderer, and Mac development state are split into focused files. | Keep the architecture guard green as features change. |
| iPhone Talk and Work | Apple-native conversation navigation, thread search/list, task control, review, release status, attachments, and artifacts are implemented. | Install the newest TestFlight candidate and run physical-device Talk, Work, persistence, Light/Dark, Dynamic Type, and Reduce Motion Smoke. |
| Mac Shannon Desk | Talk, Work, Development, repository/model selection, review, command/build output, attachments, and artifacts are implemented. | Run the current signed build on the target Mac and complete the same state-preservation and accessibility Smoke. |
| Voice | Gemini-only realtime voice, provenance-preserving turn assembly, registered vocabulary normalization, Jev-first multi-skill routing, latency-aware waiting speech, sentence/TTS overlap, separate display/speech rendering, stage telemetry, same-session text, interruption recovery, photo/camera sharing, and guest mode are implemented. Voice proposals use the same visible review boundary as text. | Run the opt-in 21-case live Jev evaluation where `TYPESAFE_API_KEY` is available, then verify stage timings, Japanese speech, interruption/recovery, route changes, one confirmed image share, and history preservation on the physical iPhone. |
| Cognition | Deterministic evaluation, hardened recovery UI, and a durable rich-emotion state are implemented. Jev supplies provisional emotion/delivery for the first spoken segment; the completed reply reconciles primary and secondary emotion, intensity, target, cause, arousal, valence, visibility, decay, carryover, and safety overrides. | Treat holdouts, negative controls, Shannon-to-Codex end-to-end evaluation, and skill-promotion gates as future evaluation work, not release blockers. |
| Conversation orchestration | Owner text and voice maintain one thread-scoped pending action with additions, corrections, interruption/resume identity, approval scope, source references, and verified agent-task receipts. Spoken steer, pause, resume, and cancel commands act only on one unambiguous current task and remain idempotent. | Exercise proposal → addition/correction → start → steer/pause/resume/cancel on the physical client; ambiguous multi-task and approval states must keep failing closed. |
| Apple delivery | iOS Build 79 is distributed to Shannon Internal. The commits after Build 79 are locally verified and will be carried by the next candidate. | Complete Archive, Upload, Processing, Assignment, Install, and Smoke for the exact next commit/build pair. |
| Cross-app integration | Existing bounded Aether/Voyager review and organization flows are preserved. | Re-run one harmless Voyager organization flow and one Aether read-only flow during acceptance. |

## Current release work

1. Verify and commit the conversation-v2 emotion and orchestration phase without changing existing approval boundaries.
2. Push the exact reviewed `main` commit and publish the next iOS candidate through
   the release runner.
3. Record the exact commit/build identity and all seven gates in Shannon's owned
   status file.
4. Install from TestFlight on the owner's iPhone and perform the focused Smoke
   described above. Install and physical-device Smoke require the owner's device.
5. Run the current Mac build and complete its physical-device Smoke.

## Product acceptance scenarios

These are durable acceptance scenarios rather than unfinished implementation:

1. **Local Shannon task** — make a harmless documented change, inspect progress,
   steer it, review the diff/tests, and complete or cancel deliberately.
2. **Cross-app task** — run a read-only Aether/Voyager audit and prove the canonical
   repositories are used.
3. **Approval task** — reject once, request again, approve once, and verify stale
   approval cannot be reused.
4. **Recovery** — background the iPhone, reopen on Mac, restart the selected host,
   and verify the same task resumes without duplication.
5. **Cloud fallback** — deliberately make Local unavailable, select Cloud, run a
   harmless task, and restore Local. Explicit Local selection must fail visibly.
6. **Repository provisioning** — add one explicitly selected HTTPS GitHub repository
   and confirm host-owned paths do not alter existing user checkouts.
7. **Release request** — request an iOS release from Shannon and verify the exact
   commit/build identity plus all seven gates.

## Review-fidelity roadmap

The following are product improvements, not defects in the current release:

1. Explicit branch, commit, push, pull-request, and integration proposals with
   operation-time approval and exact target identity.
2. Build artifacts, logs, and release evidence linked to the durable task.
3. Better task comparison and retrieval across project, host, branch, state, and
   date while preserving one authoritative event stream.
4. Broader VoiceOver, keyboard/focus, Dynamic Type, Reduce Transparency, Increase
   Contrast, offline, conflict, and permission-state visual evidence.
5. A decision on whether a Mac Xcode Cloud workflow should replace the remaining
   user-operated Archive/App Store Connect path.

## Explicitly deferred

The following are future product ideas and are not missing release work:

- background voice activation;
- continuous camera/live-world conversation and person recognition;
- Live2D runtime and animated widgets;
- applying a source-code change without the owner's approval (Shannon may propose one; Syzygy ADR-0002);
- per-user fine-tuning or prediction-error training.

They require separate privacy, battery, permission, cost, and interaction-design
decisions before implementation.

## Completion definition

The current maintenance/release task is complete when the reviewed commit is on
`origin/main`, the next iOS candidate reaches Shannon Internal, repository and
status records contain no falsely active superseded work, and all checks that do
not require the owner's physical devices pass. Install and physical-device Smoke
remain explicitly pending until the owner performs them; they must never be
reported as passed from build or simulator evidence alone.
