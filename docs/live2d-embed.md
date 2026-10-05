# The Live2D embed page in the apps

Shannon has two forms in the iPhone and Mac apps: the Waterlight Eye (drawn natively, the default) and the
Live2D form. The Live2D form has two bodies (owner decision 2026-10-05, the desktop's 設定 › すがた › 体): the
character (「人の姿」, the default) and her eyes alone (「目だけ」, two light-blue eyes that move as the Waterlight Eye does). The Live2D form is drawn by a self-contained page built by the desktop-body project
(`shannon-desktop`, `npm run build` → `dist/embed/`). The apps bundle that folder unchanged and show it in
one shared `WKWebView`.

## What is bundled

| | |
| --- | --- |
| Location | `apps/ios/Sources/ShannonAppCore/Live2D/embed/` (copied as a folder: `.copy("Live2D")` in `apps/ios/Package.swift`) |
| `version` | `0.1.0+202610050955` |
| `builtAt` | `2026-10-05T09:55:22.225Z` |
| `modelUpdatedAt` | `2026-10-05T06:58:16.654Z` (the character is the model of the build of 07:01. Bundled 2026-10-05 by the owner's decision to take her eyes alone. Against the build of 07:01: `assets.js` gains the eyes model (`model-eyes/`: moc3, one 2048×2048 texture, 34 motions), `embed.js` and `live2d/live2d.js` gain `setBody`, and `README.md` documents it; `embed.html`, `embed.css` and the Cubism Core are byte-identical) |
| Size | about 27.9 MB, of which `assets.js` is 27.1 MB (the character's model and its two textures, 4096×4096 and 2048×2048, and the eyes' model, texture and motions, as base64); about 16.2 MB zipped. The build of 07:01 was 20.5 MB (14.6 MB zipped): the app grows by about 7.4 MB installed and 1.5 MB to download |
| sha256 | `assets.js` `da4fdd2e…5bd0bc`, `embed.js` `c3c07c8a…405aff`, `live2d/live2d.js` `2276bc44…405694`, `version.json` `6b6c3eb3…932b5f`, `README.md` `ef9d522d…e0cb3b` (every file was checked against the delivered folder when it was copied) |
| Licence note | `apps/ios/Sources/ShannonAppCore/Live2D/NOTICE.txt` |

`ShannonBodyTests.testTheEmbedPageIsBundledAsAFolderWithItsFilesInPlace` checks that the files are in the
bundle with their relative paths and pins `modelUpdatedAt` and `version`; her figure in Talk's dialogue display (「向き合う」; and the
Mac's body sheet) shows the loaded page's `modelUpdatedAt` in a debug build started with `-ShannonPreviewBodyStats`.

## Updating the page

The folder is generated output. Never edit a file in it, and never replace one file: `assets.js` (the
model) and `embed.js` (poses, hit regions, timing) belong together.

1. Build the page in `shannon-desktop` (`npm run sync-model` when the model changed, then `npm run build`).
2. Delete `apps/ios/Sources/ShannonAppCore/Live2D/embed/` and copy the whole new `dist/embed/` in its place.
3. Update the table above and the pinned `modelUpdatedAt` and `version` in `ShannonBodyTests` from the new `version.json`.
4. Read the new `README.md` of the folder for changes to `window.shannonBody` or the posted messages, and
   follow them in `ShannonLive2DProtocol.swift`.
5. `swift test --package-path apps/ios`, then look at her figure in Talk's dialogue display on a device in both layouts.

The Cubism Core (`embed/live2d/live2dcubismcore.min.js`) is Live2D's proprietary redistributable code. It
stays inside the folder as delivered and is not copied anywhere else in the repository.

## How the apps use it

- `ShannonLive2DStage` owns the only web view. Of the screens that show her, the one with the highest
  priority shows it (the Mac's body sheet, then the voice call, then Talk's dialogue display, then the small
  figure of an empty Talk; among equals the one that appeared last. On the iPhone her figure lives in the
  dialogue display since A6: the body screen was folded into it); every other place her figure stands shows the
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
- Loading: the page reports `loading { progress }`, shown under her figure as a percentage. A page that
  sends no message at all for 40 foreground seconds, or is not `ready` after 90, is reloaded. A lost WebGL context is
  mended by the page itself (`contextLost` → `contextRestored`, after which the app says the layout, the
  calm and the pause again); the app reloads only on `error` (including
  `code: contextLost`, after the page gave up), on a failed load, or when the page's process ended. One
  automatic reload a minute, and a page that failed twice without once becoming ready is shown as failed under
  her figure with 「もう一度読み込む」, with the Waterlight Eye in its place.
- No network: navigation is limited to the bundled folder, and a content rule list blocks `http(s)`,
  `ws(s)` and `ftp` (one rule per scheme). If the rule list does not compile, the page is not loaded at all.
- Framing: the square figures (voice call, empty Talk) and 上半身 of the large figure (Talk's dialogue display, the Mac's body sheet) use
  `setLayout({ mode: 'bust', fit: 'contain' })`; 全身 uses `full`.
- `ShannonBodyAttachment` passes what the app already knows to the page: the reply's face → `express`,
  the voice turn's emotion → `expressEmotion`, the `/v1/state` mood → `setMood`, text and call phases →
  `setPhase` (a call that is connecting or has failed is not idle, so a touch asks for no words then), the
  played speech level → `setMouthLevel` (a tap on the player node, installed only while the Live2D form is
  in use), and her own-time activity → `setPresence`. What she is doing in her own time comes from the
  owner's activity record: it is refreshed every 30 seconds while her Live2D figure is in Talk's dialogue display and otherwise as old as the
  app's last read of that record.
- Touch, the part that was touched, and her voice: `docs/body-contract.md`, "A body that only feels touch".

## Her eyes alone (`setBody`)

- The owner chooses the body in 設定 › すがた › 体 (iPhone and the Mac's settings), in Talk's display options
  (the long press of the display button) and in the Mac's body sheet. It is a per-device setting
  (`ShannonLive2DBody`, key `shannon.body.live2d-body`) with a meaning only in the Live2D form; the default is 人の姿.
- The page is started in the chosen body (`embed.html?body=eyes`, `ShannonLive2DStagePolicy.pageURL`), so that her
  eyes alone never load the character first. The stage follows a later change of the setting by itself, once, at the
  moment it is made (`UserDefaults.didChangeNotification`, `ShannonLive2DStage+Body.swift`), wherever it is made and
  whether or not a figure is on screen; a page kept alive with no screen showing her has switched before she is seen.
- One switch at a time (`ShannonLive2DBodyPolicy.request`): a body the page has not shown yet is loaded while the other
  stays, and the page says `body` when it switched. While a switch is under way nothing else is asked for, so the
  page never loads a model twice (each holds a large texture); a choice made meanwhile is asked for when `body`
  arrives. The pending request is forgotten on `body`, `ready` and a release (a reload). `ready` carries `bodies` and
  `body`: if the shown body and the chosen one differ, the stage asks then. Faces, mood and phase carry over in the
  page; after a switch the app closes the character's mouth and says the layout and the calm again
  (`ShannonLive2DBodyPolicy.commandsAfterSwitch`).
- `bodies`: before the page is loaded, the bundled page's (`version.json` lists `model-eyes/`); after `ready`, the
  page's own (none named means the character only). A body the page does not have is never asked for, its choice is
  shown as 人の姿, and 体 is not offered.
- A switch that fails: the page reports `error` without a code, which goes through `recover()` like any other error.
  The page is reloaded in the chosen body, unless another automatic reload happened within the last 60 seconds or the
  page failed twice without becoming ready; then her figure is shown as failed with 「もう一度読み込む」 and the
  Waterlight Eye stands in.
- With her eyes alone the page ignores `setMouthLevel`, `play` and `setIdle`, and `setLayout` uses only `scale` and the
  offsets. The app sends no mouth level and no gesture then. Because the page's own calm does not reach the eyes, an
  idle figure is paused into a still picture under Reduce Motion (after five seconds) as a page without that calm
  would be; Low Power Mode is as before.
- 映し方 (全身／上半身) is disabled in 設定 › すがた and the Mac's sheet, and not offered in Talk's display options, while
  her eyes alone are chosen; 位置を戻す and two-finger size and place still work.
- Touch: a short tap on or near the eyes is `touch` and `askReaction` with `type: 'poke'`, `region: 'face'`, and goes
  the way of any poke on her face. There is no stroking, tickling, holding hands or `tap`; the explanation in
  設定 › すがた says so for her eyes alone.
- The desktop's 「小さくしたときは、目だけにする」 (below 60% of her size) is a feature of the desktop's window. The apps have
  no window for her whose size the owner sets, so it is not offered there (`body.small-eyes` in the feature matrix).
