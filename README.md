# Shannon iOS

既存Shannonとは独立した、Shannon iOSアプリと専用バックエンドのリポジトリ。

## 方針

- v1は固定LLMを使う。
- FCAは開始時の確定済み共有状態を一度だけ受け取る。
- 感情評価と記憶想起はFCAの外側で非同期に動き、次の返答から影響する。
- 予測、Aether連携、追加学習、自動コード更新はv1に含めない。
- 睡眠バッチは一日分の経験からユーザー情報だけを慎重に更新する。

## 構成

- `apps/ios`: SwiftUI会話画面、API client、ViewModel、8表情リソースのSwift Package。
- `apps/ios-app`: 実機起動用のXcodeアプリ。`apps/ios`をローカルPackageとして利用する。
- `services/api`: ローカルAPI。将来は永続化とworkerを追加してAzure VMで動かす。
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

## iPhone実機

MacとiPhoneを同じネットワークへ接続し、実機用にAPIをLAN公開する。

```sh
pnpm dev:api:device
```

次に`apps/ios-app/ShannonApp.xcodeproj`をXcodeで開き、接続したiPhoneを実行先にして`ShannonApp`を起動する。

- Bundle ID: `com.r41r41.shannon`
- Team: `66TZ23L7ZJ`
- Debug API: `http://arairyounoMacBook-Neo.local:4317`

LAN公開は開発時だけ利用する。現在のAPIは認証を持たないため、信頼できないネットワークでは起動しない。

ブラウザで確認できる実機手順は [`docs/shannon-ios-device-runbook.html`](docs/shannon-ios-device-runbook.html) にまとめている。

FCA・感情・記憶がどう分離して動くかは [`docs/shannon-fca-v1-runtime.html`](docs/shannon-fca-v1-runtime.html) で視覚的に確認できる。
