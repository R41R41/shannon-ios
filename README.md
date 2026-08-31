# Shannon iOS

既存Shannonとは独立した、Shannon iOSアプリと専用バックエンドのリポジトリ。

## 方針

- v1は固定LLMを使う。
- FCAは開始時の確定済み共有状態を一度だけ受け取る。
- 感情評価と記憶想起はFCAの外側で非同期に動き、次の返答から共有状態として影響する。投稿アイコンだけは同じ法則の軽量な反応投影を即時表示する。
- 予測、Aether連携、追加学習、自動コード更新はv1に含めない。
- 睡眠バッチは一日分の経験からユーザー情報だけを慎重に更新する。

## 構成

- `apps/ios`: SwiftUI会話画面、API client、ViewModel、22表情リソースのSwift Package。
- `apps/ios-app`: 実機起動用のXcodeアプリ。`apps/ios`をローカルPackageとして利用する。
- `services/api`: ローカルAPI。SQLiteで会話・共有状態・追記型経験ログを永続化し、将来はworkerを分離してAzure VMで動かす。
- `packages/cognition`: 感情・関心・ユーザー情報・想起記憶・プロンプト投影の純粋な核。
- `docs`: アーキテクチャと運用方針。

## 開発

```sh
pnpm install
pnpm check
pnpm test
pnpm dev:api
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

Aether本番版と同様に、Shannonの本番接続はAzure上のHTTPSへ移し、一時接続コードから端末固有トークンを発行してiOS Keychainへ保存する。現在のビルド埋め込みトークンはローカル実機開発だけの暫定方式。

ブラウザで確認できる実機手順は [`docs/shannon-ios-device-runbook.html`](docs/shannon-ios-device-runbook.html) にまとめている。

FCA・感情・記憶がどう分離して動くかは [`docs/shannon-fca-v1-runtime.html`](docs/shannon-fca-v1-runtime.html) で視覚的に確認できる。
