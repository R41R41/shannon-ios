# Shannon API

Azure VMで動かす専用APIとworkerの置き場所。

最初の実装順:

1. ユーザーscopeつき共有状態の永続store
2. FCA開始時のスナップショット取得とプロンプト注入
3. 経験イベントのappend-only log
4. 感情評価worker
5. 記憶想起worker
6. 睡眠バッチ

