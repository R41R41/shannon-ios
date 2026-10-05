# Shannon design authority

Revision: 2026-10-02

This document is the entrypoint for the currently implemented Shannon design. It records ownership and evidence; it does not propose a redesign.

## Product surfaces

- iPhone presentation and lifecycle composition live in `apps/ios-app`.
- Shared conversation, memory, settings, voice, organization, and task UI live by feature in `apps/ios/Sources/ShannonAppCore/Features`.
- Mac composition lives by surface in `apps/macos-app/ShannonDesk/Features` (`Shell`, `Talk`, `Work`, `Development`, `Shannon`, and `Settings`). Its sidebar has the four pillars トーク／作業／シャノン／設定 (roadmap A10); 開発 and 配信 are pages of 作業.
- Shared semantic colors and presentation primitives live in `apps/ios/Sources/ShannonAppCore/DesignSystem`.
- The private Gemini Voice Lab under `tools/gemini-voice-lab` is a browser-based operator surface for voice comparison. It shares Shannon's semantic roles and character presence, but does not replace an iPhone or Mac product screen.

Platform-specific navigation and controls stay native. Shared state, DTOs, Markdown behavior, and semantic meaning may be reused; an iPhone or Mac layout is not treated as the other platform's template.

## Native by default, custom by purpose

Shannon defaults to platform-native interface behavior. Apple Human Interface Guidelines, Apple Design Resources, and the platform SDK are the external references; this app-owned contract remains the authority for Shannon-specific meaning and composition.

- Navigation, lists, forms, buttons, text input, search, toolbars, sheets, popovers, menus, alerts, system typography and materials, and SF Symbols use SwiftUI or the corresponding native platform control whenever it satisfies the user job. Do not recreate a standard control only to restyle it.
- On iPhone, Talk uses `NavigationStack` navigation titles and toolbars, a native searchable sheet for conversations and workspace destinations, and a composer placed with `safeAreaInset`. Hidden workspace pages must not contribute search fields, toolbars, or other chrome to the active page.
- Figma UI Kits are design and prototyping references. Production implementation maps them to the corresponding native control instead of reproducing the kit as a custom runtime component.
- Custom UI is reserved for Shannon's product value: relationship and reassurance, transparent intelligence, Shannon Eye and character presence, water-blue warmth, conversation and work experiences, visibly provisional AI proposals, app-owned semantic color, and app-specific screen composition.
- Shannon's character expression is personality and context. It never replaces the standard semantic communication of success, attention, warning, danger, permission, or destructive consequence.
- iPhone and Mac share meaning, state, accessibility intent, and required logic—not screen geometry. iPhone is touch-first. Shannon Desk is keyboard-, pointer-, menu-, window-, sidebar-, and toolbar-aware. An iPhone screen must not be stretched into a Mac layout.
- A departure from a native control needs a concrete product-purpose reason, preserves familiar keyboard, focus, pointer, accessibility, and dismissal behavior, and is verified on the real target platform.

This is a standing rule for new UI and for any existing surface when it is next touched. It does not by itself require a wholesale rewrite of currently shipped UI.

## Semantic design grammar

Shannon uses the same role-based grammar as Aether and Voyager. UI code selects a role instead of a literal color or a generic Material slot:

- `action`: interactive controls and current selection
- `creation`: user-created or pending creation work
- `brandPresence` / `intelligence*`: Shannon presence and AI activity, never a generic action color
- `attention`, `success`, `danger`: state and consequence
- `canvas`, `readingSurface`, `subtleSurface`, `elevatedSurface`: content hierarchy
- `textPrimary`, `textSecondary`, `borderStrong`, `divider`: legibility and separation

The shared vocabulary does not make the three products visually identical. Shannon retains its own token values, intelligence gradient, native platform controls, spacing, shapes, and screen composition. Light and Dark values are resolved centrally by `ShannonDesignSystem.swift`; feature views must not introduce direct red, orange, or green status colors.

Shannon's compact and historical avatars keep the existing expression artwork. The iPhone empty-conversation hero, dialogue mode, and realtime voice use the Waterlight Eye: a near-black soft rounded-square face with sphere-projected capsule eyes, 160% eye scale, and the `intelligenceSky → brandPresence → intelligenceDepth` gradient. Dialogue activity changes the eyes themselves for preparing, connecting, listening, thinking, speaking, working, searching, waiting, completion, and failure; operational text remains the semantic authority. The Gemini voice surface keeps microphone, photo and participant controls visible with labels; large accessibility text stacks them. Its multiline native composer uses a keyboard-aware safe-area dock. A compact input-level glyph replaces the bottom spotlight and progress-like line; only real microphone level drives it, with no synthetic thinking sweep. Reduce Motion keeps this glyph still; operational phase text and the eye remain authoritative. In a call the Eye shows the per-turn emotion the voice acts with (provisional with the first spoken segment, then reconciled), also in 「友人も一緒」, where it is held in memory only. 得意げ, 慌てている and 申し訳なさそう have no dedicated artwork and borrow the determined, embarrassed and concerned shapes. Behind the Eye, on iOS 18+ without Reduce Motion, a low-contrast mesh of the same sky, presence and soft-intelligence tints drifts slowly; it moves slightly more while Shannon speaks and stops when the call fails. Touch tracking is active only while the face is pressed. Tapping produces one interruptible surprise-to-bashful reaction and reveals semantic `characterBlush` cheeks. Reduce Motion removes spatial and repeating motion while preserving the state-specific eye shape and the bounded bashful still response. Task rows, message avatars, and Mac compact avatars keep their existing assets and behavior.

## Two forms

Shannon's figure has two forms in the apps, chosen per device (default: Waterlight Eye): the Waterlight Eye and the Live2D character (`docs/live2d-embed.md`). By the decision of 2026-10-03 からだ is a display of Talk, not a screen of its own: on the iPhone her figure lives in Talk's dialogue display, named 「向き合う」 in the app (「向き合う表示」; one name since the owner's decision of 2026-10-05, replacing 「対話」). In the Waterlight form that display is as it was. In the Live2D form her figure stands large on top of it (全身／上半身, two-finger pinch and drag; with VoiceOver, direct touch and a swipe for her size), with one quiet line 「いま：〈気持ち〉・〈していること〉」 under her and the last words below; one finger on her is a touch, in place. The display button of Talk switches the display with one tap as before; a long press offers her form and, in the Live2D form, her body, 映し方 (人の姿 only) and 位置を戻す. The Live2D form has two bodies, 体: 人の姿 (the character, the default) and 目だけ (her eyes alone, two light-blue eyes that move as the Waterlight Eye does; owner decision 2026-10-05, as 設定 › すがた › 体 on the desktop). Her eyes alone have no mouth, arms or framing: they can only be poked, 映し方 is not offered for them, and under Reduce Motion an idle pair of eyes becomes a still picture after five seconds. 設定 › すがた has the form, 体, 映し方, 位置を戻す, 「トークで姿を見る」, 「体に起きたことをシャノンに伝える」 (off by default; only there, so it is not switched by mistake mid-conversation) and 「触れたときの返事」 (文字で返す, the default, or 声で返す). With 声で返す, while the dialogue display with her figure is what the owner sees (nothing over it) and every other condition of the body screen holds (owner alone, nothing else holds the sound, app in front, 伝える on, Live2D form), she says her line in her voice with her mouth moving, then listens for a few seconds, and an answer becomes a voice conversation on the call screen; otherwise the line is a bubble near her, announced to VoiceOver. The small figure of an empty Talk, in the Live2D form, opens the dialogue display. Where her figure is the subject — the dialogue display, the empty-conversation hero and the Gemini voice call — the chosen form is drawn and the Waterlight Eye stands in while the Live2D page loads, fails, or is shown by another screen. Status-sized presences (the card of 「シャノン」, message and task avatars, the typing indicator, the Mac compact avatars) keep their existing artwork. The Mac keeps its body sheet from Settings until her figure stands beside the conversation there (roadmap A15). Reduce Motion stops the gestures she starts by herself and her sway; Low Power Mode halves the drawn frames. Contract: [`docs/design/screens/ios/body.yaml`](design/screens/ios/body.yaml).

## Adapted external components

Shannon may adapt an external SwiftUI component only by reading its source and rewriting the needed part into Shannon's own types, copy, semantic roles, and ownership boundaries (`DesignSystem` for shared presentation, `Features` for product behavior, and the Mac app for Mac expression). No external component package, CLI, MCP server, or unmodified component file is added. Each adapted file names its source and license, and `THIRD_PARTY_NOTICES.md` holds the license text and the source-to-file map. Swift Pieces components are MIT + Commons Clause: they remain inside the Shannon app and are never extracted into a shared or distributed UI package.

Current Swift Pieces adaptations and their Shannon behavior (buttons that share a row use `ShannonButtonRow`: side by side only while every label fits on one line, otherwise stacked; labels never wrap inside a button):

- **Reply code** (`ShannonCodeBlock`, `DesktopCodeBlockView`): language label, copy that becomes “コピー済み”, collapse after 12 lines when at least 15 lines exist, continuous text selection, horizontal scroll, and a shallow lexical highlighter over Shannon semantic roles. Unknown languages stay uncolored. The Markdown `.code` block carries the optional fence language.
- **Text waiting** (`ShannonTypingIndicator`): the 54 pt expression avatar, “考えている…” (or “記憶を探しています…” during memory search), reply-shaped line bars with an `intelligenceSky` sheen, and elapsed seconds after the first second. Reduce Motion stops the sheen.
- **Plan timeline** (`AgentTaskPlanTimelineView`, `DesktopPlanTimelineView`): driven only by plan item status through `ShannonAgentPlanTimeline`; running-step details come from durable command events, the latest timeline event, and test results. On iPhone the task room shows progress once — in the navigation subtitle (e.g. “許可待ち・5/8工程”) — and folds a leading run of two or more completed steps into one expandable row; a pending approval is the first item in the room. The Mac work inspector keeps its five-stage progress view.
- **Permission primer** (`ShannonPermissionPrimerSheet`): shown for the Gemini voice microphone and in-call camera only when authorization is undetermined, immediately before the system request that runs on the user's tap, and reused for the denied state with a Settings route. The photo library uses the out-of-process `PhotosPicker`, which asks for no permission, so it has no primer.
- **Approval hold-to-confirm** (`ShannonHoldToConfirmButton`; built on iPhone, decided for Mac and Windows too): `ShannonAgentApprovalKind.requiresHoldToConfirm` decides the choices. One-off command and file-change approvals stay a single tap; “この作業中” for every kind, and “今回だけ許可” for network and permission, commit after a 0.6 s hold. A tap, keyboard activation, or VoiceOver activation opens a confirmation dialog with the same result, so holding is never required. “許可しない” refuses only that operation with a single tap when the Agent Host and API support per-operation decline; against an older host it reads “許可せず作業を中止” and asks for confirmation because it stops the task. The choices keep their meaning. Reduce Motion replaces the fill with “押し続けています… N%”. By the owner's decision of 2026-10-03 (`docs/product/information-architecture.md`) the same three choices with hold-to-confirm apply on every surface, desktop included: there the hold is a press-and-hold with the pointer, and keyboard or assistive activation opens a confirmation dialog with the same text. This replaces the earlier rule that the Mac inspector keeps pointer buttons without a hold. The Mac work inspector has the three choices since roadmap A11 (`ShannonDesktopApprovalCard.swift`): the same `ShannonHoldToConfirmButton`, held with the pointer, read on the desktop scale; its hint says 「クリックすると確認してから決定します」 (`hold.hintClick`, `task.approval.holdHintClick`).
- **Empty-conversation suggestions** (`ShannonPromptSuggestionList`): up to three rows above the composer, each wrapping to two lines, from already-loaded daily focus, active tasks, and interests, otherwise three fixed prompts. Choosing one fills the composer and never sends. The empty conversation centers the Waterlight Eye with the greeting “おかえり／今日はどこから始める？”. The Mac's empty Talk shows the same list under its quiet invitation (roadmap A14).

Motion and haptic defaults for these components: press feedback is immediate and releases with a non-bouncing spring (`bounce: 0`); expansion uses a 0.35 s damped spring or a 0.15 s ease-out under Reduce Motion; no node pulses or celebratory scaling. Haptics accompany only a user-initiated result (copy success, chip selection, completed hold); background progress such as a completed plan step is silent.

## Work states, captures and calls with a friend

- **One vocabulary for work**: 提案 / 準備中 / 作業中 / 許可待ち / 続きが必要 / 一時停止中 / 完了 / 失敗 / 中止 on iPhone, Mac, notices, push titles and the prompt's task projection. 「続きが必要」 is a pause that needs the owner and carries a next action; 「一時停止中」 is a pause the owner asked for. A notice, badge and push follow what the owner has not yet seen (a new approval request, a new owner-needed pause, a new result), not whether the task was ever opened. The full list lives in `docs/design/screens/ios/work.yaml`.
- **Capture lines** (`ShannonTurnCaptureList`): under a Shannon reply, a quiet line shows what the turn took in — 約束にしました／覚えました／目的にしました, or a notice when something cannot be done as asked — opens the item, and offers 取り消す. A turn that captured nothing shows nothing. Reminder messages carry 完了にする／あとで.
- **友人も一緒**: a running call switches without reconnecting; a persistent card states what is and is not kept and subtitles use a neutral speaker label. The name said in the call and what was talked about are remembered when the period ends; the end card says so and offers 「今回は残さない」. With anyone else present Shannon checks before speaking whether something is personal information they do not know; only what the owner called a secret or marked 機微 by hand is kept from her entirely. Details: `docs/design/voice-workspace.md` and `docs/design/people-and-audience.md`.
- **人**: 頭の中 lists remembered people on iPhone and Mac with what was talked about and 「〇〇さんと一緒の時」; rename, merge, forget and restore, and 機微／ふつう on any memory.
- **シャノンのやりたいこと／したことの記録**: 頭の中 shows Shannon's own goals, questions and works in a section separate from the owner's 「続けている目的」; the owner reads it and can only tell her to rest or drop an entry that is not a seed. 「したことの記録」, reachable from 頭の中 and Settings, shows the state of autonomous activity, today's budget, a pending budget request, her proposals, and an append-only record grouped by day with no edit or delete control. The stop switch (「自律活動を一時停止」) is in Settings and in the record; pausing does not stop chat, voice, memory or work the owner started. A proposal from her own activity shows her reason and the core areas it touches, and nothing starts until the owner confirms. Rule: Syzygy ADR-0002.
- **Shown feeling is her feeling**: the expression beside a reply comes from Shannon's emotional state for that reply and cues in her own words, never from words in the owner's message. Expression names have one shared source for iPhone and Mac (`ShannonFace.swift`); VoiceOver reads 「シャノン、〈気持ちの名前〉」. 親密さ, 好奇心 and her confidence about the owner move from stored evidence and the state sheet shows what they are made of; fixed traits are not presented as state. The app icon does not follow emotion or appearance.
- **Forgetting is narrow and reversible**: forgetting, rejecting or correcting one memory withholds only what used it, and the confirmation says what stops being used and that restoring brings it back.
- **One identity**: Shannon's persona and her list of what she can and cannot do are defined once in `packages/cognition` (`persona.ts`, `capabilities.ts`) and projected into text, voice and fixed sentences. UI copy presented as her speech follows it (です・ます, 「ライ氏」, 「ボク」); system status stays neutral.

## シャノン, ようす and 管理 › 運用 (iPhone)

Owner picks of 2026-10-03 (entry A, 運用 B, confirmation A, シャノンのいま A), placed by the unified structure of the same day (`docs/product/information-architecture.md`). Contract: [`docs/design/screens/ios/yousu.yaml`](design/screens/ios/yousu.yaml).

- **Entries**: the thread list sheet has three tiles, 作業／シャノン／設定 (Talk is the list itself). 「シャノン」 is a workspace page: a card with her face, mood, what she does in her own time and what waits for the owner (「あなたを待っていることは、ありません。」 when nothing does), which opens ようす; then the rows 頭の中／自律活動／書斎. 自律活動 is one page (stop switch, today's budget, proposals, her pursuits and models, the record). The 「シャノン」 tile counts what she waits for; the top-left button carries a red dot for unread items and what waits.
- **運用 lives in 設定 › 管理** (運用、接続中の端末、配信、診断, at the top of Settings; 「接続と詳細」 is gone). Its mark is an orange triangle — another shape than the red dot — on the top-left button and on the 設定 tile, and the 運用 row shows the same mark with its reason in one line (「サーバーに届きません」「報告が届いていません」「〈名前〉が不調」「〈対象〉の操作が失敗／期限切れ」). It appears only after the first report ever arrived, and a failed or expired operation counts for one hour. Before the first report the row stays and says 「運用の報告は、まだ届いていません。」. `shannon://admin/ops` (and the older `shannon://yousu/ops`) open it; `shannon://yousu` opens ようす. VoiceOver reads the marks with their reason on the button and the tile. On the Mac (roadmap A10, A12) the same pages sit in the two-column 「シャノン」 and 設定 (parts left, content right, 管理 first); the mark is the triangle on the sidebar's 設定 row and the line 「運用：〈理由〉」 under it.
- **運用**: a native grouped list: サービス, Minebot (with the current task and its steps), Minecraft サーバー, スケジュール, 今日の数字 (only when sent), スキル, 操作の記録. 開始／停止／起動／今すぐ実行 sit in the row and exist only for what the server allows. A state is a glyph and a word (動いている／止まっている／不調／不明). A report older than three minutes shows 「報告が届いていません」, words every state in the past tense, dims the rows and removes every control; a server that cannot be reached says so separately.
- **Confirmation**: a bottom sheet with the full text, kept word for word with the Windows app, the server to join for the Minebot body, and `ShannonHoldToConfirmButton`; a tap, the keyboard and VoiceOver get the same text in a dialog. What became of the press is shown as the server records it (実行待ち／実行中／完了／失敗／断られました／期限切れ with its reason), or as the one sentence why it was not sent.
- **シャノンのいま**: one calm list. 待っていること first (感想／判断／許可, opening where each is decided), then her mood with 「いまの気持ち」 and 「まだ残っている気持ち」 (a face and since when, never a reason), 自分の時間 (the server's sentence, her reason for resting, today's budget), 体, and 最近のできごと: looks, touches and messages she started in one muted timeline with no counters. A message says how it reached him: her body, his earphones, a call (電話で届いた／電話に出なかった／電話を断った／電話がつながらなかった), or read in a Talk. Empty is 「まだありません」. Nothing on this page can be changed.

## Preserve

- Talk remains the primary surface, with Shannon messages visually distinct from the user's quieter bubbles.
- Conversation history, attachment and web-research results, organize review cards, task progress, memory transparency, appearance selection, and realtime voice remain available.
- Light, Dark, and System appearance modes use the existing semantic color contract.
- Compact Shannon avatars preserve their expression label for VoiceOver and use shape, not color alone, to communicate emotion.
- User-reviewed cross-app changes remain preview-first and fail closed before external writes.
- Development keeps project, execution host, model, reasoning effort, files, command history, diff, Git state, and build evidence together. `auto` visibly prefers the local Mac and uses the cloud host only when local execution is unavailable or busy; explicit local selection never silently becomes cloud execution.
- Development can add an HTTPS GitHub repository to Agent Host-owned workspaces. `Auto` provisions every available local and cloud host so local-first work can fail over when the Mac is offline; an explicit host choice provisions only that host. Repository URLs and aliases are validated on both API and host, credentials never travel in the request, and existing user checkouts remain untouched.

## Screen contracts and evidence

Machine-readable contracts live in `docs/design/screens/<platform>/`. They describe the current user job, interaction invariants, non-happy states, accessibility requirements, and safe evidence. A UI change updates the affected contract and evidence in the same task.

Current safe screenshots live in `docs/screenshots/`. Concept art under `design/character-concepts/` is visual source material, not proof of a shipped screen. HTML documents under `docs/archive/` are historical decision records or operational evidence and are non-authoritative unless explicitly selected by the user.

Representative contracts include [`docs/design/screens/macos/talk.yaml`](design/screens/macos/talk.yaml),
[`docs/design/screens/ios/talk.yaml`](design/screens/ios/talk.yaml), and
[`docs/design/screens/ios/work.yaml`](design/screens/ios/work.yaml). The Mac work inspector is governed by
[`docs/design/screens/macos/work.yaml`](design/screens/macos/work.yaml).
The Mac development workspace is governed by
[`docs/design/screens/macos/development.yaml`](design/screens/macos/development.yaml).
The private browser listening workbench is governed by
[`docs/design/screens/web/gemini-voice-lab.yaml`](design/screens/web/gemini-voice-lab.yaml).
The iPhone call minimization, pinned conversation, and implementation-review flow
is governed by [`docs/design/voice-workspace.md`](design/voice-workspace.md).
App naming and the three-level icon selector are governed by
[`docs/design/screens/ios/settings.yaml`](design/screens/ios/settings.yaml) and
[`docs/design/screens/macos/settings.yaml`](design/screens/macos/settings.yaml).
The app-owned shared-role mapping is [`docs/design/semantic-role-map.v1.json`](design/semantic-role-map.v1.json) and is checked deterministically by `scripts/check-semantic-role-map.mjs`.

Memory management is governed by [`docs/design/screens/ios/memory.yaml`](design/screens/ios/memory.yaml)
and [`docs/design/screens/macos/memory.yaml`](design/screens/macos/memory.yaml). The shared memory
overview always exposes a native navigation entry to all durable memories and commitments,
including completed/dismissed commitments and forgotten/rejected items. Rich activity or
knowledge projections must not hide this management path. The current-state area also exposes
owner-visible durable intentions and bounded cognitive-cycle receipts. Intent status changes are
explicit user actions backed by the server result; a receipt summarizes purpose, recall, action,
and outcome without storing or presenting private chain-of-thought. An explicitly stated goal may
also carry one next step and up to five owner-visible plan stages. The UI labels these as a proposal;
they never imply execution or completion without an existing verified receipt.
