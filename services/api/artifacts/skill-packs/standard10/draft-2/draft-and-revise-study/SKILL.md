---
name: draft-and-revise-study
description: 書斎の下書きを版を残して整える
---

## 手順
1. 新しいメモか物語か、既存稿の修正かを確かめ、完成の目安を整理する。依頼が明確なら制作を進める。
2. 既存稿は study.list または study.search で実在する id を見つけ、study.read で現在の本文と版を読む。同名の候補が複数なら対象を確認する。
3. 新稿は study.create に kind、title、body を渡す。修正は study.update に id、body、changeNote を渡し、全体の書換えなら mode=replace、続きの追加なら mode=append を使う。
4. 一度に書ける量は現在提供された仕様に従う。物語を分割するときは段落と順序を保ち、append の前に既に保存された末尾を確かめる。
5. 成功結果の id と版を確認し、必要なら study.read で完成条件に関わる箇所を照合する。保存した状態と残っている作業を伝える。

## 補助
道具は study.list / study.search / study.read / study.create / study.update。会話の一回の書込上限は元の登録上限より小さい場合がある。
メモと物語では本文上限や見え方が異なる。物語の修正は新しい下書きになり、既に見せた版をそのまま置き換えるわけではない。保存だけで公開済みと言わない。
秘密、忘却対象、他の文書から無断で持ち出せない内容を新稿に残さない。結果不明なら読取で状態を確かめ、同じ append を無条件に繰り返さない。

## 参考
運用側が現行の道具契約から作成した未導入の草案。経験から学んだ成功例ではない。利用・成功の実績は未記録。
出典: Shannon b85625ad の shannonTools.ts, shannonToolSession.ts。完全なrevisionと出自はパックの manifest.json に記録。
