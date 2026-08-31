# Shannon API

Azure VMで動かす専用APIとworkerの置き場所。

現在のローカル契約:

- `GET /health`
- `GET /v1/state?scopeKey=...`
- `POST /v1/events`
- `POST /v1/chat`（現在は`local-stub`。LLM未接続）

`POST /v1/chat`は、返信本文と同時に`messageEmotion`を返す。これは返信生成時の共有状態から作った不変のスナップショットで、iOS側が過去の投稿ごとの表情を再現するために使う。

次の実装順:

1. ユーザーscopeつき共有状態の永続store
2. LLM/FCA adapter
3. 経験イベントのappend-only log
4. 感情評価worker
5. 記憶想起worker
6. 睡眠バッチ
