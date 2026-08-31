# Shannon API

Azure VMで動かす専用APIとworkerの置き場所。

現在のローカル契約:

- `GET /health`
- `GET /v1/state?scopeKey=...`
- `GET /v1/conversation?scopeKey=...`
- `POST /v1/events`
- `POST /v1/chat`（`OPENAI_API_KEY`設定時はResponses API、未設定時は`local-stub`）

loopback以外で起動するときは32文字以上の`SHANNON_API_TOKEN`が必須で、全endpointが`Authorization: Bearer ...`を要求する。実機用の`lan`モードは全インターフェースではなく、MacのプライベートIPv4アドレスを1つ選んで待ち受ける。

`POST /v1/chat`は、返信本文と同時に`messageEmotion`を返す。これは取得済み共有状態と今回の入力から同じ連続感情則で投影した軽量な反応で、共有状態自体は変更しない。iOS側はこの値を投稿ごとに保存・再現する。

現在のresponse lane:

1. 確定済み共有状態を不変スナップショットとして取得
2. 最小固定プロンプト、可変状態、直近20件の会話を結合
3. 固定LLMへ送信（既定は`gpt-5.6-luna`、Web・スキルなし）
4. 返信と入力への反応表情を返す
5. LLM完了後、HTTP返却前に会話と経験をSQLiteへ短いトランザクションで追記
6. 感情更新と記憶想起をscope単位で非同期・直列実行し、共有状態を永続化

次の実装順:

1. Azure HTTPSとAether型の一時接続コード／端末トークン
2. workerを別processへ分離
3. 睡眠バッチ
4. 根拠・反例・確信度つきユーザー情報の更新
