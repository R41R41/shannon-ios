# Shannon iOS v1 architecture

## Runtime lanes

### Response lane

1. 認証済みユーザーと会話scopeを確定する。
2. 最新の確定済み共有状態を不変スナップショットとして取得する。
3. 最小固定プロンプト、可変状態、直近20件の会話を結合する。
4. 固定LLMでFCAを実行し、同じスナップショットを最後まで使う。v1ではWeb・スキルを渡さない。
5. 返答と実行結果を経験ログへ記録する。

### Background lane

1. 返答後のイベントを感情評価と記憶想起へ渡す。予測は行わない。
2. 完了した更新だけをscopeごとに順番に適用する。
3. 新しい版を永続化する。
4. 実行中のFCAは変更せず、次のFCAから新しい版を使う。

現在のローカル実装では、感情は基準値への減衰と入力刺激への反応という同じ法則で更新する。記憶は過去経験との文字特徴の重なりと新しさで最大3件を想起する。現在と想起経験に同じ主題が現れたときだけ、Shannonの関心として昇格する。いずれもLLM応答後に始まり、response laneを待たせない。永続化と別process worker化は次段階。

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

## Azure layout (later)

```text
/home/azureuser/shannon-ios-dev/   # dev checkout and dev data
/home/azureuser/shannon-ios-prod/  # reviewed release artifact only
```

devとprodで、環境変数、DB、ポート、service、ログ、秘密情報を共有しない。
