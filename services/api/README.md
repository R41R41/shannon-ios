# Shannon API

Azure VMで動かす専用APIとworkerの置き場所。

現在のローカル契約:

- `GET /health`
- `GET /v1/state?scopeKey=...`
- `GET /v1/conversation?scopeKey=...`
- `POST /v1/events`
- `POST /v1/chat`（既定HaikuはAnthropic専用のnative Messages API、明示的なGPT設定はResponses API。選択モデルのキー未設定時は`local-stub`。`stream: "sentences"`で文単位のNDJSON）
- `POST /v1/voice/transcriptions`（ペアリング済み端末のM4Aを一時的に受け取り、既定`gpt-transcribe`で日本語文字起こし）
- `POST /v1/voice/gemini/speech`（ペアリング済み端末のShannon返答を、サーバー側Gemini 3.8 TTSで24 kHz WAVへ変換）
- `POST /v1/voice/gemini/speech/stream`（同じ返答を24 kHz mono PCMとして生成中からchunked転送）
- `POST /v1/voice/gemini/cascade/sessions`（`transcriptionProvider: "openai"`でOpenAI Realtime文字起こしの短寿命クライアントシークレットを発行。省略時は旧クライアント用にGeminiトークン）
- `POST /v1/voice/gemini/cascade/delegations/stream`（音声向けLLM返答を文単位のNDJSONで転送し、最初の文からTTSを開始）
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

`POST /v1/chat`のリクエスト項目: `scopeKey`、`message`（1〜8000文字）、任意の`threadId`、`attachments`、`webSearch`、`placeLocation`、`audience`、`stream`。

`stream`は任意項目で、省略時は従来どおり1つのJSONを返す（追加前と同一の挙動）。`"sentences"`を送ると、成功したターンをNDJSON（`application/x-ndjson`）で返す: `start`（`threadId`・`turnId`・適用した`audience`）、`sentence`（`index`・`text`）を順番に、最後に`done`（`response`は`stream`なしのレスポンスと同じオブジェクト）。`sentence`の`text`を順に連結すると`done.response.reply`と1文字単位で一致する（空白・改行も保持）。それ以外の値は400（`stream is invalid`）で、モデルは呼ばない。本人だけが読むターン（`audience`が`owner`で、下記のfallbackでもない。AetherのメモやVoyagerのタスクを読んだターンも含む。Notionのページを読んだターンはfallback）は、モデルが書いている途中から文を送る。`start`に`turnId`は付かず、`done.response.turnId`で受け取る。モデルの完了後に検証で拒否された場合やストリームが失敗した場合は`error`行（`MODEL_UNAVAILABLE`）で終わり、何も保存しない。クライアントは表示した文を破棄する。`audience: "others"`、読み取りのあるターン、`SHANNON_CHAT_STREAM_EARLY=off`のときは、ターンを通常どおり完了・保存してから文に分けて送る。明示コマンド・整理・添付・Web検索・場所検索・情報源リスト付きの返答は`fallback`付きの`done`1行だけを返す。最初の文より前の失敗（400・401・429・502）は従来どおりJSONで返る。途中で切断してもモデル呼び出しは止めず、ターンは保存され、`GET /v1/conversation`で取得できる。`stream`なしのリクエストがプロバイダーへ送る内容は変わらない。契約は`docs/chat-stream-contract.md`。

`audience`は返答を見聞きできる相手を示す任意項目で、`"owner"`（省略時も同じ。追加前と同一の挙動）か`"others"`。それ以外の値は400（`audience is invalid`）で、モデルは呼ばない。レスポンスは適用した値を`audience`として返す。`"others"`は「本人だけの通話に同席者がいる」場合と同じ扱いで、同じ開示ゲートを通す。秘密・手動で機微にした記憶・それを含むスレッドの要約はモデルへ渡さず、それ以外の保護対象は`【機微:…】`付きで渡し、発話前チェックの指示を付ける。Notion・Aetherノート・Voyagerタスクは読まない。操作系コマンド（整理など）、目標の記録、作業提案、感情の保存は行わない。ターンは従来どおり本人のスレッドに保存するが`speaker: unknown`として記録し、事実・関係・約束・目標・感情を抽出しない。`"others"`のレスポンスは本人の情報を含まない: `systemPrompt`は空文字列、`thread`は返さず、`state`は`scopeKey`・`version`・`updatedAt`・`temperament`・`emotion`・`presence`（表情のみ。理由は空文字列）だけを持ち、記憶の配列は空で返す。`"owner"`のレスポンスは変わらない。サーバーは同席者を観測できないため、この項目を送らないクライアントは本人だけとして扱う。

`POST /v1/chat`は、返信本文と同時に`messageEmotion`を返す。これは取得済み共有状態と今回の入力から同じ連続感情則で投影した軽量な反応で、共有状態自体は変更しない。iOS側はこの値を投稿ごとに保存・再現する。

現在のresponse lane:

1. 確定済み共有状態を不変スナップショットとして取得
2. 最小固定プロンプト、可変状態、直近20件の会話を結合
3. 固定LLMへ送信（既定は `claude-haiku-5-5` のnative Messages API。Web・スキルは各関所とターンの選択に従う）
4. 返信と入力への反応表情を返す
5. LLM完了後、HTTP返却前に会話と経験をSQLiteへ短いトランザクションで追記
6. 永続ジョブをSQLiteへ投入してHTTP応答（感情・想起は実行しない）

別processの`pnpm worker`:

1. 未投入の会話を経験ログから回収
2. scopeごとのleaseを取り、感情・想起・関心を直列更新
3. 日本時間3時以降に前日分の睡眠ジョブを重複なしで作成
4. ユーザー発言だけを構造化分析し、原文根拠が一致する情報だけを共有状態へ反映
5. 失敗は最大5回まで再試行し、process再起動時は期限切れleaseから再開

選択モデルのキーがある場合、睡眠分析は既定Haikuのnative structured outputを1日・scopeあたり通常1ジョブ使う（明示的なGPT設定はResponses API）。一時障害では最大5回まで再試行する。キーがない場合は明示的な「僕は〜が好き」等だけを扱うローカル規則へ退避する。

音声入力は会話とは別の`voice`費用レーンで記録する。1リクエストは60秒・5 MiBまで、既定の日次上限は`$0.10`。APIは音声をファイルへ保存せず、OpenAIへの文字起こし要求が終わるとメモリから破棄する。上限は`SHANNON_VOICE_DAILY_BUDGET_USD`で変更できる。

Gemini試験モードは、同じ文字起こしと通常のShannonテキスト会話を通した返答だけをGemini TTSへ渡すターン制カスケードである。現行iPhoneは`/stream`から24 kHz mono・16-bit little-endian PCMを生成中に受け取り、100 ms単位で再生キューへ追加する。WAV一括endpointは旧クライアント互換として残す。GeminiキーはAzureだけに置き、iPhoneへ返さない。既定は`gemini-3.8-flash-lite-tts`と`Leda`で、モデル、声、短いスタイル指示、timeout、10秒単価見積りを`SHANNON_GEMINI_TTS_*`で変更できる。本文は8,000文字、音声は8 MiBまでに制限し、音声本文・PCM・WAVは保存しない。見積りは`voice`費用レーンへ記録するが、文字起こし、軽量音声ルーター、通常チャットの費用は同じレーン内でも個別callとして記録する。

設定で選ぶElevenLabs v4 Turboも同じ会話・PCM再生経路を使い、`POST /v1/voice/speech/stream`の`provider: "eleven"`で固定モデル・固定Shannonクローン声へ送る。`ELEVENLABS_API_KEY`と`SHANNON_ELEVEN_TTS_VOICE_ID`はAzureのmode-0600環境ファイルだけに置く。音声IDとキーはiPhoneへ渡さず、演技指定は角括弧の音声タグだけを許す。既存Gemini endpoint／古いクライアントは従来どおりGeminiを使用する。ElevenLabsの費用見積りは未計上と明示する。診断ログは本文・音声を保存せず、成功した各ターンについてプロバイダー、入力種別、返答処理開始から最初の文／PCM再生キュー投入まで、TTS要求から最初のPCMまでをミリ秒で記録する。再生キュー投入は実際に耳へ届く時刻ではない。

Realtime音声は通話作成の成功単位をSQLiteへ永続予約し、日本時間の日次上限をAPI側で強制する。1回はiPhone側の上限と同じ10分として保守的に予約し、既定は1日60分。上流で通話作成に失敗した予約は取り消し、成功した予約はAPI再起動後も残る。上限は`SHANNON_VOICE_REALTIME_DAILY_MINUTES`で10〜1440分の範囲に変更でき、超過後もテキスト会話は使える。

Voice Identityは`marin`、`cedar`、`coral`の3候補だけを公開する。未選択時は`SHANNON_VOICE_REALTIME_VOICE`が候補内ならそれを使い、それ以外は`marin`へ安全に戻る。選択は`voice_identity_preferences`へscope分離して保存し、進行中の音声を差し替えず次回のRealtime call作成時に読む。試聴は既定`gpt-4o-mini-tts`へサーバー固定文だけを送り、音声・本文を永続化しない。モデルとendpointは`SHANNON_VOICE_PREVIEW_MODEL`、`SHANNON_VOICE_PREVIEW_ENDPOINT`で変更できる。

## Model and cache

通常のHaikuは `SHANNON_ANTHROPIC_API_KEY`（次に `ANTHROPIC_API_KEY`）、自律活動のHaikuは会話用と値の異なる `SHANNON_AUTONOMY_ANTHROPIC_API_KEY` だけを使う。native SDK、1時間の有用な固定prefix、実測cache creation/read、費用とunknownの扱いは [haiku-model-cache-contract.md](../../docs/haiku-model-cache-contract.md)。Stage2/3 OFFの過去のbyte goldenは明示的な旧GPTモデル・価格のfixtureで検証し、通常設定のHaiku移行とは独立して維持する。

## ADR-0008 Stage5 owner routes

`SHANNON_ADR8_STAGE5=on` supplies the configured interests, existing-engine task tree, feedback and self-revision ports; OFF has no new schema/ports/tool/prompt effects. Paired owner scope and current owner-alone audience are required, including after body reading and before private response. Exact request fields, durable receipts, learning and unknown recovery are documented in [adr8-stage5-contract.md](../../docs/adr8-stage5-contract.md).

- Interests: `GET /v1/autonomy/interests`, detail, operation-ID read-back and CAS owner controls.
- Task tree: `GET /v1/agent/tasks/{id}/tree`, replan, proposal read/write and exact approval. Existing task/Host execution remains authoritative.
- Feedback: `GET|POST /v1/feedback`, server target + thread + revision + operation ID; good/bad/null. Optional reply metadata is attached after the turn and old clients may omit it.
- Self revision: `/v1/autonomy/self-rewrite/` candidate/work read, exact grant, dispatch and owner resume. These routes never create a new execution lease or permit.
