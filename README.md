# Shannon iOS

既存Shannonとは独立した、Shannon iOSアプリと専用バックエンドのリポジトリ。

## 方針

- v1は固定LLMを使う。
- FCAは開始時の確定済み共有状態を一度だけ受け取る。
- 感情評価と記憶想起はFCAの外側で非同期に動き、次の返答から影響する。
- 予測、Aether連携、追加学習、自動コード更新はv1に含めない。
- 睡眠バッチは一日分の経験からユーザー情報だけを慎重に更新する。

## 構成

- `apps/ios`: SwiftUIアプリ。XcodeプロジェクトはUI実装開始時に追加する。
- `services/api`: Azure VMで動かす専用API。永続化とworkerをここへ置く。
- `packages/cognition`: 感情・関心・ユーザー情報・想起記憶・プロンプト投影の純粋な核。
- `docs`: アーキテクチャと運用方針。

## 開発

```sh
pnpm install
pnpm check
pnpm test
```

