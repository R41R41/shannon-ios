# Shannon implementation plan

Revision: 2026-09-15
Status: current execution plan

## Goal

Shannon is the conversation-first upper interface for user-directed Codex work. The
iPhone and Mac clients must let the user request, follow, steer, approve, review,
verify, and release development work without writing code. The local Mac is the
preferred execution host. An isolated Azure host is the fallback when the Mac is
unavailable; it is not presented as part of the user's Codex subscription.

Ordinary conversation, realtime voice, memory, background activity, Aether and
Voyager integration, and development work keep their existing ownership and cost
boundaries.

## Status language

- **Implemented**: source, deterministic tests, and applicable unsigned builds pass.
- **Deployed**: the reviewed server or host source is running in its intended environment.
- **Distributed**: the Apple build passed Archive, Upload, Processing, and Assignment.
- **Accepted**: Install and the product-specific physical-device Smoke also pass.

These terms are not interchangeable.

## Current snapshot

| Area | Implemented | Deployed / distributed | Still required |
| --- | --- | --- | --- |
| Responsibility-oriented architecture | Complete; Swift and TypeScript production files are bounded and feature-owned | Accepted baseline before Build 50 was `a68bdf4`; Azure API and both Agent Hosts use that revision | Integrate the verified Build 50 candidate and keep architecture guards green |
| iPhone work management | Project/host/model/reasoning selection, safe start gating, visible recent progress, steering, pause/resume/cancel, approval, changes, tests, pin/archive/search | iOS 0.1.0 (49) is VALID, INTERNAL_ONLY, and assigned to Shannon Internal; the post-audit source/tests/build are green as Build 51 | Build 51 TestFlight distribution and physical-device Smoke |
| Mac development workspace | Native files, command history, change review, Git/branch, build panes, repository provisioning, responsive execution selectors, and truthful finished states | Post-audit local build and 19 tests pass as Mac Build 6 | Build 6 signed Archive, Upload, Processing, Assignment, Install, Smoke |
| Agent execution | Durable task/event/command state, restart recovery, local-first routing, explicit fixed-host behavior | Local and Cloud heartbeat; Aether, Shannon, and Voyager registered on both hosts | Harmless E2E on each host; background/restart recovery; approval E2E |
| Arbitrary GitHub repository | HTTPS repository validation, host-owned clone, idempotent provisioning, no credential in request | API and both hosts deployed | UI E2E using a disposable or explicitly selected repository |
| Release Center | Seven truthful gates and iPhone release request targets | Build 49 proves Xcode Cloud Archive through internal assignment | Build 50 Install/Smoke confirmation; Mac release path remains user-operated |
| WebRTC symbols | Current framework and dSYM UUID match; Cloud copy is sandbox-safe | Xcode Cloud Build 49 passed the symbol phase | Confirm no symbol warning on later local Mac/iOS uploads |
| Waterlight Eye | Empty-conversation iPhone hero, bounded reaction, semantic blush, Reduce Motion | Included in Build 49 | iPhone Light/Dark, repeated tap, interruption, Reduce Motion Smoke |
| Voice Identity | Marin/Cedar/Coral preview, selection, Azure persistence, iPhone/Mac sharing | API deployed and clients included in current builds | Physical-device preview, next-session application, cross-device sync Smoke |
| GPT-Live travel voice | Staged Live WebRTC engine, bounded read-only delegation, confirmed single camera snapshot, and Realtime rollback | Real Vision and Live session API smoke passed; production remains on Realtime during rollout | Deploy compatible server code, distribute Build 50, then enable Live and run physical-device audio/camera Smoke |
| Aether/Voyager organization | Existing bounded Shannon proxy and explicit review flow remain implemented | Existing production flow preserved | Re-run adjacent Smoke after Build 50 |
| Cross-app acceptance scenarios | Requirements are known | Not yet stored in Aether's current documentation | Aether-owned scenario document and links from its document index |
| State-based UI audit | High-priority iPhone Talk/Work and Mac Talk/Development remediations are implemented; screen contracts were reconciled on 2026-09-15 | Existing safe Mac evidence retained; source guards, iOS 132 tests, Mac 19 tests, and both app builds pass | Current-release visual evidence for empty/loading/error/offline/permission, Light/Dark, larger text and Reduce Motion |
| Shannon app icon | The approved L02/L06/L10 set is available on iPhone and Mac, with L06 as the primary/default/fallback and the display name `シャノン` | Asset catalog compilation, icon-selection tests, and platform builds pass | Select all three on device and verify Home Screen/Dock, Settings, notification, and Spotlight rendering |

## Priority 0 — finish the current release

1. Distribute iOS 0.1.0 (51) from Shannon Internal without removing the existing app, and select the new `シャノン` icon once.
2. Verify pairing, stored conversations, ordinary Talk, Realtime voice, Work,
   Release Center, Waterlight Eye, appearance, and one Voyager organization flow.
   After that baseline passes, enable Live on the server and verify natural audio,
   interruption, read-only delegation, one confirmed camera snapshot, and rollback.
3. Archive Mac 0.1.0 (6) with `ShannonDesk` and `Any Mac` / `Any Mac Device`.
4. Validate, upload to App Store Connect, wait for Processing, and assign to
   Shannon Internal.
5. Install from TestFlight and verify existing state plus Talk, Work, Development,
   repository selection, model selection, outline, attachments, and artifacts.

## Priority 1 — prove Codex replacement behavior

Run these as durable Shannon tasks, not direct database fixtures:

1. **Local Shannon task** — request a harmless documented change, choose
   `shannon-ios` and Local, inspect progress, send a follow-up, review the diff and
   tests, then complete or cancel deliberately.
2. **Local cross-app task** — repeat a read-only audit against Aether and Voyager,
   proving the registered canonical repositories are used.
3. **Approval task** — require a file or command approval, reject once, request
   again, approve once, and verify stale approval cannot be reused.
4. **Background recovery** — background the iPhone, reopen on Mac, restart the
   selected Agent Host, and verify the same task resumes without duplication.
5. **Cloud fallback** — with the Local Host deliberately unavailable, run a
   harmless Shannon task on Cloud, confirm the task branch and review evidence,
   and restore Local afterward. Explicit Local selection must fail visibly rather
   than fall back.
6. **Repository provisioning** — add one explicitly selected HTTPS GitHub
   repository through the Mac UI, verify host-owned paths on Local and Cloud, and
   ensure existing user checkouts remain untouched.
7. **Release request** — request an iOS release from Shannon, verify the exact
   commit/build identity, Xcode Cloud result, seven gates, and physical-device
   confirmation. External integration and distribution retain explicit approval.

Passing these scenarios is the threshold for saying that Shannon can replace the
normal Codex workflow for this user's development style.

## Priority 2 — strengthen review fidelity

The first development UI is usable but does not yet expose all of Codex's review
depth. Implement only the parts that improve a non-coding user's confidence:

1. Selected-file read-only preview with safe size and binary boundaries.
2. Full per-file diff navigation, not only bounded event previews.
3. Streaming command/build output with clear running, stopped, failed, and passed
   states; do not turn it into an unrestricted local shell.
4. Explicit branch, commit, push, pull-request, and integration proposals with
   operation-time approval and exact target identity.
5. Build artifacts, logs, and release evidence linked to the durable task.
6. Better task comparison and retrieval across project, host, branch, state, and
   date while preserving one authoritative event stream.

## Priority 3 — complete cross-app and experiential validation

1. Store the approved iPhone/Mac coding, Aether/Voyager integration, everyday
   conversation, web research, proactive-action, and camera/live-world scenarios
   in Aether's current document system.
2. Execute the scenarios that are already possible and mark unavailable steps as
   planned rather than simulated.
3. Capture privacy-safe current screenshots for the four screen contracts.
4. Audit VoiceOver, keyboard/focus, Dynamic Type, Reduce Motion, Reduce
   Transparency, Increase Contrast, offline, conflict, and permission states.
5. Decide whether a Mac Xcode Cloud workflow should remove the remaining manual
   Archive/ASC step. Linux Cloud Agent Host never signs Apple apps itself.

## Explicitly deferred

The following are product ideas, not missing release work:

- background voice activation;
- continuous camera/live-world conversation and person recognition;
- Live2D runtime and animated widgets;
- autonomous source-code rewriting;
- per-user fine-tuning or prediction-error training.

They require separate privacy, battery, permission, cost, and interaction design
decisions before implementation.

## Completion definition

Shannon reaches the current goal when:

- Build 50 and Mac Build 5 pass all seven Apple release gates;
- Priority 1 passes on physical iPhone and Mac with both Local and Cloud hosts;
- the user can understand changes, commands, tests, approvals, Git target, and
  release result without reading source code;
- existing conversation, memory, pairing, and cross-app data survive every update;
- the remaining review-fidelity gaps are either implemented or explicitly accepted
  as unnecessary by the user.
