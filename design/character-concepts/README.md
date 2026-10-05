# Shannon character concepts

Generated with the built-in image generation tool on 2026-08-31. The selected Icon Chibi expression set is now bundled in the Swift Package; other concepts remain design references.

Unselected generated explorations remain locally under `drafts/` and are ignored by Git to keep the repository lean.

## Selected canonical direction

**A — Classic Future Maid** was selected as Shannon's canonical appearance on 2026-08-31.

Identity anchors to preserve in future generations:

- Short layered sky-blue bob
- Red-magenta eyes
- White scalloped maid headband on a dark band
- Single round black/white/cyan AI earpiece
- Black-and-white future-maid uniform with restrained cyan accents
- Gentle, attentive, intelligent presence

## Shared direction

- Reference images 1 and 4: appearance cues only — short sky-blue bob, red-magenta eyes, black/white/cyan clothing language
- Reference images 2 and 3: proportion and rendering cues only — 3.5-to-4.5-head chibi proportion, bold clean outlines, simplified shapes, polished cel shading
- Original adult AI maid companion; no exact recreation of an existing character or outfit
- Full-body concept with a face inset for small chat-avatar readability
- Modest practical clothing; warm off-white background; no text, logo, watermark, scenery, or extra characters

## Variants

### A — Classic Future Maid

Classic black/deep-navy maid dress, structured white apron, restrained frills, cyan luminous piping, and a discreet AI earpiece. Warm, composed, dependable.

### B — Aether-Tech Companion

White/pale-cyan layered tunic dress, black suspenders, navy underskirt, translucent jacket sleeves, geometric maid headpiece, and high-top shoes. Curious, quick, playful; the strongest AI-assistant direction.

### C — Cozy Home Maid

Soft black ankle-length dress, generous white apron, cyan ribbon and seam accents, practical low shoes. Gentle, observant, comforting; the strongest everyday-companion direction.

## Chat icon deformation study

The selected A design was converted into three square, circular-crop-safe chat avatar directions. The lavender versions are the preferred previews for the Material 3 UI.

- `01-balanced-sd-lavender`: premium portrait; retains the most costume information
- `02-icon-chibi-lavender`: recommended default chat avatar; best balance at 40–48 px
- `03-mascot-mini-lavender`: strongest deformation; best emotional readability and notification/sticker use

Shared icon prompt: preserve the canonical identity anchors, use a centered head-and-tiny-shoulders composition, enlarge the face and eyes, simplify costume and hair details, use bold clean outlines and low-noise cel shading, and keep every identity feature inside a circular-crop safe area.

## Production expression set (2026-10-05)

By the owner's decision of 2026-10-05 the chat icons were redrawn: Shannon as her Live2D design, drawn in the style of the earlier icons, generated with gpt-image-2.5-sunburst. All 22 faces share one framing (head and shoulders, centred) on an opaque pale lavender canvas, and are bundled at 384×384 (the size the app's loader renders; re-encoded from the 768×768 originals with Lanczos, 2026-10-05) as `apps/ios/Sources/ShannonAppCore/Resources/shannon-expression-<face>.png`. 26 emotion kinds may have an icon of their own in the same framing, `shannon-emotion-<kind>.png` (the list is `ShannonEmotionKindIcon.swift`); the apps show it when the reply's `messageEmotion.kind` has one and the face otherwise. At display time the apps replace only the canvas joined to the picture's edge with white (`ShannonPortraitBackground.swift`), so pale colours in her hair are kept.

## Earlier production expression set (until 2026-10-05)

`02-icon-chibi-lavender` was selected as the production chat-avatar master. The neutral master and seven identity-preserving expression edits are bundled in:

`apps/ios/Sources/ShannonAppCore/Resources/shannon-expression-<name>.png`

Expressions:

- `neutral`: canonical gentle smile
- `joyful`: closed happy crescent eyes, open smile, stronger blush
- `curious`: wider eyes, asymmetric raised eyebrow, small round mouth
- `tender`: half-lidded warm gaze, soft smile, visible blush
- `calm`: gently closed eyes and a content smile
- `concerned`: drawn inner brows and a small uneasy mouth
- `sad`: lowered gaze, held tears, downturned mouth
- `sleepy`: heavy eyelids and a loose exhaling mouth

Generation invariant: change only eyebrows, eyelids, pupils, mouth, and explicitly requested cheek/tear details. Preserve the master composition, hair, headband, earpiece, clothing, crop, palette, lighting, and lavender background.
