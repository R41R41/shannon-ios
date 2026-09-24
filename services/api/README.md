# Shannon API

Azure VMで動かす専用APIとworkerの置き場所。

現在のローカル契約:

- `GET /health`
- `GET /v1/state?scopeKey=...`
- `GET /v1/conversation?scopeKey=...`
- `POST /v1/events`
- `POST /v1/chat`（`OPENAI_API_KEY`設定時はResponses API、未設定時は`local-stub`）
- `POST /v1/voice/transcriptions`（ペアリング済み端末のM4Aを一時的に受け取り、既定`gpt-transcribe`で日本語文字起こし）
- `POST /v1/voice/gemini/speech`（ペアリング済み端末のShannon返答を、サーバー側Gemini 3.8 TTSで24 kHz WAVへ変換）
- `GET /v1/voice/identity` / `POST /v1/voice/identity`（scopeごとの声選択を取得・保存）
- `POST /v1/voice/identity/preview`（ペアリング済み端末だけが固定日本語文を試聴。1日12回まで）
- `POST /v1/voice/realtime/calls`（保存済みの声を新しいRealtimeセッションへ適用）
- `GET /v1/world/sources`（実際に読む公開情報源、稼働・再試行状態、取得件数、取得間隔を取得。内部の障害コードは返さない）
- `GET /v1/world/subscriptions`（承認待ち候補と試読・購読状態を取得）
- `POST /v1/world/subscriptions/:id/decision`（最新`updatedAt`を指定し、候補を承認または見送り。承認後だけ7日間の試読を開始）

Worldから届いた自発メッセージには、会話履歴上の任意フィールド`sourceAttribution`として公開出典のタイトル・HTTP(S) URL・選定理由を付ける。通常会話と既存履歴はこのフィールドなしで互換性を保つ。

東京の気象庁予報は取得時に今日・明日・明後日の天気、日別最大降水確率、妥当範囲の気温へ整形し、ユーザー向け要約へ生JSONを保存しない。不正なpayloadは`WORLD_JMA_INVALID`として失敗させ、別のニュースに天気由来の説明を流用しない。

日本の一次情報は内閣府に加えてデジタル庁の公式RSSから報道発表・政策カテゴリだけを取得する。RSS/Atomはredirectごとに公開URLを再検証し、HTTP(S)リンク、相対URL、発行日時、著者、本文・feedサイズを境界検証する。公開から48時間を過ぎた記事を今日の関心や「今届いた話」として扱わない。

PubMedはESearchのIDをそのまま表示せず、同じ公式E-utilitiesのESummaryで照合できた論文だけを実タイトル、著者、掲載誌、公開日、論文固有URLつきで保存する。著作権上の扱いが異なる抄録本文は複製せず、情報源画面からNCBIの免責・著作権ポリシーを確認できる。Blueskyは公式`postView`のAT URIと著者DIDを照合し、変更され得るhandleではなくDIDから安定した投稿固有URLを作り、本文、著者、作成日時を保持する。bot以外の有効なcontent labelや自己申告ラベルが付いた投稿、不正な識別子、公開日時を検証できないレスポンスは自発表示用のカードにしない。既存DBのID-only PubMedカードとBlueskyトップURLは、各情報源の次回取得時に古い観測と一緒に除去してから安全な現行結果を保存し、通常の重複排除は維持する。

arXivは公式Atom APIを`submittedDate`の降順で1日1回だけ読み、正規のarXiv論文ID、初回投稿日、abstract URL、最大3名の著者と抄録を検証できるentryだけを保存する。API自身のerror entryや外部hostの識別子は保存しない。Hacker Newsは公式top storiesのうち、要求IDと一致する未削除・liveな`story`だけを扱い、作成時刻、著者、score、comment数を保持する。外部URLがcredential、private IP、非HTTP(S)などの場合は安全なHN discussion URLへ戻す。GitHub Releasesは`owner/repository`設定を境界検証し、同じrepositoryの公開済みreleaseだけをrelease ID、tag、公開日時、著者、release notesつきで保存する。draft、別repository、欠損日時、不正URLは除外する。公式JSON応答は取得時にも2MBで打ち切る。旧形式のHN・arXiv・GitHub行は、次回成功取得時に古い観測と一緒に置換する。

Worldのタイトル・本文・release notes・抄録はすべて非信頼の公開データとして扱う。Daily Mindのモデル境界では、候補内の命令、role変更、権限要求を指示として扱わないことを固定し、候補は話題選定の引用資料にだけ使う。

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

Gemini試験モードは、同じ文字起こしと通常のShannonテキスト会話を通した返答だけを`POST /v1/voice/gemini/speech`へ渡すターン制カスケードである。GeminiキーはAzureだけに置き、iPhoneへ返さない。既定は`gemini-3.8-flash-lite-tts`と`Leda`で、モデル、声、短いスタイル指示、timeout、10秒単価見積りを`SHANNON_GEMINI_TTS_*`で変更できる。本文は8,000文字、返却WAVは8 MiB・180秒までに制限し、音声本文やWAVは保存しない。見積りは`voice`費用レーンへ記録するが、文字起こしと通常チャットの費用はそれぞれの既存記録に分かれる。

Realtime音声は通話作成の成功単位をSQLiteへ永続予約し、日本時間の日次上限をAPI側で強制する。1回はiPhone側の上限と同じ10分として保守的に予約し、既定は1日60分。上流で通話作成に失敗した予約は取り消し、成功した予約はAPI再起動後も残る。上限は`SHANNON_VOICE_REALTIME_DAILY_MINUTES`で10〜1440分の範囲に変更でき、超過後もテキスト会話は使える。

Voice Identityは`marin`、`cedar`、`coral`の3候補だけを公開する。未選択時は`SHANNON_VOICE_REALTIME_VOICE`が候補内ならそれを使い、それ以外は`marin`へ安全に戻る。選択は`voice_identity_preferences`へscope分離して保存し、進行中の音声を差し替えず次回のRealtime call作成時に読む。試聴は既定`gpt-4o-mini-tts`へサーバー固定文だけを送り、音声・本文を永続化しない。モデルとendpointは`SHANNON_VOICE_PREVIEW_MODEL`、`SHANNON_VOICE_PREVIEW_ENDPOINT`で変更できる。
