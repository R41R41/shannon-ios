# Shannon design authority

Revision: 2026-09-12

This document is the entrypoint for the currently implemented Shannon design. It records ownership and evidence; it does not propose a redesign.

## Product surfaces

- iPhone presentation and lifecycle composition live in `apps/ios-app`.
- Shared conversation, memory, settings, voice, organization, and task UI live by feature in `apps/ios/Sources/ShannonAppCore/Features`.
- Mac composition lives by surface in `apps/macos-app/ShannonDesk/Features` (`Shell`, `Talk`, `Work`, and `Settings`).
- Shared semantic colors and presentation primitives live in `apps/ios/Sources/ShannonAppCore/DesignSystem`.

Platform-specific navigation and controls stay native. Shared state, DTOs, Markdown behavior, and semantic meaning may be reused; an iPhone or Mac layout is not treated as the other platform's template.

## Preserve

- Talk remains the primary surface, with Shannon messages visually distinct from the user's quieter bubbles.
- Conversation history, attachment and web-research results, organize review cards, task progress, memory transparency, appearance selection, and realtime voice remain available.
- Light, Dark, and System appearance modes use the existing semantic color contract.
- User-reviewed cross-app changes remain preview-first and fail closed before external writes.

## Screen contracts and evidence

Machine-readable contracts live in `docs/design/screens/<platform>/`. They describe the current user job, interaction invariants, non-happy states, accessibility requirements, and safe evidence. A UI change updates the affected contract and evidence in the same task.

Current safe screenshots live in `docs/screenshots/`. Concept art under `design/character-concepts/` is visual source material, not proof of a shipped screen. Numbered HTML documents under `docs/` are historical decision records and are non-authoritative unless explicitly selected by the user.

The initial representative contract is [`docs/design/screens/macos/talk.yaml`](design/screens/macos/talk.yaml).
