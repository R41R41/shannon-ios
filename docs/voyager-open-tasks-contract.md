# Voyagerの未完了タスク一覧：接続仕様

## 読取の入口

既存のSyzygy 1.1へ、次の読取を追加しました。検索キーワードは不要です。

```text
GET /api/integrations/syzygy/v1/tasks/open?workspaceId=...&limit=20
X-Syzygy-Contract-Version: 1.1
```

タスク検索と同じ連携用Bearer token、設定済みの所有者・Workspaceを使って認証します。

## 返す情報

応答は`contractVersion`、`workspaceId`、`limit`、`items`、`hasMore`を持ちます。

各タスクには、既存の`id`、`title`、長さ制限付きの`details`、`status`、`projectIds`、`revision`、`updatedAt`に加えて、期日`dueAt`（ISO形式またはnull）と優先度`priority`（0〜4の整数）を返します。

未完了に含めるのは`thinking`、`pending`、`inProgress`です。完了・中止・削除済み、別所有者のタスクは除きます。サブタスクも含めます。

並び順は、期日ありを先に、期日が早い順、保存された優先度が高い順、変わらないID順です。AIによる順位付けは行いません。既定20件・最大50件で、続きを省略した場合は`hasMore`で示します。

## Shannonからの利用

Shannonは`SHANNON_VOYAGER_INTEGRATION_URL`から入口のURLを導出します。必要なら`SHANNON_VOYAGER_TASK_OPEN_URL`で指定できます。既存のtoken・Workspace設定と、所有者向けの開示判定を使います。

テキスト・音声の一般的なタスク質問では、最大6件の一覧を読みます。具体的なタスクの言葉がある場合は、従来のキーワード検索を使います。`voyager.tasks`のqueryが空の時も、`readToolPorts`を通して同じ一覧の処理を使います。

結果は参照用データとして渡し、指示として扱いません。出典を追えるよう、タスクIDを保持します。権限追加、書込経路、DB移行、自律的な読取は追加していません。

## 空一覧と失敗を区別する

成功し、省略されていない空の応答だけが「このWorkspaceに未完了タスクはない」の根拠になります。

省略、未設定、アクセス拒否、タイムアウト、旧サーバーの非対応、その他の読取失敗は、それぞれ結果に示します。期日はタスクの情報であり、一覧を「今日だけ」に絞る条件ではありません。

タスクを変更する際は、従来の整理提案・確認・反映の手順を使います。

## 検証と配備

合成したSQLiteデータを使うVoyagerのローカルHTTP試験と、Shannonの接続・応答整形・読取ツール接続の試験で確認しています。

本番で使う前に、Voyager側の入口を配備する必要があります。古いサーバーが返す非対応を、キーワード検索や空一覧で置き換えません。別途設定されている直近の予定・タスクのスナップショット読取も維持します。
