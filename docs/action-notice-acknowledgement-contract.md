# 結果不明の通知の確認

状態: 実装ブランチ、未配布。対象: iPhone／Mac トークの「裏の作業」。目的は、不明な結果の通知を所有者が読んだと記録すること。

| 保つ | 変える | 変えない |
| --- | --- | --- |
| 不明な実行記録、停止／再開、会話入力、標準シート／ポップオーバー、同席時の非開示 | 不明結果の各行に「この通知を確認済みにする」を追加し、読んだ通知を警告文から外す | 原状態、lease、世代、sent、資源、予算予約、owner_informed、元タスク／モデル／外部操作 |

一次操作は各通知の確認。二次操作は再読込。結果の確認・成功・停止とは別の意味である。「通知を確認済みにしても、作業の結果と保留中の資源は変わりません。」と説明し、行には「結果不明・通知は確認済み」を残す。未確認通知がなくなった後も「裏の作業の記録」から不明な記録を読める。新しい不明結果は改めて警告する。自動確認と一括確認は行わない。

GET /v1/action-threads の unknown の非respond行は任意の notification: { id, acknowledgedAt } を返す。id は元action ID・generation・resultに結び付けた閉じた不明episodeの値。確認は POST /v1/action-threads/:id/acknowledge-notice の {requestId, notificationId} を一回だけ送る。所有者の認証scopeを使い、IPC待ち後の同席状態を送信直前と応答直前で確かめる。mindの単一writerが別表に確認を保存し、同一scope／元action／unknown状態／同一episodeを一つのトランザクションで照合する。同じrequestIdの内容違いは拒否する。元の実行行も予算行も更新しない。

読み込み中、古い報告、通信復旧、同席時には確認操作を出さないか無効にする。POST応答不明ではGETのみで確認し、自動再送しない。新しいepisodeに変わった場合は元通知を確認できなかったと示す。旧サーバーのnotification無しでは以前の警告と停止／再開を保ち、確認操作だけを出さない。空一覧、接続解除、他者への遅延応答では元の非開示と消去を保つ。

確認ボタンは44pt以上、名前と対象作業名をVoiceOverへ提供し、色だけで状態を示さない。本文の拡大・改行、標準キーボード／dismiss／フォーカス復帰、Reduce Motion、Reduce Transparency、Increase Contrastは既存の標準コントロールと意味色を継承する。独自アニメーションを増やさない。

検証対象: 全実行・資源・予算・機微情報由来フラグの不変、世代違い／所有者違い／内容違い拒否、再起動と別端末の読み戻し、同席への切替、失われたPOST、旧サーバー、確認後の記録保持、新episodeの再通知。実画面とアクセシビリティの実操作は結果に記録し、単体テストやビルドだけで検証済みとしない。

## 検証記録

決定的検証: verify fast通過。通知・既存action HTTP/store・実worker IPCの39件、既存ownTime／外部action／資源reconciliation／FCA停止の87件、mind worker再起動／SIGKILLの1件が通過。workerの初回追加実行はAPIサブディレクトリから起動して相対パスが二重になり、実行前に失敗したため、正規のrepo rootから同じ時計・assertionのまま再実行して通過した。Swiftは最終ソースの8既存XCTest＋7新Swift Testingを --jobs 2 --no-parallelで通過。元のmind_actionsとmind_action_budgetの全列をSQLで比較し、通知確認による差分が無いこと、資源競合が引き続き拒否されることを検証した。

本subtaskではGUI／実機／本番を操作していない。実画面とnative app build、Light/Dark、文字拡大、VoiceOver、全体回帰と配布受入れは親taskへ引き継ぐ。既存のDEBUG専用 -ShannonDesignPreview -ShannonPreviewActionThreads -ShannonPreviewActionState unknown は合成通知の確認操作も再現する。
