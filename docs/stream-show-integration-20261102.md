# 配信進行・文脈の本番反映前確認（2026-11-02）

最新main `6f952d25` から `codex/shannon/stream-show` を作り、旧作業枝の配信関連2件（b06b6d1、90d23fd）と、今回の締めの修正・能力通知を載せた。mainへmergeしていない。本番VMへコードを反映・再起動していない。

## 変わる動作

- 挨拶→企画説明→雑談・企画→締めを、実際の再生完了と配信主の操作で進める。
- 今の章・お題・公開資料・説明済み事項・再生済みの公開会話だけを書き手へ渡す。持ち主の記憶や好感度・道具・Museには接続しない。
- 締めで、視聴者から質問を受けたことを、視聴者の体験や好みを聞いたことに置き換えない。
- `GET /v1/stream` に `capabilities: { program: true }` を追加する。古い読み手には無視できる追加項目。PCの新しい進行操作はこの通知が無い頭では開始しない。

PC側の専用口はOPの実際の完了と雲の切替を待ってから `POST /v1/stream/start` を呼ぶ。YouTube自体は開始しない。締めのspoken receiptからprogram.finishedが立った後にEDへ移り、頭の配信準備を終了する。画面やコメントが任意の道具・Minecraftの行動を操作する経路は追加しない。

## 確認

- 統合枝のAPI型検査成功。streamPure/program/routes/feelingStream/place/bench/capabilityEvidenceの7ファイル・103件成功。
- 旧作業枝でローカルの実モデル・実TTS5発言を確認。締めに未共有の体験の振り返りがあったため修正し、同じ公開履歴で締めを1回再生成。修正後は事実の範囲で終了。追加の4発言は再生成せず、保存音声でOP→EDを再検証した。
- 生成6件のusage概算合計0.0947698ドル。YouTubeの耳・本番セッション・JEVを通した試験ではない。本番8秒達成の実績として扱わない。
- WindowsでAPI全体を1回実行：668ファイル中606成功・61失敗・1skip、8461テスト中8301成功・142失敗・18skip、runner error1。POSIXのファイル権限・Unixソケット・一時ファイル削除等の失敗を含む。代表のagentHostState/mindSocket計3失敗は変更前HEADでも再現したが、全142件の原因を同一とは断定しない。
- `verify.sh fast/all` はWindows Nodeのパス区切りによるarchive index照合で停止した。全体成功とは扱わず、LinuxのAPI testsワークフローで確認する。

## 反映に必要な承認

この枝は配信の変更だけを最新mainへ載せたレビュー用。main mergeと本番VM反映・頭の再起動はユーザーの明示承認後。取りまとめ役がMinecraft側も管理しているため、反映前にユーザー経由で調整する。api.envの変更は不要。

今回、別途ユーザー承認を受けて実行した運用操作は、既存ワールドを保つための `freshWorld: false`、shannon-home起動、Minebot接続だけ。コードの本番反映とは区別する。YouTubeは開始していない。

PC側の詳細・録画・月曜引き継ぎ：`C:/Shannon/shannon-desktop-vtuber/docs/design/stream-scenes-20261031/show-01/`、`C:/Shannon/shannon-desktop/docs/plans/ai-vtuber-codex-log-20261102.md`。
