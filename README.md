# Shannon iOS

既存Shannonとは独立した、Shannon iOSアプリと専用バックエンドのリポジトリ。

## 方針

- v1は固定LLMを使う。
- FCAは開始時の確定済み共有状態を一度だけ受け取る。
- 感情評価と記憶想起はFCAの外側で非同期に動き、次の返答から影響する。
- 予測、Aether連携、追加学習、自動コード更新はv1に含めない。
- 睡眠バッチは一日分の経験からユーザー情報だけを慎重に更新する。

## 構成

- `apps/ios`: SwiftUI会話画面、API client、ViewModel。現在はSwift Packageとして検証する。
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

別のターミナルでiOSコアを検証する。

```sh
cd apps/ios
swift test
```

ローカルAPIは `http://127.0.0.1:4317` で起動する。現在の `/v1/chat` はLLM未接続の `local-stub`。
