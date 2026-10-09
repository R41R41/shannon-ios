---
name: review-upcoming-work
description: 予定と仕事の状態を照合して整理する
---

## 手順
1. 対象期間と時差、知りたい予定や仕事の種類をそろえる。日付が曖昧で結論に影響する場合だけ確認する。
2. schedule.upcoming の range を day または week から選ぶ。返された各項目の日時を確かめ、依頼された期間に絞る。
3. Voyager の仕事を調べるときは voyager.tasks に具体的な query を渡す。シャノン自身の現在の仕事は task.list と必要な task.get で読む。両者の id や状態を混同しない。
4. 期限、確定した予定、未完了の仕事、時間が重なる箇所を簡潔にまとめる。優先順位は依頼された基準や期限に基づけ、材料が足りない箇所を明示する。

## 補助
道具は schedule.upcoming / voyager.tasks / task.list / task.get。
schedule.upcoming の day は48時間、week は8日間の取得窓であり、暦上の一日・一週間そのものではない。Voyager は検索であり、結果を全タスクの完全な一覧と扱わない。共有されていないカレンダーや仕事は見えない。
この手順は読取と整理まで。予定の追加、変更、相手への連絡が必要でも未登録の道具で実行したことにしない。接続失敗や空結果では未確認の範囲を示す。

## 参考
運用側が現行の道具契約から作成した未導入の草案。経験から学んだ成功例ではない。利用・成功の実績は未記録。
出典: Shannon b85625ad の shannonReadTools.ts, taskToolDefinitions.ts。完全なrevisionと出自はパックの manifest.json に記録。
