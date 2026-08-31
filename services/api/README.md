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
6. 永続ジョブをSQLiteへ投入してHTTP応答（感情・想起は実行しない）

別processの`pnpm worker`:

1. 未投入の会話を経験ログから回収
2. scopeごとのleaseを取り、感情・想起・関心を直列更新
3. 日本時間3時以降に前日分の睡眠ジョブを重複なしで作成
4. ユーザー発言だけを構造化分析し、原文根拠が一致する情報だけを共有状態へ反映
5. 失敗は最大5回まで再試行し、process再起動時は期限切れleaseから再開

OpenAIキーがある場合、睡眠分析はResponses APIのstrict JSON Schemaを1日・scopeあたり通常1ジョブ使う。一時障害では最大5回まで再試行する。キーがない場合は明示的な「僕は〜が好き」等だけを扱うローカル規則へ退避する。
