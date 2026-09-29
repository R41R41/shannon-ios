# Gemini / ElevenLabs TTS比較デモ

状態: 本番音声から独立した、SSHトンネル経由のプライベートデモ。
所有ブランチ: `codex/shannon/tts-compare`

## 使い方

リポジトリ直下の`Open TTS Compare.command`を開くか、次を実行する。

```sh
bash scripts/tts-compare.sh open
```

`http://127.0.0.1:4323`をブラウザで開く。Terminalを閉じるとデモも終了する。
既存のGemini設定はAzureの秘密環境ファイルから読み、キーをMacへコピーしない。
ElevenLabsのキーが環境にない場合は「ElevenLabsに接続」へ入力する。声の一覧を読み、
Voice IDを選ぶ。キーにはTTSと声一覧の読み取り権限が必要。通常v4も選べるが、会話速度の
主候補はv4 Turbo。

1回ではA、Bの順に、受信しながら再生する。3回・10回では無音で順番に生成し、
測定順を回ごとに入れ替える。結果のプレイヤーで課金なしに再試聴できる。
生成前に呼び出し件数を示す。停止は上流生成と再生予約を中断し、未完成結果を統計から除く。
片方の失敗でも成功音声は保持する。音声と結果の保存は明示的なダウンロード操作だけで行う。

## 保持するものと変更範囲

| 保持 | 追加 | 変更しない |
| --- | --- | --- |
| 現行Geminiモデル・声・演技の設定、同じ読み上げ本文 | 別画面での同条件TTS比較と段階別遅延 | iPhoneアプリ、APIサービス、会話・記憶・DB、採用声、既存Voice Lab |

対象はブラウザの運用者向け画面。主操作はA/B比較、副操作は各声の試聴と停止。
接続準備、キー不足、生成中、片側失敗、オフライン、停止、成功を文言で区別する。
狭幅・拡大時は1列、標準ラベルとキーボードフォーカス、44 px操作、Reduced Motionを保つ。
関連契約は`docs/design/screens/web/tts-compare.yaml`。

## 比較条件と限界

- 両プロバイダーの上流リクエストを同じAzureから送る。
- Geminiはアプリと同じInteractions APIのSSE、ElevenLabsはText to Dialogue WebSocket。
- 出力は24 kHz mono 16-bit PCM、共通の100 ms再生バッファ。+50 centsなどの加工は適用しない。
- 同じ本文を送る。演技指示と演技タグは画面に明示し、異なる意味が混ざらないよう確認する。
- ElevenLabsは各サンプルで新規接続する。`close_socket`が短文もflushし、`is_final`まで受信する。
  接続再利用の実測ではない。接続時間を差し引いた値をwarm実測と呼ばない。
- GeminiもサンプルごとのHTTP要求。HTTPの接続プール再利用はプロバイダー実装に従う。
- 上流の最初の音声は、AzureでTTS要求開始から最初のPCMまで。ElevenLabsでは接続を含む。
- 端末への最初の音声は、ブラウザのfetch開始から最初の音声フレームまで。
- 再生開始の推定はブラウザの予約時刻と報告された出力遅延を用いる。耳へ届く時刻の実測ではない。
- 中央値・p95は成功したサンプルだけで算出し、失敗件数を併記する。少数サンプルは参考値。
- 音声認識、Jev、文脈取得、返答生成、iPhoneのAEC・Bluetooth・割り込み品質は評価しない。

## 実行・秘密情報の境界

デモ専用ディレクトリはAzureの`/home/azureuser/shannon-tts-compare-demo`。
`127.0.0.1:4323`だけをlistenし、Nginxやsystemdへ追加しない。本番サービスを再起動しない。
実行はSSH接続に属する一時Nodeプロセス。既存のNode 24 runtimeを使い、依存追加は不要。
ローカルport競合時は`SHANNON_TTS_COMPARE_LOCAL_PORT`を変える。

ElevenLabsの入力キーはHttpOnly・SameSite=Strictのブラウザセッションに対応するサーバーの
一時メモリにのみ保持し、30分非活動で破棄する。loopback cookieが分離されるブラウザでも、
ページごとのランダムなrequest tokenで同じセッションを認証する。解除操作で即時破棄する。台本・音声・キーを
ログやファイルへ保存しない。結果JSONは本文のSHA-256を含み、本文やキーを含まない。
共有ファイルには生成音声や実際のVoice IDを証跡として保存しない。

ローカル実行は`bash scripts/tts-compare.sh serve`。必要ならignored `.env`に
`GEMINI_API_KEY`、`SHANNON_GEMINI_TTS_VOICE`、`ELEVENLABS_API_KEY`を設定する。
`.env`を共有・コミットしない。

## 検証

```sh
bash scripts/tts-compare.sh test
scripts/verify.sh fast
```

プロバイダーストリーム、取消、途中EOF、形式不正、セッション認証、host/origin、秘密値の
非露出、成功結果だけの統計は合成音声・fake upstreamで検証する。実API試聴は別検証で、
通常テストには課金対象の通信を含めない。

2026-09-30の確認:

- デモ専用テスト14件、既存の`verify.sh fast`、`git diff --check`を通過。
- Azureの実設定を使ったGeminiの声一覧取得、Chromeでの受信中再生・成功結果表示を確認。
- Geminiは`interaction.completed`かつ成功status、ElevenLabsは`is_final`が届くまで
  完了扱いにしない。Geminiの途中EOF・未完成statusとElevenLabsの途中closeをテストした。
- ダーク表示とアクセシビリティツリーを確認。ライト表示、狭幅、VoiceOverの実操作は未検証。
- SSH終了後に専用プロセスが終了し、再起動できることを確認。
- ElevenLabsの実生成はキー未設定のため未検証。速度の優劣はまだ実測していない。

公式仕様: [Realtime Text to Dialogue](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd)、
[モデル一覧](https://elevenlabs.io/docs/overview/models)、
[Geminiストリーミング仕様](https://ai.google.dev/gemini-api/docs/streaming)。
