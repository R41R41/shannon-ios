# Windows アプリ（shannon-desktop）の担当へ

2026-10-03。所有者の決定が 2 つある。

1. Syzygy ADR-0004: シャノンのアプリは 1 つの製品。実装は SwiftUI（iOS・macOS）と Electron（Windows）の 2 つのままで、1 つの仕様に従う。仕様は `shannon-ios` のリポジトリにある（`docs/product/README.md`）。Mac の Electron 版は SwiftUI の Mac アプリにまとめるので、Mac 向けの新しい機能は足さない。
2. 同じ日に、比較ページで構成・色・文字・承認・言葉を選んだ（`docs/product/information-architecture.md`）。この文書は、その結果を Windows アプリに当てはめたもの。

`shannon-desktop` のコードは、こちらからは読んだだけで、何も変えていない（2026-10-03 に VM の `~/handoff/shannon-desktop-src.zip` を読んだ）。行番号は、そのときのもの。

## 1. 受け取って使うもの

| ファイル（`shannon-ios` の中） | 中身 | 使い方 |
|---|---|---|
| `design/generated/shannon-tokens.css` | 色（ライト・ダーク）、文字、余白、角丸、動きの長さの CSS 変数 | `desk.css`・`style.css` の先頭で読み込み、自前の変数をこれに置き換える。`<html data-shannon-density="desktop">` を付けると、文字が広い画面用（本文 15）になる |
| `design/generated/shannon-tokens.ts` | 同じ値の TypeScript（`shannonTokens`、`shannonColorVar()`） | 値を計算に使う所で |
| `design/generated/shannon-strings.ja.ts` | 画面の文言（`shannonStrings`、`shannonString(key, params)`）、言い回しを変えない文の一覧（`shannonVerbatimKeys`）、決まった言葉と前の言葉の対応（`shannonDecidedWording`） | 画面に直接書いている文を、key で引くようにする |
| `docs/product/feature-matrix.json` | 機能ごとの、iOS・macOS・Windows の状態 | Windows の列が実装と合っているかを見る。機能を足す前に、行があるかを見る |

元になるファイルは `design/tokens.json`、`design/strings.ja.json`、`docs/product/feature-matrix.json`。生成したファイルは直さない。直したいときは、シャノン iOS のスレッドに知らせて、元のファイルを変える。

## 2. どこで受け渡すか

- 正本は `shannon-ios` のリポジトリ（GitHub `R41R41/shannon-ios`）。この仕様は、いまブランチ `codex/shannon/product-spec` にあり、main に入ってから受け渡す。
- 案: main に入ったら、上の 4 つのファイルと `docs/product/` を、VM の `~/handoff/shannon-product-spec/` に置く（`shannon-desktop-src.zip` を受け渡している場所と同じ）。`shannon-desktop` では `vendor/shannon-product-spec/` のような、手で直さないフォルダーに写して読み込む。**この置き方は、まだ決まっていない。** リポジトリを直接読めるなら、そのほうがよい。
- 仕様が変わったら、シャノン iOS のスレッドが、変えた key・役割・行を知らせる。写しには、写した元のコミットを書いておく。

## 3. 決まったことを Windows に当てはめる

### 3.1 色: 1 つの青を、役割ごとに分ける

`src/renderer/desk.css` の `--shannon`（`#3D8FE0`／`#5AA5EE`）は、いま 4 つの意味に使われている。意味ごとに、別の変数に向ける。

| いま `--shannon` を使っている所 | 向ける先 | 色（ライト／ダーク） |
|---|---|---|
| 主なボタン（`button.primary`）、リンク（`button.link`、`.markdown a`）、フォーカスの輪、つまみ（`accent-color`）、予算の棒 | `--shannon-color-action` | 青 `#0088FF`／`#0091FF` |
| いることの丸い印（`.presence`）、「シャノンから」の印 | `--shannon-color-intelligence` | 藍 `#5865F2` |
| 許可待ちの状態（`.status-waiting_approval`）、作業の提案の枠（`.task-proposal`）、止めるスイッチが入のときの枠（`.control-active`）、結果待ちの操作（`.ops-command-pending`、`-claimed`） | `--shannon-color-attention`（字と枠）、`--shannon-color-attention-tint`（地）、`--shannon-color-on-attention-tint`（地の上の字） | 橙 `#FF8D28`／`#FF9230` |
| 動いているサービス（`.ops-running`） | `--shannon-color-success` | 緑 `#34C759`／`#30D158` |
| カメラが「見てよい」（`.camera-pill[data-state="on"]`、`.camera-state[data-state="on"]`） | 色を付けない。`--shannon-color-text-primary` の字と、塗った印（切は `text-secondary` と、抜いた印） | 「見てよい」は、うまくいった・押せる・判断が要る、のどれでもないので、役割の色を使わない |

残りの変数:

| いまの変数 | 向ける先 | 気をつけること |
|---|---|---|
| `--bg` | `--shannon-color-canvas` | 地が `#F6F7F9`→`#FFFFFF`、ダークは `#1B1D20`→`#000000` に変わる |
| `--surface` | `--shannon-color-reading-surface`（カードとシートは `--shannon-color-elevated-surface`） | |
| `--sidebar`、`--hover`、`--code-bg` | `--shannon-color-subtle-surface` | 選んでいる行は、太字と `action` の印で表す（地の色だけに頼らない） |
| 持ち主の吹き出し（いま `--hover`） | `--shannon-color-user-message` | 灰色から、青みのうすい地へ |
| `--text`／`--muted` | `--shannon-color-text-primary`／`--shannon-color-text-secondary` | |
| `--border` | `--shannon-color-divider`（はっきりした枠は `--shannon-color-border-strong`） | |
| `--on-shannon` | `--shannon-color-on-action` | |
| `--danger`（失敗、止める、解除） | `--shannon-color-danger` | 不調のサービス（`.ops-degraded`）は `attention` ではなく `danger` のまま |
| `--attention-bg`（お知らせの帯） | `--shannon-color-attention-tint` | |
| `.presence.warning`（報告が届いていない印。いま `--danger`） | `--shannon-color-attention` | 橙の三角にする（下の 3.5） |

体の窓（`src/renderer/style.css`）: `--accent` `#2F7FE0` → `action`、`--ink`／`--ink-soft` → `text-primary`／`text-secondary`、`--surface` → `elevated-surface`。カメラのしるしは、切 = `text-secondary`、見てよい = `text-primary`、いま見ています = `danger` の赤のまま（見ている最中は、いちばん目立たせる）。触られたときの記号の色 `#FF6FA5` は体の表現なので、仕様の外。

色だけで意味を伝えない（言葉や印も付ける）のは、いまのとおり。

### 3.2 文字と大きさ: 本文 15

`<html data-shannon-density="desktop">` を付けて、次の変数を使う。

| いま | 向ける先 | 値 |
|---|---|---|
| `body` 14px／1.6 | `--shannon-font-size-body`／`--shannon-line-height-body` | 15／20 |
| `h1` 20px | `--shannon-font-size-title2` | 20 |
| `h2` 17px | `--shannon-font-size-title3` | 17 |
| Markdown の見出し 15px | `--shannon-font-size-headline` | 15（太字） |
| `h3` 13px、`.status`・`.group-label`・`.setting-note` 12px | `--shannon-font-size-subheadline`（13）、`--shannon-font-size-footnote`（12） | 補足は 12 |
| コード 13px | `--shannon-font-size-subheadline` と `--shannon-font-mono` | 13 |
| 体の窓 14／13／11.5 | `body`／`subheadline`／`caption`（11） | |
| 書体 `"Segoe UI", "Yu Gothic UI", "Meiryo"` | `--shannon-font-sans` | 同じ書体が入っている |

- 行の高さ（一覧の 1 行、ボタン）: `--shannon-size-desktop-row-height`（40）。いまのボタンは約 31px。
- 角丸: ボタン・入力欄 6 → `--shannon-radius-small`（8）。カード 8〜10 → `--shannon-radius-medium`（12）。吹き出し 12 → `--shannon-radius-large`（16）。丸い印と丸いボタンは `--shannon-radius-full`。
- 余白: 4・8・12・16・24・32（`--shannon-space-*`）。いまの 6・7・10・20 は、近い目盛りへ。
- 動き: 出入りは `--shannon-duration-standard`（220ms）、開く・たたむは `--shannon-duration-emphasized`（350ms）。`prefers-reduced-motion` では、位置が動く演出をやめる。

### 3.3 承認: 3 つの選択と、長押し

- 選べるものは 3 つ: **今回だけ許可／この作業中／許可しない**（いまの「この作業中は許可」は、ボタンの見出しを「この作業中」に）。
- **長く効く許可は、ボタンを押し続けて決める**（`--shannon-duration-hold-to-confirm` = 600ms。押している間、ボタンが左から満ちる）。対象は、「この作業中」の全部と、ネットワーク・権限の「今回だけ許可」。コマンド 1 回・ファイル変更 1 回の「今回だけ許可」と「許可しない」は、1 回押すだけ。
- **キーボード（Enter・Space）やスクリーンリーダーで押したときは、確認のダイアログを出す。** 文は iPhone と同じ（「この作業が終わるまで〈種類〉を許可しますか？」「この作業が終わるまで有効です。」、決定は「この作業中は許可」）。長押しができない人が決められなくならないようにするため。
- 視差効果を減らす設定（`prefers-reduced-motion`）では、満ちる動きの代わりに「押し続けています… N%」と文字で出す。
- **運用の操作も同じ形にする**（いまは `window.confirm`）。確認の文を出したうえで、決定のボタンを長押し（「長押しで開始」「長押しで停止」「長押しで起動」「長押しで実行」）。確認の文は一字一句そのまま（`shannonVerbatimKeys`）。
- 自律活動の「作業として始める」は、いま確認なしで始まる。Apple 側と同じく、始める前に確認を出す（まだ言葉の決定は出ていないが、動きはそろえる）。
- 「続きが必要」（持ち主の対応が要る一時停止）を足す。いまは「一時停止中」とだけ出る。

もとの決まりと、iPhone の部品の動きは `docs/DESIGN.md` の「Approval hold-to-confirm」。

### 3.4 言葉

直す場所の一覧は `docs/product/copy-differences.md` の「直す場所: Windows 側」（14 行）。要点:

作業全体 → **作業**／作業候補 → **提案**／待機中 → **準備中**／判断待ち → **許可待ち**／進行中・作業候補・終了 → **いま・これから・終了**／声の会話 → **音声会話**／話す・切る → **音声会話を開始・終了**／友人といっしょ → **友人も一緒**／シャノンがカメラで部屋を見てよい → **会話中にシャノンがカメラで見る**／見られない → **切**／返答を待っています… → **考えている…**／入力欄 → **シャノンに話す**／所有者 → **あなた**。

「自律活動」は、いまの Windows の言葉がそのまま採られた。運用の画面の語と確認の文は、もう同じ（`ops.*` の 69 件）なので、key に向けるだけ。

カメラの設定の名前は「会話中にシャノンがカメラで見る」。Windows の体は自分の時間にも見ることがあるので、そのことは説明の文に残す（所有者の決定、2026-10-03）。状態は 切／見てよい／いま見ています の 3 つ。機能の名前は「音声会話」で、1 回分を指すときは「この通話」（終わりの知らせの「通話を終えました」は、そのままでよい）。

### 3.5 入口をまとめ直す: トーク／作業／シャノン／設定

いまのサイドバー（トーク／作業全体／自律活動／書斎／運用／設定）を、4 つにする。

| いまの入口 | 行き先 |
|---|---|
| トーク | **トーク**（そのまま）。トークの一覧もサイドバーの中のまま |
| 作業全体 | **作業** |
| 自律活動 | **シャノン › 自律活動** |
| 書斎 | **シャノン › 書斎** |
| （無い） | **シャノン › ようす**（シャノンのいま）、**シャノン › 頭の中**。新しく作る |
| 運用 | **設定 › 管理 › 運用**（Apple 側の管理には 配信 と 診断 も入るが、Windows には無い） |
| 設定の「接続中の端末」 | **設定 › 管理 › 接続中の端末** |
| 設定の「デスクトップのシャノン」 | **設定 › すがた**（表示、常に手前、大きさ、体に起きたことを伝える、配信用の出力）。読み上げ・声の種類・話しかけ・友人も一緒は、設定の「声」と「話しかけ」へ |
| 設定 | **設定**（サイドバーのいちばん下） |

- **シャノン** を選ぶと、2 列目の先頭にカード（シャノンのいまの顔・気分と、待っていること = 許可待ち・感想待ち・判断待ちの数。押すと「ようす」）、その下に 頭の中／自律活動／書斎。右に中身。まず、いまある自律活動と書斎を中に入れるだけで形になる。
- **運用の印**: 入口が設定の中へ入るので、止まっていることに気づけるよう、(1) サイドバーの 設定 の行に橙の三角、(2) サイドバーの下（カメラの印の隣）に 1 行（例「運用: 報告が届いていません」「運用: YouTube が不調」）。どちらも押すと 設定 › 管理 › 運用。出すのは、不調のサービスがある・報告が 3 分届かない・サーバーに届かない・操作が失敗か期限切れ、のとき。報告が 1 度も届いていない間は印を出さず、運用の行は消さずに「運用の報告は、まだ届いていません。」と出す。操作の失敗・期限切れは、直近 1 時間の操作だけを数える（2026-10-05、[`information-architecture.md`](information-architecture.md) の 8）。
- **カメラの印**（左下）は、そのまま。言葉は「カメラ: 切／見てよい」。
- **姿（からだ）**: 「からだ」という場所は作らない。体の窓は「デスクトップに立つ体」としてそのまま。加えて、管理画面のトークで、会話の右の補助パネルに同じ姿（同じ体のページ）を出せるようにする。水の光の目（もう 1 つの姿）も作る（所有者の決定、2026-10-03）。どちらも順番は後ろでよい（4 の 9 と 11）。
- トレイのメニューは、同じ 4 つの入口への近道と「終了」だけにする（所有者の決定、2026-10-05。カメラ・声・友人も一緒の入切はトレイから外した。Windows だけの決定）。

### 3.6 そのほか

- 外観（システム・ライト・ダーク）をアプリの中で選べるようにする（`:root[data-theme="dark"]` を生成した CSS が持っている）。
- 一覧表の Windows の列（`feature-matrix.json` の `windows` の `evidence`）が、いまのコードにあるかを見て、違う所を知らせてほしい。出来れば、`shannon-desktop` のテストに「`yes`・`partial` の `evidence` のファイルがある」ことを確かめる 1 本を足す（こちらのリポジトリからは確かめられないため）。

## 4. 進める順番（Windows）

どの段でも、アプリがそのまま使える順にした。詳しくは `docs/product/roadmap.md` の「Windows 側」。

1. 色を生成した CSS に向け、青を 4 つの役割に分ける（3.1）。
2. 文字 15、行の高さ、角丸、余白（3.2）。
3. 言葉（3.4）と、運用の文を key に向ける。
4. 入口を 4 つにまとめ直す。運用を 設定 › 管理 へ移し、印を出す（3.5）。
5. 承認を 3 つの選択と長押しにする。「続きが必要」を足す（3.3）。
6. シャノン › ようす を作る。
7. シャノン › 頭の中 を作る（まず読むだけ、次に操作）。
8. トークをそろえる（検索、題名の変更、アーカイブ、コピー、送り直し、「覚えました」の行、添付）。
9. 管理画面のトークの横に姿を出す。設定 › すがた をそろえる。
10. 音声会話を管理画面からも始められるようにし、ミュート・途中での「友人も一緒」・まとめを入れる。
11. 水の光の目（もう 1 つの姿）。

## 5. これから機能を足すとき

1. 先に、シャノン iOS のスレッドへ知らせて、`feature-matrix.json` に行を足す（Windows は `planned`、ブランチの名前つき）。iPhone と Mac にいつ入れるか、または当てはまらない理由も、同じときに書く。
2. 新しい文言は `strings.ja.json` に、新しい色の役割は `tokens.json` に足してから使う。画面に文や色を直接書かない。
3. 入ったら、`evidence` のパスと読んだ日を知らせる。

デスクトップだけの機能（トレイ、配信用の出力、専用フォルダなど）は、足してよい。一覧表には `scope: desktop` で載せる。

## 6. こちらから見て、Windows にしか無いもの・Windows に無いもの

- Windows にしか無い（iPhone は作業中のブランチ、Mac は未定）: 運用、Live2D の体、触る、体が話しかける、部屋を見る、映るものの確認、見た・断った記録、文ごとに届く返事、文字の返事の読み上げ。
- Windows に無い: 頭の中（記憶・約束・人・目的・日記）、ようす、トークの検索・題名の変更・アーカイブ・添付・コピー・送り直し、「覚えました」の行、整理の提案、外観の切り替え、予定の共有、情報源、通話のミュート・写真・途中での「友人も一緒」、ほかの端末の解除、水の光の目（二つの姿の切り替え）、長押しの承認。

細かくは `docs/product/feature-matrix.md`。違っていたら、知らせてほしい。

## 7. 2026-10-05 に足した文と行（W5 の知らせを受けて）

- 文（`shannon-strings.ja.ts`）: 承認 `task.approval.session`・`confirmOnce`・`confirmSession`・`confirmSessionMessage`・`holdTarget*`・`holdHintClick`、`hold.progress`、`common.back`。運用 `ops.confirm.hold`・`ops.confirm.holdShortPress`。続きが必要 `task.status.needsOwner`・`task.needsOwner.*`・`task.waitingCount`。提案と中止の確認 `autonomy.proposal.*`・`task.cancel.*`（3 つとも、所有者の決定）。ようす `yousu.*`（iPhone の言葉。W6 で使う）。直接書いている同じ文は、key で引くように替えてほしい。
- `only: "windows"` は Windows にだけある文（Swift には出ない）。Mac にも要るようになったら、こちらで外す。
- 一覧表: `tasks.needs-owner`、`voice.wake-name`、`yousu.mood-history`、`yousu.mood-trend`（線の名前は、そのあと所有者が決めた。下の「気分の推移」）、`body.touch-parts`、`study.tools`、`folder.tools`（Windows のフォルダの仕組みを取り決めの v2 に）。読み上げは前からある `talk.reply-read-aloud` に書いた（既定は全部）。Windows の列の場所（ファイル）は、知らせに名前が無いものは、2026-10-03 に読んだ同じ画面のファイルにしてある。違っていたら知らせてほしい。
- 作らないもの: 「同調率」「判断の内訳」（`feature-matrix.json` の `notBuilding`）。
- 気分の推移（2026-10-05、所有者が選んだ）: 文 `yousu.moodTrend.*`（見出し、24時間／7日、3 本の線の名前「気分の明るさ」「元気さ」「心の開き」（決定）、読み上げの言葉、読み上げの文の形、「まだ記録がありません」、「読めませんでした」）。**言葉の分け方（調整役の決定、2026-10-05）**: 気分の明るさは 明るめ／ふつう／低め（`level.bright`）、元気さと心の開きは 高め／ふつう／低め（`level.high` の文を「高め」に変えた。key はそのまま）。本体の答えに `carryIn`（窓の前のいちばん新しい点。窓の始まりから最初の点まで保つ）が足された（`docs/mood-history-contract.md`）。窓の右端は答えの `generatedAt`。iPhone と Mac も、同じ段の線・同じ線の形（実線・長い破線・点線）で描く。ふつうの線（真ん中）は、各値のふだんの値（気分の明るさ 0、元気さ 0.30、心の開き 0.35）に置いた。Windows の描き方と違っていたら知らせてほしい。
