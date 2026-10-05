# 3 つをそろえるまでの順番

2026-10-03。決まった構成（[`information-architecture.md`](information-architecture.md)）に、iOS・macOS・Windows を合わせていく順番。1 段ずつ入れられる大きさに分けた。

- **大きさ**: S = 1 つの変更で入る（半日〜1 日）。M = いくつかのファイルにまたがる（数日）。L = 新しい仕組みが要る（1 週間以上）。目安で、見積もりではない。
- **緑になる行**: その段が入ると `yes` にできる、[`feature-matrix.md`](feature-matrix.md) の行（画面）。入れた人が、同じ変更で一覧表を直す。
- 見た目と動きは、段ごとに実機で確かめる（`docs/self-improvement-runbook.md`）。この文書を書いた時点では、どの段も作っていない。

## 決まっていること・先に決めること

| | こと | 状態 |
|---|---|---|
| D1 | 作業中のブランチの入れ方 | **決まった（2026-10-03）: 作ったとおりに入れて、すぐあとに場所を直す**（A2 のあと、A4〜A6） |
| D2 | [`information-architecture.md`](information-architecture.md) の 6 の 7 つの問い | **決まった（2026-10-03）: 7 つとも、おすすめのとおり** |
| D3 | 仕様の受け渡しの場所（[`for-windows-app.md`](for-windows-app.md) の 2） | まだ。所有者と体のスレッド |

### ブランチとの食い違い

| ブランチ | 作ってあるもの | 決定と違う所 | すること |
|---|---|---|---|
| `codex/shannon/ios-yousu` | シートに 4 つめのタイル「ようす」。開くと、シャノンのいま／運用 の切り替え。不調のときは「ようす」のタイルに印。`shannon://yousu/ops` | 運用は 設定 › 管理。ようすは「シャノン」の中で、シャノンのいまだけ。印は設定のタイルと左上のボタン | 運用の画面・モデル・文言・確認のシート・試験は、そのまま使える。変えるのは、入口（`ShannonYousuView` の切り替え、`ShannonThreadListSheet` のタイル）、印の出る場所、リンクの行き先。A4・A5 |
| `codex/shannon/two-forms` | 別の「からだ」の画面（全画面／Mac はシート）、トークのツールバーの「からだ」ボタン、設定の「からだを開く」。向き合う表示の中の姿は触れず、押すと「からだ」の画面が開く | からだはトークの表示の 1 つ。別の画面は作らない | 体のページ、舞台（`ShannonLive2DStage`）、触れたことを送る仕組み、姿の切り替え、設定の区画「すがた」は、そのまま使える。変えるのは、舞台を向き合う表示へ移すこと、ツールバーのボタンと「からだを開く」を無くすこと、映し方と触れたときの返事を設定 › すがた へ移すこと。A6 |
| `codex/shannon/incoming-call` | シャノンからの電話（設定の区画） | 食い違いは無い。設定の「話しかけ・電話」に入る | そのまま |
| `codex/shannon/text-feeling-strength` | サーバーと認知 | 画面に関わらない | そのまま |

決定（2026-10-03）: **ブランチは作ったとおりに入れて、すぐ次の段（A4〜A6）で場所を直す。** 入れる前に直すと、動いて確かめ済みのものを、確かめ直さずに組み替えることになる。入れたあとの数日、運用が「ようす」の中に、からだが別の画面にある状態になるが、機能は全部使える。

## Apple 側（このリポジトリ）

| 段 | すること | 大きさ | 先に要るもの | 緑になる行 |
|---|---|:-:|---|---|
| A1 | **Mac の言葉を直す。** 会話 → トーク、作業全体 → 作業、考えている…、シャノンの自律 → 自律活動（[`copy-differences.md`](copy-differences.md) の 10 か所。iPhone の見出し 2 か所を含む） | S | — | 行は変わらない（言葉だけ）。`strings.ja.json` の `macNow` を消せる |
| A2 | **作業中のブランチを入れて、一覧表を直す。** `ios-yousu`、`two-forms`、`incoming-call`、`text-feeling-strength` | M | D1 | iOS: `yousu.*`（3）、`ops.*`（7。場所は A5 で直す）、`body.live2d`、`body.form-switch`、`body.presence-on-body`、`body.layout`、`body.idle-gestures`、`touch.gestures`、`touch.tell-shannon`、`touch.reply-mode`、`look.activity-log`、`reach.incoming-call`、`reach.body-speaking`、`talk.feeling-strength` |
| A3 | **iPhone が、生成した色・余白・角丸を読む。** `ShannonColorTokens`、`ShannonSpacing`、`ShannonShape` の値を `ShannonGeneratedTokens` から取る。値は同じなので、見た目は変わらない | S | — | 行は変わらない。検証が「アプリが生成した値を読んでいる」に切り替わる |
| A4 | **iPhone のシートを 4 つの柱にする。** タイルを 作業／シャノン／設定 に。「シャノン」の場所を作る（先頭のカードにシャノンのいまと待っていること。押すと「ようす」。下に 頭の中／自律活動／書斎）。自律活動を「頭の中」と設定から出して、1 つの画面にまとめる | M | A2（ようす） | iOS: `structure.four-entries`、`structure.shannon-hub` |
| A5 | **運用を 設定 › 管理 へ移す。** 設定の先頭に「管理」（運用、接続中の端末、配信、診断。「接続と詳細」は無くす）。印を、設定のタイルと左上のボタンへ。`shannon://yousu/ops` の行き先を変える。ようすの切り替えを無くす | S | A2、A4 | iOS: `settings.admin`、`ops.attention-mark`、`ops.*` の場所が決定どおりになる |
| A6 | **からだを、トークの表示にたたむ。** 向き合う表示の中の姿に、そのまま触れられるようにする。表示の設定（姿、映し方、位置を戻す）を、表示の切り替えボタンのメニューに。設定 › すがた に、映し方・体に起きたことを伝える・触れたときの返事。「からだ」の画面、ツールバーのボタン、「からだを開く」を無くす | M | A2（two-forms） | iOS: `settings.figure`。`body.*` と `touch.*` の場所が決定どおりになる |
| A7 | **iPhone でカメラの状態がいつも分かる。** 向き合う表示と音声会話の上に「カメラ: 切／見てよい／いま見ています」。シートにも 1 行 | S | — | iOS: `look.always-visible-state` |
| A8 | **文言を、生成した文から読む。** 運用（もう同じ文）→ 作業の状態 → 自律活動 → 入口の名前 → ようす（`yousu.*`、2026-10-05 に足した）、の順。**済み（2026-10-05）**: iPhone の文は `ShannonGeneratedStrings` から読む（見た目は変わらない）。所有者が新しく決めた文（提案と中止の確認、`apple: new`）は、見た目が変わるので次の段で入れる。Mac だけの画面の文（`task.field.*` など）は A9 以降 | S（1 回ずつ） | A2、A5 | 行は変わらない |
| A9 | **Mac を、共通の色・余白・角丸と、本文 15 の文字にする。** OS の強調色を `action` と `intelligence` に。角丸 10 と余白 10・14 を目盛りに。文字は `DesktopTypography`。画面ごとに 1 つずつ（シェル → トーク → 作業 → 設定 → 開発）。**済み（2026-10-05）**: 余白 10→12・14→16・9→8、角丸 10→12・9→8、行の高さ 40、押せるもの = 青、シャノンがいること（「シャノンから」の印、トークの上の点）= 藍 | M | A3 | 行は変わらない（[`gaps.md`](gaps.md) の 6・7・13 が消える） |
| A10 | **Mac のサイドバーを 4 つの柱にする。** 上に トーク／作業／シャノン、下にトークの一覧、いちばん下に設定。シャノンは 2 列目に、先頭のカード（ようす）と 頭の中／自律活動／書斎。開発は作業の中へ。Release Center は「配信」という名前にして、設定 › 管理 と作業の中から開く。**済み（2026-10-05）**: 作業 の中はツールバーの 作業／開発／配信 の切り替え。⌘1〜⌘4 が 4 つの入口、⌘5 開発、⌘6 配信 | M | A4（共通の「シャノン」の画面） | macOS: `structure.four-entries`、`structure.shannon-hub`。`yousu.*`（3。共通の画面を使う） |
| A11 | **Mac の承認を 3 つの選択と長押しにする。** 「この作業中」を足す。ポインターで押し続ける。キーボードと VoiceOver は確認のダイアログ。`ShannonHoldToConfirmButton` を Mac でも使えるようにする。**済み（2026-10-05）**: 添える文と読み上げは「クリックすると確認してから決定します」 | S | — | macOS: `tasks.approval`、`tasks.hold-to-confirm` |
| A12 | **Mac に 設定 › 管理（運用）を入れる。** 印はサイドバーの設定の行と、サイドバーの下。**済み（2026-10-05）**: 設定は左に区画・右に中身。管理 = 運用・接続中の端末・配信・診断。`shannon://admin/ops` と `shannon://yousu` も Mac で開く | S | A5、A10 | macOS: `ops.*`（7）、`settings.admin`、`ops.attention-mark` |
| A13 | **Mac に通知を入れる。** 許可待ちの作業、シャノンからの話、結果。押すとその場所が開く。**済み（2026-10-05）**: Mac の中で作る通知（push の資格は使わない）。文は iPhone の push と同じ。窓が開いている間だけ | S | — | macOS: `notifications.push`、`notifications.open-target` |
| A14 | **Mac のトークと頭の中の足りない所をそろえる。** 写真の添付、地図のカード、空のトークの候補、「いま見ました」の表示、カメラの状態（サイドバーの下）、アバターの種類、設定の先頭の状態の札 | M | — | macOS: `talk.attachments`、`talk.place-map`、`talk.prompt-suggestions`、`look.app-camera`、`look.always-visible-state`、`settings.avatar-style`、`settings.profile-state`、`tasks.search-filter-pin-archive`、`tasks.notice-in-talk` |
| A15 | **Mac のトークの右に姿を出す。** 補助パネルの 3 つめ「すがた」（目次・現在地と切り替え、幅 320 から）。水の光の目と Live2D の姿（体のページ）。触れたことを伝える。設定 › すがた | M | A6、A10 | macOS: `talk.dialogue-mode`、`body.live2d`、`body.form-switch`、`body.waterlight-eye`、`body.presence-on-body`、`body.layout`、`body.idle-gestures`、`touch.gestures`、`touch.tell-shannon`、`touch.reply-mode`、`settings.figure` |
| A16 | **Mac に音声会話を入れる。** 音声の入出力（Mac の音声の仕組み）、ミュートとマイクの選択、文字でも送る、友人も一緒、通話のまとめ、作業を頼む、診断、声の種類の選択、声での入力 | L | — | macOS: `voice.conversation`、`voice.mute-and-mic`、`voice.text-in-call`、`voice.photo-and-camera-in-call`、`voice.guest-mode`、`voice.minimised-call`、`voice.call-summary`、`voice.emotion-in-call`、`voice.task-in-call`、`voice.diagnostics`、`settings.voice-provider`、`talk.dictation` |
| A17 | **デスクトップに立つ体を SwiftUI で作る。** 透過で最前面の窓に、同じ体のページ。出す・隠す、常に手前、大きさ、つまんで運ぶ、PC の様子への反応、体が話しかける、部屋をひと目見る、メニューバーのメニュー | L | A15 | macOS: `desktop.tray`、`desktop.always-on-top`、`touch.carry`、`desktop.pc-presence`、`reach.body-speaking`、`look.room-look` |
| A18 | **配信用の出力・専用フォルダ・ログイン時に開く、を Mac の SwiftUI のアプリへ。** 入ったら、Mac の Electron 版をやめる（ADR-0004） | M | A17 | macOS: `desktop.stream-output`、`desktop.folder-host`、`desktop.open-at-login` |

A1・A3・A7・A11・A13 は、ほかを待たずに入れられる。A16 と A17 は大きいので、A15 までが済んでから。

## Windows 側（`shannon-desktop`。体のスレッド）

どの段のあとでも、アプリはそのまま使える。くわしい当てはめ方は [`for-windows-app.md`](for-windows-app.md) の 3。

**W0〜W4 は済んだ（2026-10-05、Windows の担当の知らせ）。** 外観の切り替え（W13 の一部）も先に入った。そのとき決まったことは [`information-architecture.md`](information-architecture.md) の 8。

**W5 も済んだ（2026-10-05）。** 承認の 3 つの選択と長押し、運用の確認、「続きが必要」（印・枠・通知・数え方）、自律活動の提案の確認。W6（ようす）は iPhone の言葉（`yousu.*`）で作っている。決まったことは [`information-architecture.md`](information-architecture.md) の 8 の 9〜18。

| 段 | すること | 大きさ | 先に要るもの | 緑になる行 |
|---|---|:-:|---|---|
| W0 | **仕様を受け取る場所を作る。** 生成した CSS・TS と一覧表を読み込む。Windows の列の `evidence` のファイルがあることを確かめる試験を 1 本 | S | D3 | —（Windows の列を、Windows の側でも確かめられるようになる） |
| W1 | **色を生成した CSS に向け、1 つの青を 4 つの役割に分ける。** 押せるもの = 青、いること = 藍、許可待ち = 橙、動いている = 緑 | S | W0 | 行は変わらない（[`gaps.md`](gaps.md) の 6 が消える） |
| W2 | **文字を本文 15 に。行の高さ 40、角丸、余白を目盛りに** | S | W1 | 行は変わらない（[`gaps.md`](gaps.md) の 13 が消える） |
| W3 | **言葉を直す。** 作業、提案、準備中、許可待ち、いま／これから／終了、音声会話、音声会話を開始／終了、友人も一緒、会話中にシャノンがカメラで見る、切／見てよい、考えている…、シャノンに話す、あなた。運用の文は key から読む | S | W0 | 行は変わらない（`strings.ja.json` の `windowsNow` を消せる） |
| W4 | **入口を 4 つにまとめ直す。** トーク／作業／シャノン／設定。シャノンの中に、いまある自律活動と書斎。運用は 設定 › 管理 へ。設定の行とサイドバーの下に、運用の印。設定の中を 管理（運用、接続中の端末。配信と診断は Windows には無い）／すがた／声／話しかけ／カメラ／専用フォルダ／接続 に分ける | S | W3 | Windows: `structure.four-entries`、`settings.admin` |
| W5 | **承認を 3 つの選択と長押しに。** 「この作業中」、長押しの部品、キーボードのときの確認。運用の操作も同じ形に。「続きが必要」を足す。自律活動の提案は、始める前に確認 | M | W1 | Windows: `tasks.hold-to-confirm` |
| W6 | **シャノン › ようす（シャノンのいま）を作る。** 気分、残っている気持ち、していること、体のようす、待っていること、最近のできごと。シャノンの先頭のカードにも出す。サーバーの口は、`ios-yousu` のブランチの `docs/shannon-now-contract.md`（main に入ってから） | M | A2（サーバーの口）、W4 | Windows: `yousu.now`、`yousu.waiting`、`yousu.recent-events`、`structure.shannon-hub` |
| W7 | **シャノン › 頭の中 を、読むだけで作る。** いまの状態、記憶の一覧、約束、人、続けている目的、日記、使用量 | M | W4 | Windows: `memory.hub`、`memory.state-sheet`、`memory.diary-and-sleep`、`memory.usage-activity` |
| W8 | **頭の中の操作を入れる。** 記憶を直す・忘れさせる・戻す・機微にする、約束を完了にする・取り消す、人の名前を直す・まとめる、目的を止める・完了にする、知識の訂正 | M | W7、W5（取り消せない操作の確認の形） | Windows: `memory.manage`、`memory.commitments`、`memory.people`、`memory.intents`、`memory.knowledge-correction` |
| W9 | **トークをそろえる（1）。** 検索、題名の変更とアーカイブ、返事のコピーと送り直し、コードのコピーと折りたたみ、「覚えました」の行、記憶を探しているしるし、作業の知らせ、トークから作品を開く | M | W3 | Windows: `talk.thread-search`、`talk.thread-rename-archive`、`talk.copy-retry`、`talk.markdown-code`、`talk.capture-lines`、`talk.memory-recall-cue`、`tasks.notice-in-talk`、`study.open-from-talk`、`notifications.badge` |
| W10 | **トークをそろえる（2）。** 写真とファイルの添付、作った文書を開く、整理の提案、地図のカード、空のトークの候補、作業の検索・ピン留め・アーカイブ | M | W9 | Windows: `talk.attachments`、`talk.generated-artifacts`、`talk.organize-review`、`talk.place-map`、`talk.prompt-suggestions`、`tasks.search-filter-pin-archive` |
| W11 | **管理画面のトークの横に姿を出す。設定 › すがた をそろえる。** 表示の切り替え、映し方（全身・上半身）、触れたときの返事の選択。返事の横の表情。**水の光の目**（もう 1 つの姿）を Web で描く（作ることは決定済み、2026-10-03） | L（目が大きい。目を除けば M） | W4 | Windows: `talk.dialogue-mode`、`talk.feeling-face`、`body.layout`、`settings.figure`、`touch.reply-mode`、`body.form-switch`、`body.waterlight-eye` |
| W12 | **音声会話を管理画面からも始められるようにし、iPhone と同じ操作を入れる。** ミュートとマイクの選択、通話中に文字でも送る、写真、通話の途中での「友人も一緒」と終わりの「今回は残さない」、通話のまとめ、声での入力、診断。無言で終わるまでの長さは、所有者が決めた値に | L | W3 | Windows: `voice.conversation`、`voice.mute-and-mic`、`voice.text-in-call`、`voice.photo-and-camera-in-call`、`voice.guest-mode`、`voice.background-continue`、`voice.minimised-call`、`voice.call-summary`、`voice.diagnostics`、`talk.dictation` |
| W13 | **設定の足りない所。** 外観の切り替え、アプリの版、接続の状態と最後に使った時、ほかの端末の解除、作業の結果の通知 | S | W4 | Windows: `settings.appearance`、`settings.about`、`devices.status`、`devices.list`、`devices.unpair-other`、`notifications.push` |
| W14 | **予定の共有、情報源、イヤホンの登録。** Windows でどう作るか（OS の予定表、音の出口）から決める | M | — | Windows: `settings.calendar-sharing`、`settings.world-subscriptions`、`reach.earphone-registration` |

W1〜W4 は小さく、見た目と入口が先にそろう。頭の中（W7・W8）は Windows にまったく無いので、読むだけを先に入れる。

## 両方に関わること

| 段 | すること | 大きさ | 先に要るもの |
|---|---|:-:|---|
| X1 | **残りの言葉を決める**（[`copy-differences.md`](copy-differences.md) の「残り」41 行）。決まるたびに `strings.ja.json` へ | S（所有者） | — |
| X2 | **比較ページに入れなかったものを決める。** 設定の見出しと順番、音声会話が無言で終わるまでの長さ（いま iPhone 1 分・Windows 5 分）、つなぎ方（リンクとコード）、通知 | S（所有者） | — |
| X3 | **体の入切を、ほかの端末からも見られるようにする。** サーバーに口が要る（`shannon-desktop` の `docs/windows-app-features.md` の 2） | M | — |
| X4 | **運用が止まったときの通知。** サーバーが知らせる仕組みから。それまでは印だけ（決定、2026-10-03） | M | A5、W4 |
| X5 | **画面ごとの決まり（`docs/design/screens/`）を、決まった構成に書き直す** | S | A4〜A6 が入るたびに |

## 全部が済んだときの、一覧表の残り

- `not_applicable` のまま: iPhone の仕組み（電話、待機）、PC の仕組み（トレイ、専用フォルダ、配信用の出力）、Apple の配信。
- デスクトップの追加（`scope: desktop`）: 開発の作業場、会話の目次、文書の保存、メニューの近道は Mac だけ。映るものの確認とカメラの選択、表情としぐさの確認は Windows だけ。そろえるかは、そのとき決める。
- 文ごとに届く返事と、文字の返事の読み上げ（いま Windows だけ）は、この順番に入れていない。iPhone と Mac に入れるかを決めてから。
