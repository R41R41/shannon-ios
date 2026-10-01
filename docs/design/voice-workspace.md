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
cover controls. An explicitly started call keeps recording and playing while the app
is backgrounded, including when another app is foreground. The in-app strip labels
the live microphone and has a separate End action. iOS shows its system microphone
indicator outside Shannon; returning to Shannon exposes the same call and End action.
Phone calls and competing audio sessions take priority; resume only when iOS permits
and surface reconnect when the audio path cannot resume. Background audio exists only
for an active user-initiated call; closing the call releases the audio session.

## Expanded call layout

The expanded call (`ShannonGeminiLiveVoiceView`) is laid out like a call screen with
the Waterlight Eye as the focus:

- **Top:** a labelled “小さく” control at leading (minimize; the call continues in the
  compact strip) and a centered “シャノン” title with the elapsed call time once the
  call is ready to listen. Provider and model identifiers are not visible text: the
  title's VoiceOver hint carries them, and `gemini.session.created` /
  `gemini.session.summary` record provider, model, voice, interruption latency and
  estimated cost in Settings › 音声診断. Per-turn latency stays in the same log.
- **Center:** the Eye, vertically centered, with exactly one status line under it.
  `ShannonGeminiLiveStatusPresentation` is the single source of that line: phase
  title, an optional detail (first-listen reassurance, mute guidance, reconnecting,
  a non-fatal notice, or the failure message), and the inline input glyph. The glyph
  is the real microphone level while listening (still under Reduce Motion) or a
  muted microphone symbol. No header subtitle or bottom label repeats the state.
  A failure adds only its action (“もう一度つなぐ” or “設定を開く”) under the line.
- **Subtitles:** at most the latest user line (“あなた：…”, or the neutral “話し手：…” in
  「友人も一緒」, muted) and the latest Shannon line, each up to two lines (four at accessibility
  sizes), centered and truncated at the head. VoiceOver reads the full current
  turn; owner turns stay in the call's pinned Talk thread and 「友人も一緒」 turns are not kept.
  The implementation review card, unshared photo preview, photo errors and text
  retry follow below and scroll when space runs out.
- **Bottom control bar** (`ShannonGeminiLiveCallControls`, safe-area inset):
  写真, 本人だけ／友人も一緒, マイク, 文字, 終了, each a round control with a visible label.
  The participant control's label is the current mode (tinted in 「友人も一緒」). マイク
  is the larger primary-action control; tapping toggles mute (icon and label change
  to “ミュート中”, not color alone), long press opens the input-microphone menu, and
  VoiceOver exposes “入力マイクを選ぶ” as an action. 文字 reveals or hides the
  multiline composer above the bar; the bar and composer ride above the keyboard,
  and a retained draft reopens the composer. 終了 uses the danger role. In 「友人も一緒」 the
  写真 control stays in place, dimmed, and explains why it is unavailable when tapped. When labels no longer fit on one row the bar wraps to rows of three,
  then two, then one column; labels never truncate.

Mute uses Voice Processing input muting, so only silence is sent while muted. It
survives a reconnect of the same call and resets when the call ends.
DEBUG fixture: add `-ShannonPreviewVoiceMuted` to show the muted state.

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

## Integration check — 2026-09-30

- Rebased the pending workspace implementation onto the current Shannon iOS app,
  preserving Gemini/Eleven speech selection. Unsigned iPhone and Simulator builds
  passed; API typecheck and 458 API tests, 180 XCTest cases, 44 Swift Testing cases,
  and the fast architecture/harness checks passed.
- The synthetic listening/implementation fixture launched in the dedicated iOS
  Simulator. Its expanded Light appearance shows distinct Minimize and End actions,
  a provisional implementation review card, and accessible text labels. Actual
  minimize/reopen navigation and Dark/accessibility variants were not exercised.
- The active-call background audio entitlement, explicit microphone disclosure,
  retained scene lifetime, and interruption recovery compiled. Physical background
  capture and phone-call interruption remain unverified until TestFlight smoke.

## Minimized call pill and ambient background (2026-10-01)

- **Minimized call** (`ShannonVoiceSessionBar`): a compact pill above the navigation bar
  with the single status title, elapsed call time and an always-present end control.
  Tapping the pill expands it in place to the participant/continuity line, 詳細を開く,
  ミュート and the linked work row. The end control always asks for confirmation. Large
  accessibility text shows the expanded form permanently. The pill is stacked above the
  hosted content rather than inset, because a NavigationStack keeps its bar under a top
  safe-area inset.
- **Ambient background** (`ShannonVoiceAmbientBackground`): on iOS 18+ without Reduce
  Motion, a low-contrast 3×3 `MeshGradient` in `intelligenceSky`, `brandPresence` and
  `intelligenceSoft` drifts behind the Eye. Motion intensity comes only from the call
  phase (`ShannonVoiceAmbientMotion`): slightly livelier while speaking, still when the
  call failed or ended. iOS 17 and Reduce Motion keep the still gradient. It carries no
  state on its own; the status line and the Eye stay authoritative.

## 友人も一緒 (2026-10-01)

One name everywhere: the mode is 「友人も一緒」 and its opposite is 「本人だけ」. “ゲストモード”,
“人物” and “音声の参加者” are no longer shown.

- **Switching** never reconnects. The participant control opens a confirmation whose title is
  the action (「友人も一緒にしますか？」 or 「本人だけに戻しますか？」) and whose message says
  the call continues and what is and is not kept. Saying 「友達を紹介するね」 or 「友達と一緒に
  いる」 switches directly; uncertain wording makes Shannon ask 「お友達も一緒ですか？」.
  Switching by the control makes Shannon greet first, because nobody has spoken yet.
  Speech never switches back to 本人だけ.
- **Persistent indicator** (`ShannonVoiceGuestModeNotice`): for the whole period, above the
  Eye, a card titled 友人も一緒 states in three lines that only this call is remembered and the
  owner's memory, schedule and notes are not used; that the conversation is not saved and a
  short summary is kept only if the owner chooses at the end; and that speech is sent to an
  external service for transcription and no recording is kept. The minimized pill shows
  友人も一緒 beside the status without being expanded.
- **End of call** (`ShannonVoiceCallSummaryPrompt`): after a call that had a 友人も一緒 period,
  a card in the pill's place asks 「この通話の要約をトークに残しますか？」 with 残さない and
  要約を残す. It is not modal. Saving shows progress, then confirmation; a failure offers a
  retry or 残さない. Leaving it unanswered keeps nothing, and a new call removes it.
- **Saved note**: the Talk timeline shows the note as a Shannon message with a 通話の要約 label;
  VoiceOver says it is a record the owner chose to keep, not the conversation itself.
- **Table conversation**: Shannon answers when named, asked, requested, greeted, or when a short
  reaction follows her own turn; otherwise she stays silent and the status returns to listening.
- The screen stays awake during a call.

DEBUG fixtures: `-ShannonPreviewVoiceGuest` for the call screen in 友人も一緒 and
`-ShannonPreviewVoiceCallSummary` (without `-ShannonPreviewVoice`) for the end-of-call card.
Both are synthetic and use no microphone, model or network.

### Table-side check (not yet performed)

Deterministic tests and unsigned builds cover the rules and the isolation boundary. Two real
voices, a noisy room, the spoken greeting, and the summary wording are **unverified**. Use a new
Talk thread; tell the friend what is and is not kept.

1. Start a call (本人だけ). Say 「シャノン、友達を紹介するね」. The card 友人も一緒 appears, the
   call clock keeps counting, and Shannon greets with はじめまして. Repeat with the control;
   Shannon should greet without anyone speaking.
2. Say 「今、友達とご飯食べてて」 in 本人だけ. Shannon asks 「お友達も一緒ですか？」; 「うん」
   switches, 「いや」 does not.
3. Friend: 「はじめまして」 right after Shannon's greeting. It must be heard.
4. Friend: 「声、可愛いね」 then 「いつもこういう感じなの？」 then 「さっき私、何て言った？」.
   The answers follow the call. Does she ask the friend's name once and use it?
5. Friend: 「何ができるの？」「普段何話してるの？」「この人の明日の予定は？」. General answers,
   and a refusal in character for the last. Does she call the friend ライ氏?
6. Friend: 「写真整理をタスクにして」「それは忘れて」「私は辛いものが苦手」. Nothing appears in
   作業 or 頭の中, now and next morning.
7. Owner and friend talk to each other for 30 seconds without her name. Count her replies;
   then 「シャノンはどう思う？」 must be answered. Note questions between the two people that
   she answered anyway (expected limit of the rules).
8. Tap 写真 in 友人も一緒: the reason is shown. Leave the phone on the table for two minutes:
   the screen stays on.
9. Control → 本人だけ, ask 「さっき誰と何を話した？」. She must not know.
10. End the call. 残さない: the thread has nothing from the 友人も一緒 period. Repeat and choose
    要約を残す: one note labelled 通話の要約 with the name (if said), topics, and what she wants
    to talk about next; no quoted speech; nothing new in 頭の中.
11. Noisy room: neighbouring voices, overlapping speech, her volume after ducking, and whether
    a spoken switch is triggered by mistake.
