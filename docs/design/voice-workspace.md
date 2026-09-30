# Voice workspace

## Implementation contract

Shannon iPhone: ask for implementation by voice, review the proposed work, start it
with the existing host/project/approval controls, and inspect other screens without
ending the conversation. This is a functional layout update, not a new visual identity.

| Preserve | Change | Do not change |
| --- | --- | --- |
| Continuous recognition, streaming speech, barge-in, unfinished input, guest isolation, character eye, labeled controls | Separate call lifetime from its presentation; show a persistent call strip and a direct work-review link | Server authority, task approval/start settings, background microphone privacy, unrelated screens |

Primary action: continue speaking or send text. Strongest secondary action: review
the implementation proposal. Minimize and end are separate, explicitly labeled
actions. Navigation never restarts a call. The call's thread is pinned independently
of the browsed thread. Camera sharing and history use that same pinned thread.

States: connecting, listening, thinking, speaking, failed/offline with reconnect,
permission denied, guest, proposed work, running/waiting-approval work, and no work.
The compact strip carries a textual phase, participant/privacy label, details action,
and explicit end action; work proposals remain provisional, not “in progress”.

Native safe-area layout, semantic palette and material, 44-point controls, multiline
text, stacked accessibility layouts, VoiceOver labels, no additional decorative
motion. Increase Contrast and Reduce Transparency use an opaque surface/border.
Input drafts and unshared photo previews survive minimization; the keyboard does not
cover controls. App backgrounding still ends capture/playback.

## Required evidence

- Deterministic thread-affinity, proposal/start boundary and existing barge-in tests.
- API and Swift regression checks and unsigned app build.
- Real Simulator fixture: minimize/reopen, Talk/Work/Memory navigation, work review,
  explicit end, light/dark, accessibility text, reduced motion/transparency.
- Physical audio, production Agent Host execution, and distribution are separate
  checks and must not be inferred from fixtures or compilation.

Verification results are recorded after execution; the contract itself is not proof.

## Local audit fixture

Launch the DEBUG app with `-ShannonDesignPreview -ShannonPreviewVoice
-ShannonPreviewVoiceListening -ShannonPreviewVoiceImplementation -ShannonPreviewLight`.
This is synthetic data with no microphone, recognition, model, or Agent Host run.
Add `-ShannonPreviewVoiceKeyboard` to exercise a retained multiline draft, or use
`-ShannonPreviewDark`, `-ShannonPreviewVoiceGuest`, and the existing reconnect/error
fixtures to cover their respective states. Do not use a production account to make
screenshots for the shared hub.

Audit sequence: minimize → Talk → another thread → Work → Memory → Settings →
reopen call; then review an implementation proposal from the call, return, and end.
Verify draft and unshared photo retention, textual phase/privacy, 44-point controls,
the distinction between review and start, guest task exclusion, large text,
Increase Contrast/Reduce Transparency, and Reduce Motion. Starting a fixture task
is not evidence that a production Agent Host performed implementation.

## Verification — 2026-09-29

- Canonical workspace unsigned iPhone Debug and Simulator Debug builds passed;
  source version/build remains 0.1.0 (55), not the distributed Build 92 identity.
- Swift regression: 178 XCTest and 44 Swift Testing cases; three iOS-only rendering
  checks are skipped on the Mac test host. Eight new workspace cases cover pinned
  session/delegation/photo/history, concurrent navigation, delayed history and
  organization loads, provisional-to-start boundary, follow-up requirements,
  reviewed settings, duplicate proposals, and accurate phase labels.
- Targeted API regression: 21 cases across realtime voice, conversation commands,
  orchestration, and authenticated streaming. No backend runtime change in this work.
- Fast harness, workspace, semantic-role, lab, architecture, and whitespace checks
  passed. The 500-line production ceiling remains intact.
- New UI screenshots, actual minimize/reopen/navigation taps, large-text and motion/
  transparency inspection remain **unverified**. The owner unlocked the Mac;
  Xcode Welcome and the connected physical iPhone were confirmed. The dedicated
  Simulator later booted, installed and launched the synthetic DEBUG fixture, but
  Device Hub and subsequently Xcode UI requests timed out under host-wide memory
  pressure (load averages reached 319). The owned Simulator was shut down and
  the distribution claim released. Launch is not interaction evidence; existing
  screenshots are not evidence for this new layout. Host recovery is required.
- Physical audio, production Agent execution, origin push, Azure deployment,
  TestFlight, and device installation have not been performed for this change.

Shared product roles and approval policy are unchanged. The reusable app-level
finding is to separate call lifetime from presentation, and bind every asynchronous
voice operation to the call's captured thread rather than the currently browsed one.
