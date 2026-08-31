# Shannon iOS app

SwiftUIアプリのコア。現在はSwift Packageとして、Material 3ベースの会話画面・API client・状態表示・view modelを実装している。
最終的な署名・実機起動用Xcode app targetは、アプリアイコンやbundle IDを決める段階で追加する。

## 会話画面

- Material 3のsemantic color、surface階層、shape scaleをSwiftUI tokenとして実装
- ライト／ダークモード、Dynamic Type、VoiceOver、Reduce Motionに対応
- Shannonの各返信に、送信時の感情スナップショットと表情を固定保存
- 8表情のコードネイティブなShannonアバター
- 空状態、考え中、送信中、送信済み、送信失敗、重複しない再送
- ヘッダーから現在状態のボトムシートを表示

初期画面候補:

- Shannonの現在の様子
- 会話
- 記憶の閲覧・訂正・忘却
- 睡眠後に変わったユーザー理解の確認
- 通知と自発性の設定

## ローカル検証

```sh
swift test --disable-sandbox
```
