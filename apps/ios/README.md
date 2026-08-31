# Shannon iOS app

SwiftUIアプリのコア。現在はSwift Packageとして、会話画面・API client・状態表示・view modelを実装している。
最終的な署名・実機起動用Xcode app targetは、アプリアイコンやbundle IDを決める段階で追加する。

初期画面候補:

- Shannonの現在の様子
- 会話
- 記憶の閲覧・訂正・忘却
- 睡眠後に変わったユーザー理解の確認
- 通知と自発性の設定

## ローカル検証

```sh
swift test
```
