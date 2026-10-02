# Windows アプリ（shannon-desktop）の担当へ

2026-10-03。所有者の決定（Syzygy ADR-0004）: シャノンのアプリは 1 つの製品。実装は SwiftUI（iOS・macOS）と Electron（Windows）の 2 つのままで、1 つの仕様に従う。仕様は `shannon-ios` のリポジトリにある（`docs/product/README.md`）。Mac の Electron 版は SwiftUI の Mac アプリにまとめるので、Mac 向けの新しい機能は足さない。

`shannon-desktop` のコードは、こちらからは読んだだけで、何も変えていない（2026-10-03 に VM の `~/handoff/shannon-desktop-src.zip` を読んだ）。

## 1. 受け取って使うもの

| ファイル（`shannon-ios` の中） | 中身 | 使い方 |
|---|---|---|
| `design/generated/shannon-tokens.css` | 色（ライト・ダーク）、文字の大きさ、余白、角丸、動きの長さの CSS 変数（`--shannon-color-action` など） | `desk.css`・`style.css` の先頭で読み込み、自前の変数をこれに置き換える |
| `design/generated/shannon-tokens.ts` | 同じ値の TypeScript（`shannonTokens`、`shannonColorVar()`） | 値を計算に使う所（canvas など）で |
| `design/generated/shannon-strings.ja.ts` | 画面の文言（`shannonStrings`、`shannonString(key, params)`、言い回しを変えない文の一覧 `shannonVerbatimKeys`） | 画面に直接書いている文を、key で引くようにする |
| `docs/product/feature-matrix.json` | 機能ごとの、iOS・macOS・Windows の状態 | Windows の列が、いまの実装と合っているかを見る。機能を足す前に、ここに行があるかを見る |

元になるファイルは `design/tokens.json`、`design/strings.ja.json`、`docs/product/feature-matrix.json`。生成したファイルは直さない。直したいときは、シャノン iOS のスレッドに知らせて、元のファイルを変える。

## 2. どこで受け渡すか

- 正本は `shannon-ios` のリポジトリ（GitHub `R41R41/shannon-ios`）。この仕様は、いまブランチ `codex/shannon/product-spec` にあり、main に入ってから受け渡す。
- 案: main に入ったら、上の 4 つのファイルと `docs/product/` を、VM の `~/handoff/shannon-product-spec/` に置く（`shannon-desktop-src.zip` を受け渡している場所と同じ）。`shannon-desktop` では `vendor/shannon-product-spec/` のような、手で直さないフォルダーに写して読み込む。**この置き方は、まだ決まっていない。** リポジトリを直接読めるなら、そのほうがよい。
- 仕様が変わったら、シャノン iOS のスレッドが、変えた key・役割・行を知らせる。写しには、写した元のコミットを書いておく（古い写しを使っていないかを確かめるため）。

## 3. 最初にそろえること（小さい順）

1. **運用の文言を、生成した文に向ける。** `src/desk/opsText.ts` の語と確認の文は、iPhone 側と一字一句同じになっている（`ops.*` の 69 件）。置き換えても見た目は変わらない。確認の文（`shannonVerbatimKeys`）は、所有者への約束なので、言い回しを変えない。
2. **色を、生成した CSS に向ける。** `src/renderer/desk.css` の 12 個の変数の対応:

   | いまの変数 | 置き換え先 | 気をつけること |
   |---|---|---|
   | `--bg` | `--shannon-color-canvas` | ライト `#F6F7F9`→`#FFFFFF`、ダーク `#1B1D20`→`#000000`。地が変わる |
   | `--surface` | `--shannon-color-reading-surface` | |
   | `--sidebar`、`--hover`、`--code-bg` | `--shannon-color-subtle-surface` | 選んでいる行は、いまは `--hover`。選択は `action` の薄い色か太字で表す（所有者が比較ページで決める） |
   | `--text` | `--shannon-color-text-primary` | |
   | `--muted` | `--shannon-color-text-secondary` | |
   | `--border` | `--shannon-color-divider` | |
   | `--shannon`（主なボタン、リンク、フォーカスの輪） | `--shannon-color-action` | `#3D8FE0`→`#0088FF` |
   | `--shannon`（いることの丸い印） | `--shannon-color-intelligence` | 青ではなく藍 `#5865F2` |
   | `--shannon`（許可待ちの状態、予算の依頼） | `--shannon-color-attention` と `--shannon-color-attention-tint` | いまは青。持ち主の判断が要るものは橙 |
   | `--shannon`（動いているサービス） | `--shannon-color-success` | いまは青。動いている = 緑 |
   | `--on-shannon` | `--shannon-color-on-action` | |
   | `--danger` | `--shannon-color-danger` | |
   | `--attention-bg` | `--shannon-color-attention-tint` | |

   1 つの青に 4 つの意味を持たせているのを、意味ごとに分けるのが要点（ADR-0001: 1 つの色は 1 つの意味）。色だけで意味を伝えない（言葉や印も付ける）のは、いまのとおり。
   体の窓（`src/renderer/style.css`）の `--accent` `#2F7FE0`、`--ink`、`--ink-soft` も同じ対応で。触られたときの記号の色 `#FF6FA5` と、カメラの赤 `#C62828` は、体の表現なので、いまは仕様に入れていない（入れるかは相談）。
3. **作業の言葉をそろえる。** `TASK_STATUS_LABEL`（`src/desk/contracts.ts`）のうち、`作業候補`／`待機中`／`判断待ち` が Apple 側（`提案`／`準備中`／`許可待ち`）と違う。所有者が言葉を決めたら（`docs/product/copy-differences.md` の 18〜22）、`task.status.*` の key に向ける。Apple 側にある「続きが必要」（持ち主の対応が要る一時停止）を足す。
4. **一覧表の Windows の列を確かめる。** `feature-matrix.json` の `windows` の `evidence`（`shannon-desktop:` の後ろがパス）が、いまのコードにあるかを見て、違う所を知らせてほしい。出来れば、`shannon-desktop` のテストに「`yes`・`partial` の `evidence` のファイルがある」ことを確かめる 1 本を足す（こちらのリポジトリからは確かめられないため）。
5. **余白・角丸・文字。** 角丸 6 → `--shannon-radius-small`（8）、カード 8〜12 → `--shannon-radius-medium`（12）。余白は 4・8・12・16・24・32 の目盛りへ。ボタンの高さは、押せる最小の大きさ `--shannon-size-touch-target-minimum`（48）を目安に。文字の大きさは、デスクトップで小さくするかを所有者がまだ決めていないので（いま 14px、仕様の本文は 17px）、決まるまで変えない。
6. **言葉が違う所。** `docs/product/copy-differences.md` に 60 行ある。所有者が決めたものから `strings.ja.json` に入るので、入ったものを順に向ける。

そのあとの大きなもの（入口の並び、「頭の中」、トークの検索や添付）は、所有者が画面の構成を選んでから（`docs/product/information-architecture.md`）。順番の案は `docs/product/gaps.md` の 7。

## 4. これから機能を足すとき

1. 先に、シャノン iOS のスレッドへ知らせて、`feature-matrix.json` に行を足す（Windows は `planned`、ブランチの名前つき）。iPhone と Mac にいつ入れるか、または当てはまらない理由も、同じときに書く。
2. 新しい文言は `strings.ja.json` に、新しい色の役割は `tokens.json` に足してから使う。画面に文や色を直接書かない。
3. 入ったら、`evidence` のパスと読んだ日を知らせる。

デスクトップだけの機能（トレイ、配信用の出力、専用フォルダなど）は、足してよい。一覧表には `scope: desktop` で載せる。

## 5. こちらから見て、Windows にしか無いもの・Windows に無いもの

- Windows にしか無い（iPhone は作業中のブランチ、Mac は未定）: 運用、Live2D の体、触る、体が話しかける、部屋を見る、映るものの確認、見た・断った記録、文ごとに届く返事、文字の返事の読み上げ。
- Windows に無い: 頭の中（記憶・約束・人・目的・日記）、トークの検索・題名の変更・アーカイブ・添付・コピー・送り直し、「覚えました」の行、整理の提案、外観の切り替え、予定の共有、情報源、通話のミュート・写真・途中での「友人も一緒」、ほかの端末の解除、水の光の目（二つの姿の切り替え）。

細かくは `docs/product/feature-matrix.md`。違っていたら、知らせてほしい。
