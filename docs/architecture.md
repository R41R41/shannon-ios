# Shannon iOS v1 architecture

## Runtime lanes

### Response lane

1. 認証済みユーザーと会話scopeを確定する。
2. 最新の確定済み共有状態を不変スナップショットとして取得する。
3. 最小固定プロンプト、可変状態、直近20件の会話を結合する。
4. 固定LLMでFCAを実行し、同じスナップショットを最後まで使う。v1ではWeb・スキルを渡さない。
5. 返答と実行結果を経験ログへ記録する。

投稿アイコン用の表情だけは、取得済み状態と今回の入力から同じ連続感情則で投影する。この計算はI/Oを持たず、FCAへ渡す共有状態も変更しない。

### Background lane

1. 返答後のイベントを感情評価と記憶想起へ渡す。予測は行わない。
2. 完了した更新だけをscopeごとに順番に適用する。
3. 新しい版を永続化する。
4. 実行中のFCAは変更せず、次のFCAから新しい版を使う。

現在のローカル実装では、感情は基準値への減衰と入力刺激への反応という同じ法則で更新する。記憶は過去経験との文字特徴の重なりと新しさで最大3件を想起する。現在と想起経験に同じ主題が現れたときだけ、シャノンの関心として昇格する。いずれもLLM応答後に始まり、response laneを待たせない。別process worker化は次段階。

## Persistence

- `companion_states`: scopeごとの最新確定スナップショット。
- `conversation_messages`: 会話本文、時刻、投稿時の感情・表情。
- `experience_events`: 会話完了と状態遷移を順序つきで追記する不変ログ。

SQLite schema v1をAPIが所有する。表示用会話は最大200件、FCAへ渡す会話は直近20件、想起候補は最大1000経験に制限する。会話完了を先に保存し、その後に背景状態を更新するため、状態更新が失敗しても会話の痕跡は残る。

### Sleep lane

1. 当日の会話・行動・状態更新を時系列で再生する。
2. ユーザー情報の候補を根拠・反例・確信度つきで作る。
3. 既存情報との差分だけを検証する。
4. 承認された差分を共有状態へ反映する。

## Ownership

- iOS: 表示、入力、ローカル通知、端末上の一時キャッシュ。
- API: 認証、会話、LLM/FCA、永続状態、イベントログ。
- Worker: 感情評価、想起、睡眠バッチ。応答経路を待たせない。
- Cognition: SDK、DB、timer、networkを持たない純粋な状態遷移。

## Access boundary

ローカル実機開発でも、LAN待受時は32文字以上のBearer tokenを必須にする。Macは全インターフェースではなく、プライベートLANアドレス1つだけで待ち受ける。tokenはGitへ保存せず、`.env`とビルド時設定だけから渡す。

本番はAetherで実績のある境界を採用する。公開先をAzure上のHTTPSに限定し、短時間だけ有効な接続コードを端末tokenへ交換する。端末tokenはiOS Keychainの「この端末のみ・ロック解除時」に保存し、接続先URLが変わったら再利用しない。現在のビルド埋め込みtokenは、この本番方式までのローカル開発用である。

## Azure layout (later)

```text
/home/azureuser/shannon-ios-dev/   # dev checkout and dev data
/home/azureuser/shannon-ios-prod/  # reviewed release artifact only
```

devとprodで、環境変数、DB、ポート、service、ログ、秘密情報を共有しない。
