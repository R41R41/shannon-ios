# Shannon

iPhoneとMacで一人のシャノンへつながる、ネイティブクライアントと専用バックエンドのリポジトリ。

## 現在の正本

| 関心 | 正本 |
| --- | --- |
| Product | このREADMEの[方針](#方針) |
| Architecture | [`docs/architecture.md`](docs/architecture.md) |
| Design | [`docs/DESIGN.md`](docs/DESIGN.md) |
| Implementation plan | [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) |
| Release | [`docs/self-improvement-runbook.md`](docs/self-improvement-runbook.md) |
| Branching | [`docs/BRANCHING.md`](docs/BRANCHING.md) |
| Verification | [`scripts/verify.sh`](scripts/verify.sh)（`fast` / `all`） |

実装に着手する時はこの表から読み始める。文書全体の入口は [`docs/README.md`](docs/README.md)、過去の意思決定・配布証跡は [`docs/archive/index.md`](docs/archive/index.md) に分離している。`docs/archive/**/*.html` は明示的に指定されない限り現在仕様の正本ではない。

## 方針

- v1は固定LLMを使う。
- FCAは開始時の確定済み共有状態を一度だけ受け取る。
- 感情評価と記憶想起はFCAの外側で非同期に動き、次の返答から共有状態として影響する。投稿アイコンだけは同じ法則の軽量な反応投影を即時表示する。
- 予測、追加学習、ユーザー別ファインチューニングはv1に含めない。
- Aetherは用途を限定した文脈投影だけを読み、更新案はproposal inboxへ送る。
- コード変更はユーザーが開始したAgent Taskだけで行い、自律的な自己書き換えはしない。
- 睡眠バッチは一日分の経験からユーザー情報だけを慎重に更新する。

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
scripts/verify.sh ios
scripts/verify.sh app
scripts/verify.sh mac
scripts/verify.sh mac-release
scripts/verify.sh all
```

`fast` は正本リンク、画面契約、横断fixture、責務境界を外部通信なしで検査する。`mac` はMac固有のユニットテストとDebugアプリを検証し、`mac-release` は署名なしのReleaseアプリを生成する。Mac固有UIは `apps/macos-app`、iPhone固有UIは `apps/ios-app`、両者で共有する状態・通信・Markdown処理は `apps/ios/Sources/ShannonAppCore` に置く。

別ターミナルで背景workerを起動する。APIは感情・想起・睡眠処理を待たない。

```sh
pnpm worker
```

実際のLLMを使う場合は`.env.example`を参考に、リポジトリ直下の`.env`または起動するshellへ`OPENAI_API_KEY`を設定する。v1の既定モデルは`gpt-5.6-luna`。

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
