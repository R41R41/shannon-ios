---
name: propose-document-change
description: 所有者の文書への変更案を根拠つきで作る
---

## 手順
1. 依頼された変更の目的と対象を整理する。既存文書なら aether.search で候補を見つけ、実在する documentId を aether.read に渡して現在の内容を読む。
2. 変更案を作り、依頼された部分以外を維持する。追記なら追加する内容、更新なら置換後の全文を用意する。全文を読み切れないまま部分本文で置き換えようとしない。
3. aether.propose に operation と content を渡す。新規なら new-note と title、追記なら append と documentId、全体更新なら update と documentId を使う。必要に応じて reason に意図を書く。
4. 返答が成功したら提案が受け付けられたことを伝える。所有者による採用を別に確認できるまでは、文書への反映完了と言わない。

## 補助
道具は aether.search / aether.read / aether.propose。所有者の文書への提案口が接続され、現在の会話で提供されていることが前提。
現在のスキーマの文字数と操作条件に従う。上限を超える全文を切り捨てない。この手順は削除を含まない。削除が依頼の目的なら別途その対象と実行結果を扱う。
提案の受領と採用は別の状態。対象不明、権限不足、競合、結果不明では自動で重複提案せず、必要な確認または未完了の理由を返す。

## 参考
運用側が現行の道具契約から作成した未導入の草案。経験から学んだ成功例ではない。利用・成功の実績は未記録。
出典: Shannon b85625ad の shannonTools.ts, shannonToolRunner.ts。完全なrevisionと出自はパックの manifest.json に記録。
