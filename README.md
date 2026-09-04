# Shannon iOS

既存Shannonとは独立した、Shannon iOSアプリと専用バックエンドのリポジトリ。

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
- `services/api`: APIと独立worker。SQLiteで会話・共有状態・追記型経験ログ・再開可能な背景ジョブを永続化する。
- `packages/cognition`: 感情・関心・ユーザー情報・想起記憶・プロンプト投影の純粋な核。
- `docs`: アーキテクチャと運用方針。
- `deploy/azure`: 既存サービスから分離したsystemd・nginx・秘密値配置のレビュー用テンプレート。
- `deploy/macos`: ユーザー指示の自己改修をCodexへ橋渡しするAgent Hostのlaunchd設定。
- `AGENTS.md`: Codexが毎回読む実装上の境界と優先順位。

## 開発

```sh
pnpm install
pnpm check
pnpm test
pnpm dev:api
```

Codexを含む全開発経路では、同じ検証入口を使う。

```sh
scripts/verify.sh api
scripts/verify.sh ios
scripts/verify.sh app
scripts/verify.sh all
```

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

次に`apps/ios-app/ShannonApp.xcodeproj`をXcodeで開き、接続したiPhoneを実行先にして`ShannonApp`を起動する。

- Bundle ID: `com.r41r41.shannon`
- Team: `66TZ23L7ZJ`
- Debug API: `http://arairyounoMacBook-Neo.local:4317`

この接続は開発時だけ利用する。APIはMacのプライベートLANアドレスだけで待受し、32文字以上の`SHANNON_API_TOKEN`をBearer認証に使う。秘密値は`.env`とビルド時設定だけに置き、Gitへ追加しない。

Aether本番版と同様の一時接続情報、端末固有トークン、iOS Keychain保存を実装済み。通常は専用リンクを一度開くだけで接続し、信頼済みMacからの実機配備では起動時に自動適用する。以後のアップデートではKeychainを引き継ぐため再設定しない。

ブラウザで確認できる実機手順は [`docs/shannon-ios-device-runbook.html`](docs/shannon-ios-device-runbook.html) にまとめている。

FCA・感情・記憶がどう分離して動くかは [`docs/shannon-fca-v1-runtime.html`](docs/shannon-fca-v1-runtime.html) で視覚的に確認できる。

Azure接続とペアリングの安全境界は [`docs/shannon-azure-pairing.html`](docs/shannon-azure-pairing.html) にまとめている。

独立workerと睡眠バッチは [`docs/shannon-background-sleep.html`](docs/shannon-background-sleep.html) で視覚的に確認できる。

現在の実装上の正本は [`docs/architecture.md`](docs/architecture.md)、自己改修の完了条件と配備・復旧手順は [`docs/self-improvement-runbook.md`](docs/self-improvement-runbook.md) にまとめている。番号付きHTML資料は設計履歴であり、明示的に指定されない限り現在仕様より優先しない。
