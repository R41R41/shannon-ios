# Shannon iOS app

SwiftUIアプリのコア。現在はSwift Packageとして、Apple標準UIを土台にした会話画面・API client・状態表示・view modelを実装している。
署名・実機起動用Xcode app targetは`apps/ios-app`にあり、Azureのpaired APIへ接続するReleaseを実機導入できる。

## 会話画面

- `NavigationStack`、標準toolbar、sheet、`List`、`searchable`、`safeAreaInset`でiPhoneの画面構造を実装
- Shannon固有のsemantic color、surface階層、shape scaleはSwiftUI tokenとして実装
- ライト／ダークモード、Dynamic Type、VoiceOver、Reduce Motionに対応
- Shannonの各返信に、送信時の感情スナップショットと表情を固定保存
- Icon Chibiを基準に生成した22表情のShannonアバター
- 返信時の`expression`から、同名の同梱PNGを自動選択
- 空状態、考え中、送信中、送信済み、送信失敗、重複しない再送
- 標準toolbarからトーク一覧、新規トーク、表示切替へ移動

実装済みの記憶画面:

- ユーザー情報、Shannonの興味、会話の思い出、関係理解の一覧
- 根拠、確信度、作成・更新時刻、変更理由の詳細
- 訂正、忘却、固定、事実ではない、復元
- 睡眠後の新規学習、理解更新、関心変化、保留した矛盾

## ローカル検証

```sh
swift test --disable-sandbox
```
