# The Live2D embed page in the apps

Shannon has two forms in the iPhone and Mac apps: the Waterlight Eye (drawn natively, the default) and the
Live2D character. The Live2D form is drawn by a self-contained page built by the desktop-body project
(`shannon-desktop`, `npm run build` → `dist/embed/`). The apps bundle that folder unchanged and show it in
one shared `WKWebView`.

## What is bundled

| | |
| --- | --- |
| Location | `apps/ios/Sources/ShannonAppCore/Live2D/embed/` (copied as a folder: `.copy("Live2D")` in `apps/ios/Package.swift`) |
| `version` | `0.1.0` |
| `builtAt` | `2026-10-02T19:43:22.517Z` |
| `modelUpdatedAt` | `2026-10-02T19:15:02.996Z` |
| Size | about 18.3 MB (`assets.js` holds the model and its two textures, 4096×4096 and 2048×2048, as base64); about 13.6 MB zipped |
| Licence note | `apps/ios/Sources/ShannonAppCore/Live2D/NOTICE.txt` |

`ShannonBodyTests.testTheEmbedPageIsBundledAsAFolderWithItsFilesInPlace` checks that the files are in the
bundle with their relative paths and pins `modelUpdatedAt`; the body screen shows the loaded page's
`modelUpdatedAt` in a debug build started with `-ShannonPreviewBodyStats`.

## Updating the page

The folder is generated output. Never edit a file in it, and never replace one file: `assets.js` (the
model) and `embed.js` (poses, hit regions, timing) belong together.

1. Build the page in `shannon-desktop` (`npm run sync-model` when the model changed, then `npm run build`).
2. Delete `apps/ios/Sources/ShannonAppCore/Live2D/embed/` and copy the whole new `dist/embed/` in its place.
3. Update the table above and the pinned `modelUpdatedAt` in `ShannonBodyTests` from the new `version.json`.
4. Read the new `README.md` of the folder for changes to `window.shannonBody` or the posted messages, and
   follow them in `ShannonLive2DProtocol.swift`.
5. `swift test --package-path apps/ios`, then look at the body screen on a device in both layouts.

The Cubism Core (`embed/live2d/live2dcubismcore.min.js`) is Live2D's proprietary redistributable code. It
stays inside the folder as delivered and is not copied anywhere else in the repository.

## How the apps use it

- `ShannonLive2DStage` owns the only web view. Of the screens that show her, the one with the highest
  priority shows it (body screen, then the voice call, then the dialogue stage, then the small figure of an
  empty Talk; among equals the one that appeared last); every other place her figure stands shows the
  Waterlight Eye meanwhile. With no screen showing her, the page is paused at once and the web view is
  released after 90 seconds (the model holds a large texture in GPU memory); a memory warning with no
  screen showing her releases it immediately. A visible figure is never released by the app.
- The page is paused (`setPaused`) while the app is not active.
- Reduce Motion: `setIdle({ gestures: false, sway: 0 })` — she starts no gesture by herself and does not
  sway; breathing, blinking, faces, her mouth and her reaction to a touch go on. Low Power Mode:
  `setFrameRate(30)`, and after a minute without anything happening the figure is stopped until a touch
  or something to show (the page would otherwise draw for as long as the screen is up). The page's version does not say which calls it has, so the app asks the page
  (`typeof window.shannonBody.setIdle`); a page without them is paused into a still picture after five idle
  seconds instead, never while a finger is on her, and moves again on a touch.
- Loading: the page reports `loading { progress }`, shown on the body screen as a percentage. A page that
  sends no message at all for 40 foreground seconds, or is not `ready` after 90, is reloaded. A lost WebGL context is
  mended by the page itself (`contextLost` → `contextRestored`, after which the app says the layout, the
  calm and the pause again); the app reloads only on `error` (including
  `code: contextLost`, after the page gave up), on a failed load, or when the page's process ended. One
  automatic reload a minute, and a page that failed twice without once becoming ready is shown as failed on
  the body screen with 「もう一度読み込む」, with the Waterlight Eye in its place.
- No network: navigation is limited to the bundled folder, and a content rule list blocks `http(s)`,
  `ws(s)` and `ftp` (one rule per scheme). If the rule list does not compile, the page is not loaded at all.
- Framing: the square figures (dialogue stage, voice call, empty Talk) and the body screen's 上半身 use
  `setLayout({ mode: 'bust', fit: 'contain' })`; 全身 uses `full`.
- `ShannonBodyAttachment` passes what the app already knows to the page: the reply's face → `express`,
  the voice turn's emotion → `expressEmotion`, the `/v1/state` mood → `setMood`, text and call phases →
  `setPhase` (a call that is connecting or has failed is not idle, so a touch asks for no words then), the
  played speech level → `setMouthLevel` (a tap on the player node, installed only while the Live2D form is
  in use), and her own-time activity → `setPresence`. What she is doing in her own time comes from the
  owner's activity record: it is refreshed every 30 seconds on the body screen and otherwise as old as the
  app's last read of that record.
- Touch, the part that was touched, and her voice: `docs/body-contract.md`, "A body that only feels touch".
