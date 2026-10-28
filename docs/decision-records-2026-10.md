# 判断の記録（decision records、2026-10-28）

Minebot（体のあるタスク）の頭が**判断を 1 回するごと**に、モデルへ渡した入力の全部・モデルの生の出力・頭が検証と書き換えをした後に体へ送った act の形・動いていた版を、1 組として残す。
実走 45 の見直し（外部のモデルによる）で、`hist.jsonl` だけでは「原因を一番知りたい判断ほど入力の記録が欠ける」と分かったため（履歴の要約のその時点の文、その判断が読んだ live、頭が手を書き換えた後の形、動いていた版。保留で判断が中断すると何も残らない: 実走 45 の q15）。
スイッチは無い。常に有効。記録の失敗は判断を止めない（書けなければ数えて 1 度だけ警告する）。

## 何が残るか

体のあるタスク（`keepBodyTools`）のステップだけが対象。ほかのタスク（調べ物・睡眠など）と、その中の会話は残らない。

| 行 `ev` | いつ | 中身 |
| --- | --- | --- |
| `run` | そのタスクの記録を、このプロセスが初めて開いた時 | task id、頭の版（`DEPLOYED_REVISION` の先頭の語。無ければ git checkout の HEAD）、node、上限 |
| `request` | **API へ送る直前**（中断・保留でも必ず残る） | id（`d0001` 判断 / `s0001` 履歴の要約 / `p0001` 最初の計画）、時刻、task_id・step_id・step 番号 `d`（`fca_decision_metrics` の `d`）・round・試行・operation id、判断の番号 `no`、モデル、設定（max_tokens・thinking・output_config・tool_choice）、ヘッダ（beta）、system と tools と各 message への参照、版（体の接続・目録のハッシュ・体が名乗る版、プロンプトの部品のハッシュ） |
| `response` | 呼びが終わった時 | `ok` / `error` / `aborted`（理由つき）、stop_reason、生の出力 content への参照、メタ情報、usage、トークン、費用（予算と同じ単価） |
| `applied` / `discarded` / `failed` | 頭がその判断をどう扱ったか | 採用（呼びの一覧・体の古さ）、破棄（`queue_changed` / `urgent_interrupt`）、失敗（閉じたコード） |
| `call` | 道具の呼び 1 回ごと | 頭が受け取った入力（`hooks.callInput` の後）、結果（成功/失敗・コード・文）、実行しなかった印 |
| `sent` | **体へコマンドを入れた時**（`MinecraftControl.command`） | 頭が検証・書き換えをした後の形（skill・arguments・queue 封筒 `q15`・期限・接続・incident）、どの判断のどの呼びか |

「体へ送らなかった」は `sent` が無いことで分かり、理由は同じ呼びの `call.result.text`（例: `送らなかった: 前提 … を今は満たさない。体には何も送っていない`）。
act の形は 3 つ残る: モデルが書いた物（`response` の tool_use）、頭の道具が受け取った物（`call.input`）、体へ送った物（`sent.arguments`）。

秘密: API キー・bearer・各サービスのトークンの形は、部品にも行にも書く前に `[redacted]` にする（`scrubSecrets`）。要求そのものはキーを持たない。ヘッダは beta の 1 つだけ残す。
プロンプトの中身（記憶の文や会話の抜粋を含み得る）はそのまま残るので、記録は API と同じ権限の置き場にだけある。

## 置き場と大きさ

SQLite の隣、`<SHANNON_DATABASE_PATH のあるフォルダ>/decision-records/<task id>/` に、実走（タスク）ごとのフォルダ。

- `events.jsonl`: 上の行を時刻順に 1 行ずつ。
- `blobs/<id>.json.gz`: 要求と応答の部品（各 message、system、tools、出力の content）。名前は JSON の SHA-256 の先頭 20 桁。**同じ物は 1 度だけ**書く（毎回入る system と tools、再生される履歴の message は、2 回目から参照だけ）。

DB の表にしなかった理由: 新しい表は schema step になり、頭を前の版へ戻した時に `SHANNON_DATABASE_SCHEMA_TOO_NEW` で DB が開けなくなる。ファイルなら戻しても影響が無く、消すのもフォルダごとで済む。

大きさ（1 本 = 45 分・約 225 回の判断の見積り）:
- テストの実測（3 判断、system 約 9k 字・tools 約 10k 字・live 約 5k 字）: 部品 13 個 30 KB、events 9 KB。判断が 1 つ増えるごとに、部品が約 5〜8 KB（live・答え・結果。thinking の署名は圧縮できない）、events が約 3〜5 KB（message の参照が約 36 バイトずつ増える）。
- 1 本あたり約 3 MB（上限の見積りで約 5 MB）。本番の system は大きいが、1 本に 1 度しか書かない。
- 上限: 1 本 256 MB（超えたら `capped` の 1 行だけ書き、以後は書かない）、全部で 60 本または 3 GB（古い順に消す。書いている途中の本は消さない）。ディスクの空き約 37 GB に対して十分小さい。片付けは新しい本を開くたびに非同期で走り、手でも `prune` できる。

## 取り出す

台本 `services/api/scripts/decision-record.ts`（`pnpm --filter @shannon/api decision-record …`。VM では `SHANNON_DATABASE_PATH` を環境に置くか、`--dir` で記録のフォルダを指す）:

```
decision-record list                                   # 実走の一覧（判断・要約・計画・送った数・大きさ）
decision-record show --task <task id> --no 15          # 判断の番号（その実走の通し番号）
decision-record show --task <task id> --id d0015       # 要求の id
decision-record show --task <task id> --step 40        # fca_decision_metrics の d（その step の全 round）
decision-record show --task <task id> --at 2026-10-28T03:12:00+09:00   # その時刻にいた判断
decision-record show --task <task id> --item q15       # 体へ送った act の列の印から、それを出した判断
    [--format md|json] [--out <file>] [--last 12] [--signatures] [--kind summary]
decision-record prune [--max-runs N] [--max-bytes N]
```

`show` は 1 つのファイル（既定は markdown、`--format json` で JSON）にする。入力（system・tools・全 message）、出力（thinking・text・tool_use）、使用量と費用、頭の扱い、呼びごとの「モデルが書いた入力 / 頭が受け取った入力 / 体へ送った形 / 送らなかった理由」、版。外部のモデルに見せる材料はこれ。thinking の署名は長さだけにする（`--signatures` で残す）。`--last N` は古い message を省く。

## 作りの要点（変えるとき）

- 要求の記録は、モデルの client を包む `recordedClient`（`decisionRecordClient.ts`）が `messages.create` の直前に書く。送る物そのもの（キャッシュ印を付けた後）なので、記録は送った要求と**バイト単位で同じ**（`decisionRecordsStep.test.ts` が照合する）。プロンプトの文を書き換える枝は、この下流の最終の形を渡すだけで、記録の側は変わらない。
- どの task・step の物かは `decisionRecordScope.ts` の AsyncLocalStorage（`runFcaStep` が張る）で分かる。体のあるタスクだけ `record: true`。
- 呼び出す側（runner・tool round・MinecraftControl）は `decisionRecordNotes.ts` の関数だけを呼ぶ。記録器が入っていなければ何もしない。この窓は記録器を型でしか import しないので、worker の closure は広がらない（`entry-closures-v1.json` は API の `server.ts` だけ増えた）。
- 版: 頭は `DEPLOYED_REVISION`（無ければ git）。体は頭に版を名乗らないので、観測から取れる範囲（接続 id・server id・skill 目録のハッシュ・観測の中の version/revision/build/commit/dist を名前に持つ項目）を `minecraftBodyVersion.ts` が読む。体の commit と dist の版が観測に出るようになれば、そのまま記録に載る。
- 送らなかった判断の理由、破棄（`queue_changed`・`urgent_interrupt`）の印は runner が書く。印が無い要求は、採用も破棄も書かれなかったもの（再試行された失敗、プロセスの停止）。
