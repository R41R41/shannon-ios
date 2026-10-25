# 聴き流しと対話モード（2026-10-26）

ライ氏の案（`shannon-unified-voice-listening-proposal.md`、2026-10-25）を、照らし合わせで分かったずれを直して作ったもの。ライ氏の選択（2026-10-26、選択肢）:

- 聴き流しの文字起こしは **Windows も Discord も Groq whisper-large-v3-turbo**。鍵（`GROQ_API_KEY`）と利用の上限は頭にだけ置く。
- 名前なしの発話への返事は **持ち主が一人の時だけ広く**（質問・頼みなら Jev が判定して答える）。ほかの人がいる時は 10/21 の決まり（名前か、話して 20 秒以内）のまま。
- Windows の対話中の文字起こしは **gpt-live-transcribe**。
- Discord の 🎤 投稿は **返事をした発話だけ**。

**状態（2026-10-26）**: 作っただけで、本番には入れていない（Groq の課金プランがまだ受け付けられていないため、ライ氏の指示）。テストと実機での確かめも、していない。branch は 3 つとも `codex/shannon/listening`。

## 流れ

```
Windows（耳: 聞く）                                   Discord（VC にいる間）
  マイク 16 kHz → 聞き分け役（Silero VAD）               受信（話者ごと、600 ms の無音で区切る）
  → 声の区切りを発話にまとめる（0.8 s の無音か 15 s）      → WAV 16 kHz
  → 0.45 s 未満・手元の書き起こしで言葉なし → 送らない
  → 名前だけ（「シャノン」）→ そのまま通話
  → POST /v1/voice/listen ─────┐                     → POST /v1/platform/voice/transcribe
                                ▼                                ▼
                    頭: Listening（Groq + 共有の上限 ListenUsage）
                                │                                │
                    AddressedJudge（同じ判定）                 POST /v1/platform/voice/turn（addressOf が同じ判定）
                                │                                │
                  respond → 文を最初の番にして通話           respond → 🎤 を投稿して返事
                  quiet → 何も残さない                     quiet → 投稿しない（文脈に 90 s だけ）
```

対話モード（Windows の通話）: 鍵を頼む時に `manualTurns: true` を送ると、頭は `gpt-live-transcribe` を区切り無し（`turn_detection: null`）で作り、`turnDetection: 'manual'` を返す。Windows は聞き分け役の声の区切りで、話している間の音だけを送り（前 0.5 秒を足す）、声が止んで 0.3 秒で `input_audio_buffer.commit`、窓へ `heard-start` / `heard-stop` を渡す（`electron/manualTurns.ts`）。無音 30 秒で通話を切り、聴き流しに戻る。gpt-live-transcribe が断られたら、頭は今までの mini（サービスの区切り）で作り、1 時間は live を頼まない。

## 頭の窓口

- `POST /v1/voice/listen`（端末の認証）: `{ audio: base64 WAV(16 kHz mono, ≤30 s), shannonSpokeMsAgo?, lastLine?, guest?, speaking? }` → `{ heard, respond, reason?, text?(respond の時だけ), sttMs, judgeMs?, usage, limited?, degraded? }`。503 `LISTEN_NOT_CONFIGURED`（鍵なし）。`services/api/src/surfaces/voice/listenRoute.ts`。
- `POST /v1/platform/voice/transcribe`（プラットフォームの認証）: `{ audio, durationMs, speakerId? }` → `{ status: ok|empty|hallucination|limited|error, text?, sttMs }`。`platformVoiceRoute.ts`。
- 上限（`listenUsage.ts`、Windows と Discord で共有、UTC の日、`listen-usage.json` に件数だけ）: 1 分 18 回・1 日 1,800 回・1 時間 6,600 秒・1 日 25,000 秒（Groq Developer プランの基本 20 / 2,000 / 7,200 / 28,800 の少し下。アカウントの画面が正）。上限で `limited` を返し、Windows は次の UTC の日まで手元の名前の待ち受けに戻る。別の有料の文字起こしへは切り替えない。
- 判定（`addressed.ts`）: 名前なし・20 秒の外で、持ち主が一人なら Jev に聞く（`unnamed`）。`target = shannon` かつ確率 0.6 以上だけ yes（名前ありより厳しい）。Jev が答えない時は返事をしない。質問の版は `addressed.v2`。
- 設定: `GROQ_API_KEY`、`SHANNON_VOICE_LISTEN_MAX_*`、`SHANNON_VOICE_CALL_LIVE_MODEL`（既定 gpt-live-transcribe、`none` で使わない）、`SHANNON_VOICE_CALL_LIVE_USD_PER_MINUTE`（0.017）。新しいスイッチは無い。

## 確かめたこと（2026-10-26）

- gpt-live-transcribe: 文字起こしのセッションで、区切り（semantic / server）を付けると 400「Turn detection is not supported for this transcription model」。`null` なら作れる。話している最中から delta が届く。commit から確定の文まで約 0.5 秒。課金は送った音の秒数（4.5 秒の声＋2 秒の無音 → 7 秒）。40 秒何も送らなくても切れず、続けて文字にできた。空の commit はエラー（`input_audio_buffer_commit_empty`）。
- 同じ台詞で gpt-4o-mini-transcribe（semantic_vad）は、声が止んでから確定まで約 2.0 秒（区切りの待ちを含む。1 回だけの比較）。
- Groq の料金・上限は公式の資料で読んだだけ。鍵が無いので、Groq の速さと精度は測っていない。

## 見込み（反映の前に、測って答え合わせする）

| | 今 | 新しい作り（見込み） | 根拠 |
|---|---|---|---|
| 聴き流しの文字起こしの費用 | なし（名前の待ち受けは PC の中） | 1 日 300 発話なら約 $0.03（月 $1）。上限 1,800 発話でも 1 日 $0.20 | Groq $0.04/時、1 回最低 10 秒。発話の数は未測定 |
| Discord の文字起こし | whisper-1（$0.006/分、鍵なしの控え） | Groq（1 回最低 10 秒で、短い発話は 1 回 $0.00011） | 公式の料金 |
| 対話の文字起こしの費用 | mini $0.003/分 × 通話の全部の時間 | live $0.017/分 × 話している時間だけ | 送った秒数だけの課金を確かめた |
| 対話の 1 番の待ち（声が止んでから文が確定） | 約 2.0 秒（mini＋semantic） | 約 1.1 秒（無音 0.3＋送り足し 0.3＋確定 0.5） | 1 回だけの比較 |
| 名前なしで返事をする場面 | 0（名前か 20 秒以内だけ） | 一人の時の質問・頼み | Jev の判定。誤って返事をする割合は未測定 |
| Jev の呼び出し | 名前が聞こえた時だけ | 一人の時は、言葉のある発話ごと | 1 回約 0.2 秒（中央値） |

誤って返事をする割合と、返事をすべきなのにしない割合は、今は数字が無い。反映したら、Windows の `voice-log.jsonl` の `listen`（ok・理由・長さ。文は残さない）と頭の `addressed` の判定の記録で、1 週間の割合を出す。

## 案と違えたところ

- 対話モードの終わりは、案どおり 30 秒（それまでの Windows は 10 秒）。
- Discord には gpt-live の対話モードを作っていない。Discord は話者ごとに発話を区切って受け取るので、対話中も発話ごとの Groq のまま。話者ごとに live の接続を持つと、費用と作りが増える割に、待ちは Groq の 1 回ぶんしか縮まないため。
- Windows の聴き流しは、手元の書き起こし（ReazonSpeech）で言葉が聞こえない発話を送らない（咳・物音で Groq の回数と料金を使わない）。
- 聴き流しで「返事をする」と決まった発話は、音でなく文で通話の最初の番にする（案の「先頭を二重に送らない」）。決まってから通話がつながるまでに続けて話した発話は、音のまま送る。通話の始まりをまたいだ発話の頭は落ちることがある（1 秒未満の見込み、未測定）。
