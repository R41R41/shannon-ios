---
name: edit-dedicated-files
description: 専用フォルダの文章を読んでから編集する
---

## 手順
1. 対象がPCやMacの専用フォルダであること、対象ファイルと変更目的をそろえる。Aether の同名フォルダと混同しない。複数の端末が候補なら host を確認する。
2. folder.list または folder.search で対象を見つけ、folder.read で本文を読む。続きが必要なら結果の offset を使い、全体の書換えに必要な本文が揃うまで編集しない。
3. 新規ファイルには folder.create の path と content を渡す。既存ファイルには folder.update の path と新しい全文の content を渡す。依頼外の文章や構造を維持する。
4. 成功結果を確認し、必要な箇所を folder.read で読み戻して変更目的と照合する。保存できた場所と内容を簡潔に伝える。

## 補助
道具は folder.list / folder.search / folder.read / folder.create / folder.update。登録済みで起動中の端末と、選択された専用フォルダが必要。
folder.update は全文置換。部分文字列を全文のつもりで渡さず、架空の append や版番号引数も足さない。現在の書込上限を超える場合は本文を切り捨てず、完成案と未保存の理由を返す。
対象の変更、競合、結果不明を検出したら再読取で状態を確かめる。削除、移動、別の場所への持出しを編集の代わりに行わない。

## 参考
運用側が現行の道具契約から作成した未導入の草案。経験から学んだ成功例ではない。利用・成功の実績は未記録。
出典: Shannon b85625ad の shannonTools.ts, shannonToolRunner.ts。完全なrevisionと出自はパックの manifest.json に記録。
