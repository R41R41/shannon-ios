# Shannon API

Azure VMで動かす専用APIとworkerの置き場所。

現在のローカル契約:

- `GET /health`
- `GET /v1/state?scopeKey=...`
- `GET /v1/conversation?scopeKey=...`
- `POST /v1/events`
- `POST /v1/chat`（`OPENAI_API_KEY`設定時はResponses API、未設定時は`local-stub`）
- `POST /v1/voice/transcriptions`（ペアリング済み端末のM4Aを一時的に受け取り、既定`gpt-transcribe`で日本語文字起こし）
- `GET /v1/voice/identity` / `POST /v1/voice/identity`（scopeごとの声選択を取得・保存）
- `POST /v1/voice/identity/preview`（ペアリング済み端末だけが固定日本語文を試聴。1日12回まで）
- `POST /v1/voice/realtime/calls`（保存済みの声を新しいRealtimeセッションへ適用）

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

音声入力は会話とは別の`voice`費用レーンで記録する。1リクエストは60秒・5 MiBまで、既定の日次上限は`$0.10`。APIは音声をファイルへ保存せず、OpenAIへの文字起こし要求が終わるとメモリから破棄する。上限は`SHANNON_VOICE_DAILY_BUDGET_USD`で変更できる。

Voice Identityは`marin`、`cedar`、`coral`の3候補だけを公開する。未選択時は`SHANNON_VOICE_REALTIME_VOICE`が候補内ならそれを使い、それ以外は`marin`へ安全に戻る。選択は`voice_identity_preferences`へscope分離して保存し、進行中の音声を差し替えず次回のRealtime call作成時に読む。試聴は既定`gpt-4o-mini-tts`へサーバー固定文だけを送り、音声・本文を永続化しない。モデルとendpointは`SHANNON_VOICE_PREVIEW_MODEL`、`SHANNON_VOICE_PREVIEW_ENDPOINT`で変更できる。
