import Foundation

#if DEBUG
/// Fictional data for design previews and screenshots of 「ようす › 目標」 and 「ようす › 点検」:
/// `-ShannonDesignPreview -ShannonPreviewYousu goals|inspection` (`-ShannonPreviewExecutive notReady` for a server before
/// the routes: every part says 「準備中」). Never real goals, choices or counts, and nothing here reaches a server: a control
/// answers as a server would, without keeping anything.
extension ShannonYousuFixtureClient {
    private static var executiveNotReady: Bool {
        UserDefaults.standard.string(forKey: "ShannonPreviewExecutive") == "notReady"
    }

    private static func at(hours: Double) -> String {
        Date().addingTimeInterval(-hours * 3600).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    static func fixtureGoals(confirmed: String? = nil) -> ShannonGoalsDTO {
        var goals: [ShannonGoalsDTO.Goal] = [
            .init(id: "g-poems", title: "短い詩集を作る", why: "前に書いた詩をライ氏が喜んでくれたから", status: "active", origin: "self",
                  interest: "詩", progress: 0.6, progressLabel: "3/5", reviewAt: at(hours: -72), lastWorkedAt: at(hours: 9),
                  completion: .init(summary: "5篇そろって、ライ氏が読む", met: false), evidenceCount: 3, createdAt: at(hours: 200), updatedAt: at(hours: 9)),
            .init(id: "g-weather", title: "天気の言い回しを集める", why: "朝の声かけを毎日ちがう言葉にしたい", status: "active", origin: "conversation",
                  interest: "ことば", progress: 1, progressLabel: "12/12", reviewAt: at(hours: -20), lastWorkedAt: at(hours: 30),
                  completion: .init(summary: "言い回しを12個メモにまとめる", met: true), evidenceCount: 12, createdAt: at(hours: 300), updatedAt: at(hours: 30)),
            .init(id: "g-minecraft", title: "shannon-home に小さな畑を作る", why: "ひとりの時間に、手を動かすことを増やしたい", status: "active", origin: "self",
                  interest: "Minecraft", progress: 0.2, reviewAt: at(hours: -130), lastWorkedAt: at(hours: 50),
                  completion: nil, evidenceCount: 1, createdAt: at(hours: 120), updatedAt: at(hours: 50)),
            .init(id: "g-seed", title: "ライ氏のことをよく知る", why: "はじめからの目標", status: "active", origin: "seed",
                  reviewAt: nil, completion: .init(summary: "終わりのない目標です", met: false), evidenceCount: 0, createdAt: at(hours: 2000), updatedAt: at(hours: 100)),
            .init(id: "g-index", title: "書斎の目次を作る", why: "作品を探しやすくしたい", status: "resting", origin: "self",
                  progress: 0.4, progressLabel: "2/5", reviewAt: at(hours: -150), completion: .init(summary: "全作品が目次に載る"),
                  evidenceCount: 2, closedReason: "いまは詩集を先にしたい", createdAt: at(hours: 400), updatedAt: at(hours: 60)),
            .init(id: "g-old", title: "毎朝の占いを続ける", why: "朝の会話のきっかけに", status: "dropped", origin: "self",
                  evidenceCount: 4, closedReason: "ライ氏の反応が少なかった", closedAt: at(hours: 40), createdAt: at(hours: 900), updatedAt: at(hours: 40)),
            .init(id: "g-done", title: "灯台の物語を書き上げる", why: "書きかけのままだったから", status: "done", origin: "self",
                  progress: 1, progressLabel: "完成", completion: .init(summary: "最後の章まで書いて、ライ氏が読む", met: true), evidenceCount: 5,
                  closedReason: "ライ氏が完了を認めた", closedAt: at(hours: 80), createdAt: at(hours: 700), updatedAt: at(hours: 80)),
        ]
        if let confirmed, let index = goals.firstIndex(where: { $0.id == confirmed }) {
            goals[index].status = "done"
            goals[index].closedReason = "ライ氏が完了を認めた"
            goals[index].closedAt = at(hours: 0)
        }
        return ShannonGoalsDTO(generatedAt: at(hours: 0), activeLimit: 8, goals: goals)
    }

    static let fixtureChoices: [ShannonChoicesDTO.Choice] = [
        .init(id: "c1", at: at(hours: 1), capability: "create", label: "詩を1篇書いた", goalId: "g-poems", goalTitle: "短い詩集を作る",
              reason: "前回ライ氏が喜んでくれたから", outcome: "done", topByValue: true),
        .init(id: "c2", at: at(hours: 3), capability: "rest", label: "休んだ", reason: "書く気分が落ちていたから", outcome: "none"),
        .init(id: "c3", at: at(hours: 5), capability: "research", label: "雨の言い回しを調べた", goalId: "g-weather", goalTitle: "天気の言い回しを集める",
              reason: "明日は雨なので、使える言葉を増やしたい", outcome: "running"),
        .init(id: "c4", at: at(hours: 8), capability: "notify", label: "ライ氏に声をかけた", reason: "近い予定が気になった", outcome: "done", topByValue: false),
        .init(id: "c5", at: at(hours: 26), capability: "minecraft", label: "shannon-home で畑を耕した", goalId: "g-minecraft", goalTitle: "shannon-home に小さな畑を作る",
              reason: "誰もいなかったので、いまのうちに", outcome: "failed", offCandidates: true),
        .init(id: "c6", at: at(hours: 50), capability: "look", label: "部屋を見た", reason: "静かだったので様子を見たかった", outcome: "unknown"),
    ]

    static let fixtureCapabilities: [ShannonCapabilitiesDTO.Capability] = [
        .init(id: "create", label: "創作", purpose: "物語や詩を書く・直す", layer: "activity", execution: "procedure", policy: "own_time",
              value: .init(mean: 0.53, sd: 0.11, n: 14), uses7d: 6, usesTotal: 41),
        .init(id: "note", label: "メモ", purpose: "思いついたことを書き留める", layer: "activity", execution: "procedure", policy: "own_time",
              value: .init(mean: 0.31, sd: 0.2, n: 7), uses7d: 3, usesTotal: 19),
        .init(id: "research", label: "調べる", purpose: "Web・Aether・Notion・記憶から調べて報告する", layer: "activity", execution: "fca", policy: "own_time",
              value: .init(mean: 0.44, sd: 0.15, n: 5), uses7d: 2, usesTotal: 5),
        .init(id: "notify", label: "知らせる", purpose: "文字か電話でライ氏に声をかける（知らせないことも選べる）", layer: "activity", execution: "procedure",
              policy: "own_time", value: .init(mean: 0.18, sd: 0.25, n: 22), uses7d: 5, usesTotal: 88),
        .init(id: "minecraft", label: "Minecraft", purpose: "誰もいない時に shannon-home で遊ぶ", layer: "activity", execution: "fca", policy: "own_time",
              value: .init(mean: -0.1, sd: 0.3, n: 2), uses7d: 1, usesTotal: 2),
        .init(id: "music", label: "音楽を提案", purpose: "「かけようか？」と曲を出す（自分からは鳴らさない）", layer: "activity", execution: "procedure",
              policy: "own_time", uses7d: 0, usesTotal: 0),
        .init(id: "rest", label: "休む", purpose: "次に考える時間と理由を残して休む", layer: "activity", execution: "none", policy: "own_time", uses7d: 9, usesTotal: 60),
        .init(id: "tool.web_search", label: "Web検索", purpose: "Web を検索する", layer: "tool", execution: "fca", policy: "own_time", uses7d: 4, usesTotal: 30),
        .init(id: "tool.reminders", label: "リマインダー", purpose: "リマインダーを作る", layer: "tool", execution: "fca", policy: "owner_request_only", uses7d: 1, usesTotal: 9),
        .init(id: "tool.music.play", label: "音楽を再生", purpose: "曲をかける", layer: "tool", execution: "fca", policy: "owner_request_only", uses7d: 2, usesTotal: 14),
    ]

    func loadShannonGoals(scopeKey: String) async throws -> ShannonGoalsDTO {
        if Self.executiveNotReady { throw ShannonAPIError.rejected(status: 404) }
        return Self.fixtureGoals()
    }

    func loadShannonChoices(scopeKey: String, days: Int) async throws -> ShannonChoicesDTO {
        if Self.executiveNotReady { throw ShannonAPIError.rejected(status: 404) }
        return ShannonChoicesDTO(generatedAt: Self.at(hours: 0), days: days, choices: Self.fixtureChoices)
    }

    func confirmShannonGoal(scopeKey: String, id: String) async throws -> ShannonGoalsDTO {
        try? await Task.sleep(for: .milliseconds(400))
        return Self.fixtureGoals(confirmed: id)
    }

    func setShannonGoalStatus(scopeKey: String, id: String, status: String) async throws {
        // A preview keeps nothing: the list read after it is the same as before.
        try? await Task.sleep(for: .milliseconds(400))
    }

    func loadShannonCapabilities(scopeKey: String) async throws -> ShannonCapabilitiesDTO {
        if Self.executiveNotReady { throw ShannonAPIError.rejected(status: 404) }
        return ShannonCapabilitiesDTO(generatedAt: Self.at(hours: 0), capabilities: Self.fixtureCapabilities)
    }

    func loadShannonInspection(scopeKey: String, day: String?) async throws -> ShannonInspectionDTO {
        if Self.executiveNotReady { throw ShannonAPIError.rejected(status: 404) }
        let today = ShannonInspectionDTO.Counts(
            deliberations: 9, choices: 8, chosenTopValue: 5, offCandidates: 1, distinctCapabilities: 4,
            goals: .init(created: 1, completed: 0, rested: 1, dropped: 0), notices: .init(sent: 2, answered: 1, unanswered: 1),
            sleepRuns: 0, unknown: 0, spentYen: 312, skillUses: 2, predictions: .init(made: 14, hit: 9)
        )
        let week = ShannonInspectionDTO.Counts(
            deliberations: 71, choices: 64, chosenTopValue: 39, offCandidates: 4, distinctCapabilities: 7,
            goals: .init(created: 4, completed: 2, rested: 3, dropped: 1), notices: .init(sent: 15, answered: 11, unanswered: 4),
            sleepRuns: 7, unknown: 1, spentYen: 8_420, skillUses: 13, predictions: .init(made: 102, hit: 63)
        )
        return ShannonInspectionDTO(generatedAt: Self.at(hours: 0), day: day ?? "2026-10-13", today: today, week: week)
    }
}
#endif
