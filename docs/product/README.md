# Shannon の製品仕様（iOS・macOS・Windows で 1 つ）

2026-10-03。所有者の決定（Syzygy ADR-0004「Shannon のアプリは 1 つの製品」）を受けて作った。

シャノンのアプリは 3 つの画面の大きさ（iPhone・Mac・Windows）で動くが、製品は 1 つ。実装は 2 系統ある。

| 実装 | 画面 | 置き場所 | 担当 |
|---|---|---|---|
| SwiftUI | iOS と macOS | このリポジトリ（`apps/ios`、`apps/ios-app`、`apps/macos-app`） | シャノン iOS のスレッド |
| Electron | Windows（体と管理画面） | `shannon-desktop` | 体のスレッド |

この 2 つを縛る仕様が、ここにある。仕様はこのリポジトリにだけ置く。`shannon-desktop` には写しを持たず、ここで作ったファイルを受け取って使う。

Mac の Electron 版は、SwiftUI の Mac アプリにまとめる（ADR-0004）。まとめ終わるまで残してよいが、新しい機能は足さない。

## 仕様に入っているもの

| もの | 元になるファイル（ここだけを直す） | 作られるファイル |
|---|---|---|
| 機能の一覧表 | [`feature-matrix.json`](feature-matrix.json) | [`feature-matrix.md`](feature-matrix.md) |
| 色・文字・余白・角丸・動き | [`design/tokens.json`](../../design/tokens.json) | `design/generated/ShannonDesignTokens.generated.swift`、`shannon-tokens.css`、`shannon-tokens.ts` |
| 画面の文言 | [`design/strings.ja.json`](../../design/strings.ja.json) | `design/generated/ShannonStrings*.generated.swift`（大きな領域は `ShannonStrings+<領域>.generated.swift` に分ける。500 行の上限のため）、`shannon-strings.ja.ts`。`only: "windows"` の文は Swift に出さない |
| 画面の構成（2026-10-03 決定） | [`information-architecture.md`](information-architecture.md) | — |

合わせて読むもの:

- [`roadmap.md`](roadmap.md): 決まった構成に 3 つをそろえるまでの順番（Apple 側と Windows 側）。
- [`gaps.md`](gaps.md): 所有者が選ぶ前に洗い出した、3 つの画面のずれ。
- [`copy-differences.md`](copy-differences.md): アプリによって違っている文言の一覧。決まったもの（22 行）と残り（38 行）、直す場所。
- [`for-windows-app.md`](for-windows-app.md): Windows アプリの担当へ。
- [`parity-baseline.json`](parity-baseline.json): いま受け入れている遅れの一覧（下の「検証」を参照）。

サーバーとの取り決め（`docs/*-contract.md`）と、体のページ（embed）は、前から 3 つとも同じものを使っている。ここには写さない。

サーバーの自己診断（`GET /v1/ops` の `server`。使っているモデル名・人格の版・道具の数・配備の版・連携の有無。2026-10-05）はサーバーだけのもので、どの画面にもまだ出さない。一覧表は画面にあるか予定のある機能だけを載せるので、行は無い。取り決めは `docs/ops-contract.md`。

## 機能の一覧表の読み方

機能 1 つに、変わらない id（`talk.web-search` など）、領域、1 行の説明、画面ごとの状態を書く。

| 状態 | 意味 | 一緒に書くもの |
|---|---|---|
| `yes` | ある | `evidence`: その機能のコードの場所 |
| `partial` | 一部だけある | `evidence` と、足りないものを書いた `note` |
| `no` | 無い | — |
| `not_applicable` | その画面には当てはまらない | `reason`（例: CallKit の着信は iPhone の仕組み） |
| `planned` | 作業中のブランチにある | `branch`。入ったら現れるファイルを `whenMerged` に書ける |
| `unknown` | 分からない | 何を確かめていないかを書いた `note` |

`evidence` は、iOS と macOS ではこのリポジトリの中のパス（`パス#名前` と書くと、その名前がファイルにあることまで確かめる）。Windows では `shannon-desktop:パス` と、読んだ日（`read`）。Windows のコードはこのリポジトリから確かめられないので、読んだ日を必ず残す。

所有者が作らないと決めたものは `notBuilding` に書く（2026-10-05: 「同調率」「判断の内訳」）。行や文に戻ってくると検証が落ちる。

`scope` は、その機能がどの画面にあるべきかを表す。書かなければ「3 つとも」。`desktop` はデスクトップの追加（iPhone に無くてよい）、`phone` は iPhone の仕組みに乗ったもの（デスクトップに無くてよい）。デスクトップは、同じ構成のまま、より多く見せ、より多く編集できてよい。足したものも一覧表に載せる。

## 変えるときの順番

1. **まず仕様を変える。** 新しい機能は `feature-matrix.json` に行を足し、どの画面にいつ入れるかを書く（入れる前は `planned` か `no`）。色や文言は `tokens.json`、`strings.ja.json` を変える。
2. `node scripts/generate-product-spec.mjs` で、作られるファイルを作り直す。
3. 遅れが増える・減るときは、`gaps.md` に書いて所有者に決めてもらい、`node scripts/check-product-spec.mjs --accept-gaps` で `parity-baseline.json` を書き直す。
4. **それから両方の実装を変える。** Apple 側はこのリポジトリで。Windows 側は、変えたことを体のスレッドへ知らせる（[`for-windows-app.md`](for-windows-app.md)）。
5. 実装が入ったら、その画面の状態を `yes` にして、`evidence` を書く。

片方の実装だけを先に変えない。急ぐときも、少なくとも一覧表の行と、もう片方をいつ直すかは、同じ変更に入れる。

## 検証

`scripts/verify.sh fast` が `scripts/check-product-spec.mjs` を呼ぶ（単独では `scripts/verify.sh product-spec`）。次のときに落ちる。

- 一覧表の形が崩れている。id が重なっている。状態に要るもの（`evidence`、`note`、`reason`、`branch`）が無い。
- iOS か macOS が `yes`・`partial` なのに、`evidence` のファイルや名前が無くなっている。
- Apple 側の機能のフォルダー（`apps/ios/Sources/ShannonAppCore/Features/*`、`apps/macos-app/ShannonDesk/Features/*`）が、一覧表のどこからも指されていない。**一覧表に載せずに機能を足すと、ここで落ちる。**
- 遅れている所（3 つともにあるべき機能で、`yes` でも `not_applicable` でもない所）の集まりが、`parity-baseline.json` と違う。**片方にだけ機能が入ると、ここで落ちる。**
- `tokens.json` の色・余白・角丸が、いまの iOS の値（`ShannonDesignSystem.swift`）と違う。役割の名前に brand が入っている（ADR-0001）。
- `strings.ja.json` の文が、書いてある Apple 側のファイルから無くなっている。
- 作られるファイルが古い。

`planned` の所のファイルが main に入ると、落とさずに「`yes` に直すこと」という注意を出す。

Windows の実装は、このリポジトリからは確かめられない。Windows 側の検証は、体のスレッドが同じ一覧表を読んで行う（[`for-windows-app.md`](for-windows-app.md) の 4）。

## 生成したファイルを、いつアプリが使い始めるか

生成した Swift は、`design/generated/` と同じものが Swift のパッケージの `apps/ios/Sources/ShannonAppCore/DesignSystem/Generated/` にも出る（`scripts/generate-product-spec.mjs`。古ければ検証が落ちる）。**A3（2026-10-05）で、1 と 2 の色・余白・角丸は生成した値を読むようになった。** `Color.accentColor`（7 か所）は `Color.shannonActionColor`（`action` の青）にした。iPhone の強調色は同じ青なので、iPhone の見た目は変わらない。残り（OS の色、角丸 22・18・12・2、文字の大きさ、細かい余白、動きの長さ）は、目盛りに無い値で、置き換えると見た目が変わるので、まだそのまま。使い始める順番:

1. **色**: `ShannonDesignSystem.swift` の `ShannonColorTokens` の値を、`ShannonGeneratedTokens.Color` から取るようにする。生成した Swift を `apps/ios/Sources/ShannonAppCore/DesignSystem/Generated/` に出すよう、生成の出力先を足す。値は同じなので、見た目は変わらない。`ShannonPalette` の名前（`brandPresence` など）はそのままでよい。役割の対応は `tokens.json` の `swift` に書いてある。
2. **余白・角丸・動き**: `ShannonSpacing`、`ShannonShape` を生成した値に向ける。動きの長さは、直接書いてある所（下の一覧）を `ShannonGeneratedTokens.Motion` に置き換える。
3. **Mac**（**A9 で済み、2026-10-05**）: Mac のアプリは、共有のパッケージの公開の名前 `Font.shannonDesktop(_:)`（`typography.desktop`、本文 15）、`ShannonDesktopSpacing`・`ShannonDesktopRadius`（目盛り）、`ShannonDesktopMetrics.rowHeight`（40）、`Color.shannonActionColor`・`Color.shannonIntelligenceColor` を使う（`DesignSystem/ShannonDesktopDesign.swift`。`ShannonPalette` などは iOS のパッケージの中だけの名前なので、別のモジュールの Mac からは見えない）。OS の強調色は使わない。残っているのは 0〜7・18・20 の細かい余白、角丸 22、OS の `.secondary`。
4. **文言**（**A8 で済み、2026-10-05**。iPhone は運用・作業の状態・自律活動・入口の名前・ようす の文を `ShannonGeneratedStrings` から読む）: 運用の画面（両方で同じ文になっている）から始め、作業の状態の語、自律活動、と進める。`strings.ja.json` で `decided` が付いている文は、所有者が決めた言葉（`windowsNow`・`macNow` が、いま出ている違う言葉）。まだ決まっていない違いは、決まってから入れる。
5. 置き換えた所は、検証が「アプリが生成した値を読んでいる」と見て、値の照合をやめる（`ShannonGeneratedTokens`、`ShannonGeneratedStrings` という名前がファイルにあるかで見分ける）。

文字の大きさは、iPhone では Dynamic Type のテキストスタイル（`.body` など）のまま使う（`typography.scale` は、その既定の値）。Mac と Windows は、本文 15 の固定の目盛り（`typography.desktop`。所有者の決定、2026-10-03）。Swift では `ShannonGeneratedTokens.DesktopTypography`、CSS では `<html data-shannon-density="desktop">` を付けると `--shannon-font-size-*` がこの値になる。

### iOS のコードで、トークンと違う値を直接書いている所

iOS と共通のコード（`apps/ios/Sources/ShannonAppCore`）は、色の役割 `ShannonPalette` を約 220 か所、余白 `ShannonSpacing` を約 460 か所、角丸 `ShannonShape` を約 110 か所で使っている。そこから外れている所:

| 種類 | 直接書いている値 | 場所 |
|---|---|---|
| 色 | `Color.accentColor`（OS の強調色。`action` ではない） 7 か所 | `Features/Autonomy/ShannonAutonomyActivityPage.swift`、`ShannonStudyViews.swift`、`ShannonStudyPieceLink.swift`、`ShannonOrganizeSessionCard.swift` |
| 色 | `.foregroundStyle(.secondary)` など OS の色 53 か所（`textSecondary` ではない） | `Features/Autonomy/*`、`Features/Calendar/ShannonCalendarSharingSettingsSection.swift`、`Features/Look/ShannonAppLookSettingsSection.swift`、`Features/PrivateListening/ShannonPrivateListeningSettingsRows.swift`、`ShannonOrganizeSessionCard.swift`、`ShannonWorldSubscriptions.swift`、`DesignSystem/ShannonDialogueComponents.swift` |
| 色 | `Color.white`、`Color.primary.opacity(0.05)`、`.secondary.opacity(0.08)` | `ShannonAvatarView.swift`、`Features/Voice/ShannonVoiceGlowView.swift`、`Features/Autonomy/ShannonStudyPieceLink.swift`、`ShannonOrganizeSessionCard.swift` |
| 色 | 水の光の目の 12 色（顔の地、目、頬） | `ShannonWaterlightVisualTokens.swift`。キャラクターの絵としての値で、わざと別にしてある。`tokens.json` には入れていない |
| 角丸 | 22、18、12、2 | `DesignSystem/ShannonDialogueComponents.swift`（22、2）、`ShannonOrganizeSessionCard.swift`（18、12） |
| 文字 | `.font(.system(size:))` 18 か所（28、26、25、22、20、18、17、15、12） | `ShannonConnectionView.swift`、`ShannonTestFlightDeliveryView.swift`、`DesignSystem/ShannonPermissionPrimer.swift`、`DesignSystem/ShannonStatusComponents.swift`、`Features/Settings/ShannonAppearanceSettingsView.swift`、`Features/Memory/ShannonMemoryTimelineCards.swift`、`Features/AgentTasks/ShannonAgentTaskPlanTimelineView.swift`、`Features/AgentTasks/ShannonAgentTaskControls.swift`、`Features/Voice/ShannonGeminiVoiceView.swift`、`Features/Conversation/ShannonConversationView+Composer.swift`、`Features/Conversation/ShannonThreadListComponents.swift` |
| 余白 | 2（約 40 か所）、3、5、6、7、10（目盛りは 4・8・12・16・24・32） | 行の中の細かい間。あちこち |
| 動き | 0.18（4 か所）、0.24、0.3、0.45、0.4、0.25（目盛りは 0.15・0.22・0.34・0.35・0.6） | `DesignSystem/ShannonCodeBlock.swift`、`Features/AgentTasks/*`、`Features/Voice/*`、`Features/Conversation/ShannonConversationView+Composer.swift` など |

Mac のアプリ（`apps/macos-app/ShannonDesk`）は、A9（2026-10-05）で、上の 3 の公開の名前を約 230 か所で使うようになった。詳しくは [`gaps.md`](gaps.md) の 4。

## だれが何を保つか

| もの | 保つ人 |
|---|---|
| この仕様（一覧表、トークン、文言、画面の構成）と、生成と検証の道具 | シャノン iOS のスレッド |
| iOS と macOS の実装、一覧表の iOS・macOS の列 | シャノン iOS のスレッド |
| Windows の実装 | 体のスレッド |
| 一覧表の Windows の列 | 体のスレッドが中身を知らせ、シャノン iOS のスレッドが書く（読んだ日を残す） |
| 体のページ（embed）と Live2D のモデル | 体のスレッド（`shannon-desktop` の `src/embed/`、`src/acting/`） |
| 画面の構成・色・文言の決定 | 所有者 |

仕様を変えたら、相手のスレッドへ知らせる。Syzygy の `docs/operations/task-coordination.md` の決まりに従う。

## 決まったこと（2026-10-03）

所有者が比較ページで選んだ。くわしくは [`information-architecture.md`](information-architecture.md)。

- 入口は トーク／作業／シャノン／設定。シャノンの中に ようす（シャノンのいま）・頭の中・自律活動・書斎。
- iPhone はいまのシート、広い画面はサイドバー（下にトークの一覧）。
- からだは、トークの表示の 1 つ（別の場所にしない）。設定は 設定 › すがた。
- 運用は 設定 › 管理。止まっているときは、設定の入口と、いつも見える所に印。
- 色は iPhone の役割分けを 3 つとも。広い画面の文字は本文 15。
- 承認は 3 つの選択と長押しを、デスクトップでも。
- 言葉は iPhone のもの。自律の場所は「自律活動」。

## 前からある設計の文書との関係

- `docs/DESIGN.md` の「Native by default」はそのまま。ここでそろえるのは、どの領域があるか・言葉・色と余白の値・機能の有無で、画面の並べ方ではない。iPhone の画面を引き伸ばして Mac の画面にはしない。広い画面は、同じ構成を横に並べる（[`information-architecture.md`](information-architecture.md)）。
- `docs/design/semantic-role-map.v1.json` は、Syzygy の 3 アプリで共通の役割と、Shannon の色の名前の対応。`tokens.json` は、その値を 3 つの画面へ配るための定義。役割の名前は同じものを使っている（`intelligence` は Swift の `brandPresence`）。
- `docs/design/screens/<platform>/*.yaml` は、画面ごとの決まり。画面の構成を所有者が選んだあと、同じ構成に合わせて書き直す。
