# Shannon design authority

Revision: 2026-09-14

This document is the entrypoint for the currently implemented Shannon design. It records ownership and evidence; it does not propose a redesign.

## Product surfaces

- iPhone presentation and lifecycle composition live in `apps/ios-app`.
- Shared conversation, memory, settings, voice, organization, and task UI live by feature in `apps/ios/Sources/ShannonAppCore/Features`.
- Mac composition lives by surface in `apps/macos-app/ShannonDesk/Features` (`Shell`, `Talk`, `Work`, `Development`, and `Settings`).
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

Shannon's compact and historical avatars keep the existing expression artwork. The iPhone empty-conversation hero, dialogue mode, and realtime voice use the Waterlight Eye: a near-black soft rounded-square face with sphere-projected capsule eyes, 160% eye scale, and the `intelligenceSky → brandPresence → intelligenceDepth` gradient. Dialogue activity changes the eyes themselves for preparing, connecting, listening, thinking, speaking, working, searching, waiting, completion, and failure; operational text remains the semantic authority. The Gemini voice surface keeps microphone, photo and participant controls visible with labels; large accessibility text stacks them. Its multiline native composer uses a keyboard-aware safe-area dock. A compact input-level glyph replaces the bottom spotlight and progress-like line; only real microphone level drives it, with no synthetic thinking sweep. Reduce Motion keeps this glyph still; operational phase text and the eye remain authoritative. Touch tracking is active only while the face is pressed. Tapping produces one interruptible surprise-to-bashful reaction and reveals semantic `characterBlush` cheeks. Reduce Motion removes spatial and repeating motion while preserving the state-specific eye shape and the bounded bashful still response. Task rows, message avatars, and Mac compact avatars keep their existing assets and behavior.

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
[`docs/design/screens/ios/work.yaml`](design/screens/ios/work.yaml). The Mac development workspace is governed by
[`docs/design/screens/macos/development.yaml`](design/screens/macos/development.yaml).
The private browser listening workbench is governed by
[`docs/design/screens/web/gemini-voice-lab.yaml`](design/screens/web/gemini-voice-lab.yaml).
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
