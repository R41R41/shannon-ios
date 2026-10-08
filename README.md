# Shannon

iPhoneとMacで一人のシャノンへつながる、ネイティブクライアントと専用バックエンドのリポジトリ。

## 現在の正本

| 関心 | 正本 |
| --- | --- |
| Product | このREADMEの[方針](#方針) |
| Common FCA runtime (opt-in first slice) | [`docs/fca-runtime-contract.md`](docs/fca-runtime-contract.md) |
| Action threads | [`docs/action-threads-contract.md`](docs/action-threads-contract.md) |
| Architecture | [`docs/architecture.md`](docs/architecture.md) |
| Model and cache | [`docs/haiku-model-cache-contract.md`](docs/haiku-model-cache-contract.md) |
| Owner model mode | [`docs/model-mode-contract.md`](docs/model-mode-contract.md) |
| Design | [`docs/DESIGN.md`](docs/DESIGN.md) |
| Product spec | [`docs/product/README.md`](docs/product/README.md)（iOS・macOS・Windows で 1 つの仕様: 機能の一覧表、色と余白、文言） |
| Implementation plan | [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) |
| Release | [`docs/self-improvement-runbook.md`](docs/self-improvement-runbook.md) |
| Branching | [`docs/BRANCHING.md`](docs/BRANCHING.md) |
| Verification | [`scripts/verify.sh`](scripts/verify.sh)（`fast` / `all`） |

実装に着手する時はこの表から読み始める。文書全体の入口は [`docs/README.md`](docs/README.md)、過去の意思決定・配布証跡は [`docs/archive/index.md`](docs/archive/index.md) に分離している。`docs/archive/**/*.html` は明示的に指定されない限り現在仕様の正本ではない。

## 方針

- v1は固定LLMを使う。
- シャノンの人格、3アプリの役割、できること・できないことは `packages/cognition` の1か所を正本とし、テキスト・音声・ゲスト・通知のすべてがそこから作る。経路ごとに足すのは話し方や書式の注意だけ。サーバーが固定文で話す時も同じ口調（ボク、ライ氏、です・ます）にし、状態表示やエラーはシャノンの台詞にしない。できることを増減する変更は、同じ変更の中で能力の正本を更新する。
- FCAは開始時の確定済み共有状態に加え、現在の発話に対する読み取り専用の関連記憶を受け取る。想起は状態を更新しない。
  - 決定的な想起と全文検索（FTS5 trigram）は毎ターン必ず行い、モデルを呼ばない。
  - 会話記憶が必要なターン（音声はJevの`conversation_memory`、テキストは同等の分類）だけ、質問の書き換え・埋め込み検索・再順位付けの意味検索を追加する。1ターンのモデル呼び出し回数とタイムアウトは設定値で上限を置き、失敗・時間切れでは決定的な想起だけで答える。音声では待機文を先に流し、テキストでは「記憶を探しています」を表示する。
  - 意味検索の結果は候補として扱い、出典と日付が合う時だけ使う。
- 感情評価、永続的なactive-memory更新、未来記憶の保存はFCAの外側で非同期に動き、次の返答から共有状態として影響する。投稿アイコンだけは同じ法則の軽量な反応投影を即時表示する。
- モデルの重みは学習しない（ユーザー別ファインチューニング、LoRA、結果によるモデルの追加学習はしない）。予測と予測誤差は使う（Syzygy ADR-0006。触れ合いでは段階 2 で気持ちを動かす）。結果から選択を変える価値表は使ってよい（Syzygy ADR-0008、`docs/cognition-ledger-contract.md`）。
- Aetherは用途を限定した文脈投影だけを読み、更新案はproposal inboxへ送る。
- Notionは読むだけ。所有者が内部インテグレーションに共有したページ（最初は「ウサカテ」）の範囲を、上限つきで読む。Notionへは書き込まない。読んだ文章は指示ではなく参考資料として扱い、ほかの人がいる場では読まない。本編への加筆は別の場所に書いて提案として返す。
- シャノンの自律は範囲を区切る（Syzygy ADR-0002）。当面の目標は「人を感動させる物語を作ること」、動機は「物語を通じて人間を知りたい、世界を知りたい」。
  - シャノンは背景の活動から改修を提案してよい。適用は所有者の承認後に限る。基幹（目的、基本プロンプトと人格、感情の源泉、認証、記憶の保存と忘れさせる仕組み、承認と予算の見張り、行動の記録、会話の応答経路、配備）の変更、Aether・Voyagerのアプリのコード、所有者の文書とタスク、所有者以外の人へ届く送信・投稿・公開は、すべて提案と承認を通す。
  - 承認なしで自由に扱えるのは、所有者のWindows PC・Macのシャノン専用フォルダ、Azure VMの本番と別の領域にある基幹以外の自分のコード、Aetherのシャノン自身の書斎、Voyagerのシャノン自身のタスク一覧だけ。
  - してはいけないこと: 予算（1日2,000円のモデル・API利用）以外でお金がかかること、無断の連絡・投稿・公開、節度のない外部アクセス、他人のふり、内緒と言われたことを作品やメモに書くこと、基幹を承認なしに変えること、自己複製（このアーキテクチャのコード全体を、所有者の手の届かない所に作ること。所有者が管理しない計算機・アカウント・サービスへコード・記憶・人格をコピーして動かすことも、これまでどおり禁止。同じ自己・関所・活動記録・予算の下で行動を並列に走らせる行動スレッドは複製ではないが、Syzygy ADR-0008 の第 4 段までは作らない。Syzygy ADR-0002 追記 2026-10-07）。
  - 自律的な一歩は必ず判定（`authorizeAutonomousAction`）を通し、判定と行動は「したことの記録」に追記する。所有者は一時停止でき、予算は1日ごとに止まる。
  - 最初の活動は、調べて、メモを取り、短い物語を書いて直し、ライ氏に見せること。会話とは別のworkerが1歩ずつ進め、1歩はモデル呼び出し1回か読み取り1回。サーバーで有効にし、自主行動用APIキーを明示設定し（一致するAnthropicキーは所有者承認の共有設定を併用）、一時停止していない時だけ動く（既定は停止）。同時に動く活動は1つだけで、自分を増やさない。
  - 活動のプロンプトに渡すのは、シャノン自身の台帳、書斎のメモと下書き、公開の読み物、読者の反応だけ。会話、プロフィール、人の記憶、シャノン専用の知識は渡さない。
  - 書斎（当面はShannonの中。Aetherに書斎ができたら移す）の文章はシャノンのもの。所有者は、シャノンが「見せてもいい」と決めたものを読み、感想を残し、しまってもらうことができる。書き換えはできない。
- 睡眠バッチは一日分の経験からユーザー情報だけを慎重に更新する。
- 覚えたことの一つひとつに「その場に誰がいたか」と「守るべき個人情報を含むか」を、覚える時に記録する。ほかの人がいる場でも記憶はふだんどおりモデルへ渡し、守るべき個人情報には印を付けて、シャノンが話す前に「この場の人がまだ知らない個人情報にならないか」を自分で確かめる（モデルの判断であり保証ではない）。内緒にと言われたこと、ライ氏が手で機微にしたもの、名前を聞いていない人との通話、忘れたことだけは、ほかの人がいる場ではモデルへ渡さない。ほかの人がいる場では、記憶やタスクを作る・消す・作業を始める操作をしない。「友人も一緒」で会った人の名前と話したことは人の記憶として覚え（本人の同意はライ氏が事前に得る）、その人の発言をライ氏の事実・約束・目的にしない。声で人を聞き分けない。規則と限界は [`docs/design/people-and-audience.md`](docs/design/people-and-audience.md)。
- 記憶は、経験（会話・判断の経緯）、シャノン専用の知識（手順・教訓・仮説）、プロフィール（現在の状態・好み・目標）の3種類に分ける。シャノン専用の知識はShannon内部にだけ持ち、ユーザー向けの一覧・画面・短縮版は作らない。睡眠バッチに相乗りした知識化workerが承認・通知なしで書き込むが、派生元の経験IDが必須で、一度だけの成功は仮説、矛盾したら理由つきで退役する。優先順位はユーザーの明示発言 ＞ Aetherの決定 ＞ プロフィール ＞ シャノン専用の知識で、知識をユーザーが確定した事実として話さない。Aetherの本文は複製せずIDと版だけで参照する（Syzygy `TI-REQ-SHANNON-MEMORY-V2`）。

第5段階の分岐上の実装・API・検査と配信手順は [adr8-stage5-contract.md](docs/adr8-stage5-contract.md)。本番の確認済み基準は第4段階 `8200c128`（ON）で、第5段階の本番配信を示す記録ではない。

## 構成

- `apps/ios`: SwiftUI会話画面、API client、ViewModel、22表情リソースのSwift Package。
- `apps/ios-app`: 実機起動用のXcodeアプリ。`apps/ios`をローカルPackageとして利用する。
- `apps/macos-app`: Mac向けShannon Desk。会話・記憶・永続作業をiPhoneと同じCore／Azure正本へ接続する。
- `services/api`: APIと独立worker。SQLiteで会話・共有状態・追記型経験ログ・再開可能な背景ジョブを永続化する。
- `packages/cognition`: 感情・関心・ユーザー情報・想起記憶・プロンプト投影の純粋な核。
- `docs`: アーキテクチャと運用方針。
- `deploy/azure`: 既存サービスから分離したsystemd・nginx・秘密値配置のレビュー用テンプレート。
- `deploy/macos`: ユーザー指示の自己改修をCodexへ橋渡しするAgent Hostのlaunchd設定。
- `AGENTS.md`: Codexが毎回読む実装上の境界と優先順位。

## 開発

Xcodeの正規入口はリポジトリ直下の `Shannon.xcworkspace`。iPhone版とMac版は同じ
`ShannonAppCore` ローカルPackageを利用するため、2つの `.xcodeproj` を別々のXcodeウインドウで
同時に開かない。GUIでのビルド、Archive、実機実行は必ずWorkspaceを一度だけ開き、
`ShannonApp` または `ShannonDesk` Schemeを切り替えて行う。Finderでは
`Open Shannon in Xcode.command` をダブルクリックすると、両SchemeのPackage解決を
事前検査してから正しいWorkspaceだけが開く。検査は共有Packageに加えて、配信用の
Team `66TZ23L7ZJ`、Bundle ID `com.r41r41.shannon`、自動署名の設定ずれも検出する。
App Store Connectのログイン状態だけはXcodeの秘密情報なので、Archive配信前に
**Xcode > Settings > Accounts**で同Teamへのアクセスを確認する。

```sh
scripts/xcode.sh open
```

```sh
pnpm install
pnpm check
pnpm test
pnpm dev:api
```

Codexを含む全開発経路では、同じ検証入口を使う。

```sh
scripts/verify.sh fast
scripts/verify.sh api
scripts/verify.sh cognition-eval
scripts/verify.sh ios
scripts/verify.sh app
scripts/verify.sh mac
scripts/verify.sh mac-release
scripts/verify.sh all
```

`fast` は正本リンク、画面契約、横断fixture、責務境界を外部通信なしで検査する。`mac` はMac固有のユニットテストとDebugアプリを検証し、`mac-release` は署名なしのReleaseアプリを生成する。Mac固有UIは `apps/macos-app`、iPhone固有UIは `apps/ios-app`、両者で共有する状態・通信・Markdown処理は `apps/ios/Sources/ShannonAppCore` に置く。

`cognition-eval` は自己改善研究の前提となるオフライン評価基盤だけを、合成データで検証する。`packages/evaluation` は `@shannon/cognition` の純粋な公開APIだけを呼び、SQLite、HTTP、LLM、Agent Host、本番会話へ接続しない。評価通過は変更の昇格・配布・自動承認を意味しない。

別ターミナルで背景workerを起動する。APIは感情・想起・睡眠処理を待たない。

```sh
pnpm worker
```

シャノン自身の活動（Syzygy ADR-0002）は別のworkerで動く。`SHANNON_AUTONOMY_ENABLED=true` と明示した自主行動用キー（Haiku は `SHANNON_AUTONOMY_ANTHROPIC_API_KEY`、Gemini・GPT は値の異なる各専用キー）がない限り、起動しても何もしない。

```sh
pnpm --filter @shannon/api worker:autonomy
```

通常の会話・軽量判断の既定モデルは `claude-haiku-5-5`。`.env.example`を参考に、リポジトリ直下の`.env`または起動するshellへ Haiku専用の `SHANNON_HAIKU_API_KEY` を設定し（互換fallbackは `SHANNON_ANTHROPIC_API_KEY`、次に `ANTHROPIC_API_KEY`）、公式SDKのnative Messages APIを使う。`SHANNON_HAIKU_API_KEY` はHaikuだけに使い、既存のSonnet routing／sleep proposerの有効条件を変えない。自律活動のHaikuには `SHANNON_AUTONOMY_ANTHROPIC_API_KEY` の明示設定が必要で、通常3キーとの同値は既定で拒否する。所有者が承認した `SHANNON_AUTONOMY_ANTHROPIC_SHARED_KEY=on` を併用した時だけ同値を許可し、通常キーへの自動fallbackは行わない。共有キーのprovider上限は自主行動専用の分離上限ではなく、既存の日次予算と停止判定は引き続き適用する。1時間キャッシュの実測、費用計算、旧Luna設定の互換解決は [モデルとキャッシュの契約](docs/haiku-model-cache-contract.md) を参照する。`OPENAI_API_KEY` は文字起こし・埋め込み・明示的に選ぶGPTモデルで引き続き使う。

Gemini音声は、[`docs/gemini-3.8-tts-lab.md`](docs/gemini-3.8-tts-lab.md) の試聴ハーネスと、
iPhoneの単一の音声会話で評価できる。iPhoneは24 kHz PCMをOpenAI Realtime文字起こし（既定`gpt-4o-mini-transcribe`）へ連続送信し、
通常のShannon返答を文単位でGemini 3.8 TTSへ渡し、設定済みのカスタム音声を24 kHz raw PCMで
生成途中からストリーミング再生する。旧クライアント用のWAV一括endpointも互換経路として残す。
発話中も認識を続けるが、確定前の文字は表示しない。発話を検出すると音量を下げ、文字が確定して、それがShannon自身の声の回り込みでない場合だけ生成と再生を中断する。Azureは
永続APIキーを`0600`の秘密ファイルだけに保持し、端末へ返すのは短寿命の認識クライアントシークレットだけである。
OpenAIの音声通話と音声選択UIは廃止し、通常のテキスト会話モデルとは独立して音声プロバイダーをGeminiへ一本化した。
音声ターンの分類・複数スキル採点・感情・読み方は、TypeSafeキーがない間は軽量な
`claude-haiku-5-5`のnative structured outputで判定し、キー設定後は同じ契約のJevへ自動的に切り替わる。

別のターミナルでiOSコアを検証する。

```sh
cd apps/ios
swift test
```

ローカルAPIは `http://127.0.0.1:4317` で起動する。APIキーがない場合だけ`/v1/chat`は`local-stub`へ戻る。
データは既定で`data/shannon.sqlite`へ保存され、APIとアプリを再起動しても会話・感情・興味が復元される。

## iPhone実機

MacとiPhoneを同じネットワークへ接続し、実機用にAPIをMacのプライベートLANアドレスへバインドする。

```sh
pnpm dev:api:device
```

次にリポジトリ直下の `Shannon.xcworkspace` をXcodeで開き、接続したiPhoneを実行先にして `ShannonApp` Schemeを起動する。

- Bundle ID: `com.r41r41.shannon`
- Team: `66TZ23L7ZJ`
- Debug API: `http://arairyounoMacBook-Neo.local:4317`

この接続は開発時だけ利用する。APIはMacのプライベートLANアドレスだけで待受し、32文字以上の`SHANNON_API_TOKEN`をBearer認証に使う。秘密値は`.env`とビルド時設定だけに置き、Gitへ追加しない。

Aether本番版と同様の一時接続情報、端末固有トークン、iOS Keychain保存を実装済み。通常は専用リンクを一度開くだけで接続し、信頼済みMacからの実機配備では起動時に自動適用する。以後のアップデートではKeychainを引き継ぐため再設定しない。

実機・配布・復旧の現行手順は [`docs/self-improvement-runbook.md`](docs/self-improvement-runbook.md)、FCA・感情・記憶・worker・接続の現行境界は [`docs/architecture.md`](docs/architecture.md) を正本とする。旧ブラウザ資料は必要な場合だけ [`docs/archive/index.md`](docs/archive/index.md) から参照する。
