import Foundation

public enum ShannonAgentTaskMappingError: Error, Equatable {
    case invalidIdentifier
}

public enum ShannonAgentTaskFixtures {
    public static func proposed(
        threadID: String = "fixture-thread",
        sourceMessageID: UUID? = nil,
        now: Date = Date()
    ) -> ShannonAgentTask {
        ShannonAgentTask(
            conversationThreadID: threadID,
            sourceMessageID: sourceMessageID,
            title: "ログイン障害を調査・修正",
            goal: "会話履歴を保持したまま、再起動直後の接続失敗を解消する",
            status: .proposed,
            summary: "原因を調べて、影響の小さい直し方まで確認する。",
            createdAt: now,
            updatedAt: now
        )
    }

    public static func running(
        threadID: String = "fixture-thread",
        sourceMessageID: UUID? = nil,
        now: Date = Date()
    ) -> ShannonAgentTask {
        var task = proposed(threadID: threadID, sourceMessageID: sourceMessageID, now: now)
        task.status = .running
        task.title = "ログイン障害を調査"
        task.summary = "認証状態の復元処理を追いかけてるところ。"
        task.currentAction = "既存の対話履歴を壊さないか確認中"
        task.plan = samplePlan
        task.timeline = [
            .init(sequence: 1, title: "再現条件を確認", detail: "アプリ再起動直後に発生", occurredAt: now.addingTimeInterval(-240), tone: .success),
            .init(sequence: 2, title: "関連箇所を特定", detail: "SessionStore と APIClient", occurredAt: now.addingTimeInterval(-120), tone: .success),
            .init(sequence: 3, title: "修正案を検証中", detail: "既存の対話履歴を壊さないか確認", occurredAt: now, tone: .progress),
        ]
        return task
    }

    public static func waitingApproval(
        threadID: String = "fixture-thread",
        sourceMessageID: UUID? = nil,
        now: Date = Date()
    ) -> ShannonAgentTask {
        var task = running(threadID: threadID, sourceMessageID: sourceMessageID, now: now)
        task.status = .waitingApproval
        task.summary = "接続テストの前で待ってる。"
        task.currentAction = "端末の認証情報を使う許可を待っています"
        task.pendingApproval = ShannonAgentApproval(
            externalRequestID: "fixture-approval",
            kind: .network,
            title: "接続テストをしていい？",
            reason: "外部への書き込みはせず、ログイン確認だけ行います。",
            resource: "sh4nnon.com",
            requestedAt: now
        )
        return task
    }

    public static func completed(
        threadID: String = "fixture-thread",
        sourceMessageID: UUID? = nil,
        now: Date = Date()
    ) -> ShannonAgentTask {
        var task = running(threadID: threadID, sourceMessageID: sourceMessageID, now: now)
        task.status = .completed
        task.summary = "履歴を残したまま再接続できるようにした。"
        task.currentAction = nil
        task.plan = samplePlan.map { .init(id: $0.id, title: $0.title, status: .completed) }
        task.timeline.append(.init(sequence: 4, title: "修正とテストが完了", detail: "31件のテストが成功", occurredAt: now, tone: .success))
        task.changes = [
            .init(displayName: "SessionStore.swift", summary: "履歴を消さずにセッションを更新", additions: 12, deletions: 4),
            .init(displayName: "SessionStoreTests.swift", summary: "再起動後の復元試験を追加", additions: 18, deletions: 0),
        ]
        task.tests = [
            .init(name: "セッション復元", status: .passed, detail: "12件"),
            .init(name: "対話履歴の保持", status: .passed, detail: "19件"),
        ]
        return task
    }

    private static var samplePlan: [ShannonAgentPlanItem] {
        [
            .init(id: "reproduce", title: "再現条件を確認", status: .completed),
            .init(id: "trace", title: "関連箇所を特定", status: .completed),
            .init(id: "fix", title: "修正案を検証", status: .running),
            .init(id: "test", title: "テストして結果をまとめる", status: .pending),
        ]
    }
}
