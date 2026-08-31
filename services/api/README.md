# Shannon API

Azure VMで動かす専用APIとworkerの置き場所。

現在のローカル契約:

- `GET /health`
- `GET /v1/state?scopeKey=...`
- `POST /v1/events`
- `POST /v1/chat`（`OPENAI_API_KEY`設定時はResponses API、未設定時は`local-stub`）

`POST /v1/chat`は、返信本文と同時に`messageEmotion`を返す。これは返信生成時の共有状態から作った不変のスナップショットで、iOS側が過去の投稿ごとの表情を再現するために使う。

現在のresponse lane:

1. 確定済み共有状態を不変スナップショットとして取得
2. 最小固定プロンプト、可変状態、直近20件の会話を結合
3. 固定LLMへ送信（既定は`gpt-5.6-luna`、Web・スキルなし）
4. 返信と取得時の感情・表情を返す
5. 返答後に感情更新と記憶想起をscope単位で非同期・直列実行

次の実装順:

1. ユーザーscopeつき共有状態の永続store
2. 経験イベントのappend-only log
3. workerを別processへ分離
4. 睡眠バッチ
