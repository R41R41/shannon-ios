# シャノンの体だけのページ（embed）

このフォルダーだけで動く、シャノンの体（Live2D）のページ。iOS の WKWebView などに載せて使う。
入っているのは、描画・演技（表情と気分）・しぐさ・触る・口パク。通信・声・設定・吹き出し・入力欄は無い（載せる側で作る）。
背景は透明。外への通信はしない（絵・モデル・シェーダーは `assets.js` に埋め込んである）。`file://` でも動く。

作っているのは `shannon-desktop`（Windows のデスクトップのシャノン）。`npm run build` で `dist/embed/` に出る。
ここにあるファイルは作られたものなので、直すときは `shannon-desktop` の `src/embed/` と `src/acting/` を直す。

## ファイル

| ファイル | 中身 |
|---|---|
| `embed.html` | これを開く。 |
| `embed.js` | 演技・しぐさ・触る・口パク・表情の一覧（`poses.json` `rig.json` `regions.json` を含む）。 |
| `embed.css` | 置き方。 |
| `assets.js` | モデル一式（moc3・テクスチャ 2 枚 = 4096×4096 と 2048×2048・物理・model3.json）と、SDK のシェーダー。base64。約 18MB。 |
| `live2d/live2d.js` | 描画部分（Cubism SDK for Web の Framework を取り込んだもの）。 |
| `live2d/live2dcubismcore.min.js` | Cubism Core（Live2D Proprietary Software License）。 |
| `version.json` | 版、作った時刻、モデルを取り込んだ時刻。 |

## 載せ方（WKWebView）

```swift
let folder = Bundle.main.url(forResource: "embed", withExtension: nil)!
webView.isOpaque = false
webView.backgroundColor = .clear
webView.scrollView.isScrollEnabled = false
webView.configuration.userContentController.add(handler, name: "shannonBody")
webView.loadFileURL(folder.appendingPathComponent("embed.html"), allowingReadAccessTo: folder)
```

ページの準備ができると `ready` が届く。それまでは `window.shannonBody` を呼ばない。
待っている間は `loading` が届く（`progress` 0 = ページを開いた、0.1 = 大きな `assets.js` を読み終えた、〜0.9 = モデルと絵を読み終えた。そのあと `ready`）。
`loading` が届いていれば、ページは生きている。

## 入れる側（`window.shannonBody`）

| 関数 | 内容 |
|---|---|
| `express(expression, feeling?, seconds?)` | 返事ごとの表情を出す。`expression` は本体の表情の名前（`ready` の `expressions` にある 33 種）。`feeling` は `proud` / `flustered` / `apologetic` など（あれば、そちらの顔を優先）。`seconds` は出しておく長さ（既定 8）。知らない名前は何もしない。触られた直後に呼ぶと、体が用意している「あとの顔」（つつかれてむくれる、など）の代わりに出る（`/v1/body/reactions` の `mood` と `message.expression` を、そのまま渡せる）。 |
| `expressEmotion(name, intensity?, seconds?)` | 表現感情（声の返事の `voicePlan.emotion.primary`）を顔に出す。知らない名前は、ふつうの顔。 |
| `setMood({ valence, arousal, openness })` | 気分（`/v1/state` の `emotion`）。眉・目・口のわずかな傾きと、しぐさの選び方が変わる。 |
| `setPresence({ expression, feeling, intensity, doing, awaitingReaction })` | 本体の「いま」（`/v1/body/presence`）。会話の気持ちの名残をうっすら顔に出す。`doing` が読む・書く・考えるなら、そのしぐさが増える。`awaitingReaction` が増えたら、そわそわする。 |
| `setPhase('idle' | 'thinking' | 'listening' | 'speaking')` | 話している・聞いている・考えている。`idle` 以外の間は、自分からしぐさを始めず、触られても「反応を聞く時機」を知らせない。 |
| `setMouthLevel(0〜1)` | 口の開き。声を再生している間、その音量（実効値 × 5 を 1 で頭打ち、が Windows 版の決め方）を毎コマ渡す。話し終えたら 0。 |
| `play(gesture)` | しぐさを 1 つする（`ready` の `gestures`: `wave` `peek` `bounce` `stretch` など 14 種）。 |
| `setLayout({ mode, scale, offsetX, offsetY, fit })` | どこを映すか。`mode`: `full` = 全身、`bust` = 頭の上から腰の上、`face` = 頭の上から首もと。映す範囲が、ページの高さにちょうど収まる（`full` は、細長い画面では横にも収まる大きさになり、上下の中央に立つ）。`fit: 'contain'` を渡すと、`bust` と `face` も横に収める（正方形に近い枠でも、肩や髪が切れない。入れる幅は、絵の幅の 74%（胸から上）・48%（顔））。`fit: 'height'` は高さに合わせる。`fit: null` で、映し方ごとの既定（`full` は contain、ほかは height）に戻る。`scale` はそこからの拡大率（0.2〜5）、`offsetX` / `offsetY` は位置のずれ（CSS のピクセル）。渡した項目だけ変わる。 |
| `setPaused(true / false)` | 描くのを止める・再開する。画面が見えていない間は止める（電池のため）。 |
| `setIdle({ gestures, sway })` | 何もしていない時の動きを減らす（「視差効果を減らす」の設定・省電力のとき）。`gestures: false` で、自分からしぐさを始めない（`play()` で頼んだものは、する）。`sway` は頭と体のゆっくりした揺れの大きさ（1 = ふつう、0 = 揺れない）。呼吸・まばたき・表情・口パク・触られたときの反応は、変わらない。渡した項目だけ変わる。 |
| `setFrameRate(fps)` | 1 秒あたりに描くコマ数の上限（15〜60）。0 か省略で、画面のコマ数どおり。省電力のときは 30 にすると、描く量が半分になる。 |
| `setTouchEnabled(true / false)` | 触れるようにするか。 |
| `setFrameStats(true / false)` | 1 秒あたりのコマ数を、5 秒おきに知らせるか（既定は切）。 |
| `version` | `{ version, builtAt, modelUpdatedAt }`。 |

## 出す側

`window.webkit.messageHandlers.shannonBody.postMessage(...)` で届く。この口が無い環境（ふつうのブラウザー）では、`console.log('[shannonBody]', ...)` に出る。

| `type` | 中身 |
|---|---|
| `loading` | `progress`（0〜0.9）。読み込みの進み具合。最初の `ready` までの間だけ届く。 |
| `ready` | `version` `builtAt` `modelUpdatedAt` `expressions`（表情の名前）`gestures`（しぐさの名前）`layouts`。 |
| `error` | `message`。描けなかった理由（WebGL2 が使えない、など）。`code: 'contextLost'` なら、描く面が失われて作り直せなかった（ページを読み込み直す）。 |
| `contextLost` / `contextRestored` | 描く面（WebGL）が失われた（裏へ回ったあとなどに起きる）／ページの中で作り直せた（`attempts` = 何回目で作れたか）。作り直す間（0.5 秒ほど）は、絵が消える。表情・気分・映し方は、そのまま。3 回試して駄目なら、`error`（`code: 'contextLost'`）。 |
| `touch` | 触れ合いが 1 つ終わった。`id`、`occurredAt`、`touch: { type, durationMs, strength, ongoing: false, region }`。`type` は `pet`（撫でる）`tickle`（くすぐる）`poke`（つつく）`holdHand`（手をつなぐ）。`region` は触られた部位（`head` 頭・`face` 顔・`side` 脇・`hand` 手・`body` ほかの体。撫でるのは頭、くすぐるのは脇、つつくのは顔か脇、つなぐのは手）。`/v1/body/events` には `{ id, type: touch.type, durationMs: touch.durationMs, strength: touch.strength, audience, occurredAt }` として送れる（`region` を足す欄の名前は、本体の取り決めに従う）。 |
| `askReaction` | 言葉での反応を聞きに行く時機。`id`、`occurredAt`（触れ合いが始まった時刻）、`touch: { type, durationMs, strength, ongoing, region }`。`/v1/body/reactions` に `{ scopeKey, id, touch, audience, occurredAt }` として、そのまま送れる。最中に聞いた触れ合いは、終わったときの `touch` も同じ `id` で届く。時機の決まりは Windows 版と同じ（撫で 1.5 秒・くすぐり 1.2 秒・手つなぎ 2 秒で `ongoing: true`、つつき直後、0.6 秒以上の短い撫では終わったとき。1 つの触れ合いに 1 回、45 秒に 1 回。`setPhase` が `idle` でない間は出さない）。送るかどうか（設定の入切、聞き手）は、載せる側が決める。 |
| `tap` | 体（頭・顔・脇・手でない所）を軽く叩いた。Windows 版では、入力欄を出す合図。 |
| `frameStats` | `fps`。`setFrameStats(true)` のときだけ。 |

## 触り方（指 1 本）

- 頭に指を置く・置いたまま動かす: 撫でる。
- 脇を小刻みにこする・3 回続けて叩く: くすぐる。
- 顔・脇を短く叩く: つつく。
- 手に指を置く: 手をつなぐ（考える顔で、右手の人差し指をあごに当てている間は、右手はつなげない）。
- 体のほかの所を短く叩く: `tap`。
- 2 本目の指が触れたら、指が全部離れるまで触る入力として扱わない（拡大・移動は、載せる側で）。
- 体の外（透明な所）に触れたときは、何もしない（ページの既定の動きも止めない）。
- 「つまんで運ぶ」は無い（画面の中では、窓ごと運べないため）。

## モデルを更新したとき

Windows 側で Live2D の書き出しを取り込み（`npm run sync-model` と `tools/` の道具）、`npm run build` すると、`dist/embed/` が新しくなる。
iOS へは、`dist/embed/` を丸ごと写し直す（`assets.js` にモデルが、`embed.js` に表情・当たり判定の決まりが入っているので、片方だけ写さない）。
写したものの版は、`version.json` か `ready` の `modelUpdatedAt` で分かる。

## 大きく映すとき

テクスチャは元絵の 0.77 倍で入っている（顔の幅で約 480 画素）。画面の細かい端末で `face` や `bust` にすると、
顔が 480 画素より大きく映るので、少しぼやける（描く面の高さの上限は 4096 画素。`embed.html` の `data-max-drawing-height` と `data-max-pixel-ratio`）。
