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
| `builtAt` | `2026-10-02T17:55:59.106Z` |
| `modelUpdatedAt` | `2026-10-02T17:09:06.469Z` |
| Size | about 18 MB (`assets.js` holds the model and its 4096×4096 texture as base64) |
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

- `ShannonLive2DStage` owns the only web view. The screen that appeared last shows it; every other place
  her figure stands shows the Waterlight Eye meanwhile. With no screen showing her, the page is paused
  at once and the web view is released after 90 seconds (the model holds about 85 MB of GPU memory); a
  memory warning with no screen showing her releases it immediately.
- The page is paused (`setPaused`) while the app is not active. With Reduce Motion or Low Power Mode on,
  an idle figure becomes a still picture after five seconds and moves again on a touch or when something
  is to be shown (the page has no switch for idle gestures).
- A page `error`, a lost WebGL context (reported by an injected listener and checked on return to the
  foreground), an ended web process, or no `ready` within 90 foreground seconds reloads the page once a
  minute; a second failure is shown on the body screen with 「もう一度読み込む」 and the Waterlight Eye stays.
- The page is given no network: navigation is limited to the bundled folder, and a content rule blocks
  `http`, `https`, `ws`, `wss` and `ftp`.
- `ShannonBodyAttachment` passes what the app already knows to the page: the reply's face → `express`,
  the voice turn's emotion → `expressEmotion`, the `/v1/state` mood → `setMood`, text and call phases →
  `setPhase`, the played speech level → `setMouthLevel`, and her own-time activity → `setPresence`.
- Touch: `docs/body-contract.md`, "A body that only feels touch".
