import Foundation

#if DEBUG
/// Fictional data for design previews and screenshots of 「ようす」: `-ShannonDesignPreview
/// -ShannonPreviewYousu now|ops|opsStale|opsConfirm|tile`. Never real conversation or
/// operational data, and nothing here reaches a server.
struct ShannonYousuFixtureClient: ShannonYousuServing {
    let stale: Bool

    static var launchVariant: String? {
        UserDefaults.standard.string(forKey: "ShannonPreviewYousu")
    }

    private static func iso(minutesAgo: Double) -> String {
        Date().addingTimeInterval(-minutesAgo * 60).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    func loadOps(scopeKey: String) async throws -> ShannonOpsReading {
        let received = Self.iso(minutesAgo: stale ? 22 : 1)
        let snapshot = ShannonOpsSnapshotDTO(
            reportedAt: received,
            runtime: .init(release: "v2026.10.03-1", startedAt: Self.iso(minutesAgo: 9 * 60)),
            services: [
                .init(id: "discord", category: "platform", status: .running),
                .init(id: "twitter", category: "platform", status: .running),
                .init(id: "youtube", category: "platform", status: .running),
                .init(id: "youtube:live_chat", category: "platform", status: .stopped),
                .init(id: "notion", category: "platform", status: .unknown),
                .init(id: "minebot", category: "game", status: .running),
                .init(id: "minebot:bot", category: "game", status: .stopped),
                .init(id: "minecraft", category: "game", status: .degraded, detail: "再接続中（3回目）"),
                .init(id: "minecraft:1.21.1-play", category: "game", status: .running),
                .init(id: "minecraft:1.21.4-test", category: "game", status: .stopped),
            ],
            minebot: [
                .init(id: "bot-1", server: "1.21.1-play", status: .stopped, task: .init(title: "倉庫を作る", steps: [
                    .init(title: "木を集める", status: .done),
                    .init(title: "チェストを置く", status: .running),
                    .init(title: "屋根をかける", status: .pending),
                ])),
            ],
            schedules: [
                .init(name: "朝の占い", time: "0 8 * * *", postedToday: true),
                .init(name: "夜の投稿", time: "30 21 * * *"),
            ],
            kpi: .init(postsToday: 3, postsPlanned: 5, tokensToday: 182_340, apiCallsToday: 97),
            skills: [
                .init(name: "get-weather", description: "都市の天気予報を読む"),
                .init(name: "placeBlock", description: "ブロックを置く"),
            ]
        )
        let view = ShannonOpsViewDTO(
            snapshot: snapshot, receivedAt: received, stale: stale, commandsSupported: true,
            commands: [
                .init(id: "fixture-1", type: .serviceStop, target: "youtube:live_chat", status: .done,
                      createdAt: Self.iso(minutesAgo: 143), finishedAt: Self.iso(minutesAgo: 142)),
                .init(id: "fixture-2", type: .minecraftStart, target: "minecraft:1.21.4-test", status: .refused,
                      createdAt: Self.iso(minutesAgo: 300), finishedAt: Self.iso(minutesAgo: 299), code: "lab_running"),
            ],
            allowed: .init(
                serviceStart: ["discord", "youtube:live_chat", "notion", "minecraft"],
                serviceStop: ["twitter", "youtube", "youtube:live_chat", "notion", "minebot", "minebot:bot", "minecraft"],
                minecraft: true, scheduleRun: true, minebotStart: true
            )
        )
        return ShannonOpsReading(view: view, serverDate: Date())
    }

    func sendOpsCommand(scopeKey: String, idempotencyKey: String, type: ShannonOpsCommandType, target: String) async -> ShannonOpsSendOutcome {
        // A preview sends nothing.
        .refused(status: 403, code: "OPS_COMMANDS_DISABLED")
    }

    func loadShannonNow(scopeKey: String) async throws -> ShannonNowDTO {
        ShannonNowDTO(
            generatedAt: Self.iso(minutesAgo: 0),
            feeling: .init(
                mood: .init(expression: "calm"),
                present: .init(expression: "joyful", intensity: 0.6),
                lingering: [.init(expression: "sad", strength: 0.3, startedAt: Self.iso(minutesAgo: 125))]
            ),
            body: .init(known: true, present: true, lastReadAt: Self.iso(minutesAgo: 0.2), camera: true),
            looks: [
                .init(id: "l1", at: Self.iso(minutesAgo: 45), askedBy: "owner", surface: "body", outcome: "seen"),
                .init(id: "l2", at: Self.iso(minutesAgo: 200), askedBy: "herself", surface: "body", outcome: "refused", code: "camera_off"),
            ],
            touches: [.init(id: "t1", at: Self.iso(minutesAgo: 73), kind: "pet", count: 2, answered: true)],
            reachOuts: [
                .init(id: "r1", at: Self.iso(minutesAgo: 95), reason: "share", deliveries: [
                    .init(surface: "body", outcome: "spoken", at: Self.iso(minutesAgo: 95)),
                    .init(surface: "app", outcome: "read", at: Self.iso(minutesAgo: 80)),
                ]),
                .init(id: "r2", at: Self.iso(minutesAgo: 260), reason: "wonder", deliveries: [
                    .init(surface: "earphones", outcome: "spoken", at: Self.iso(minutesAgo: 260), device: "iphone"),
                ]),
            ]
        )
    }

    func loadShannonOwnTime(scopeKey: String) async throws -> ShannonNowOwnTimeDTO {
        ShannonNowOwnTimeDTO(
            control: .init(state: "active", enabled: true, paused: false),
            loop: .init(state: "running", label: "動いています"),
            budget: .init(dayKey: "2026-10-03", baseCapYen: 1_000, extraYen: 0, capYen: 1_000, spentYen: 420, remainingYen: 580, exhausted: false, yenPerUsd: 150),
            proposals: [.init(id: "p1", title: "書斎の目次を作る", goal: "書斎の作品に目次を付ける", reason: "探しやすくしたい", status: "proposed", createdAt: Self.iso(minutesAgo: 400))],
            session: .init(state: "active", label: "14:05から活動中（この時間に12円）")
        )
    }

    func loadShannonStudyWaiting(scopeKey: String) async throws -> ShannonNowStudyDTO {
        ShannonNowStudyDTO(pieces: [.init(id: "s1", title: "灯台と白い猫", awaitingReaction: true)])
    }

    func opsReportScope(scopeKey: String) -> String? { nil }

    func loadShannonMoodHistory(scopeKey: String, hours: Int) async throws -> ShannonMoodHistoryDTO {
        // A quiet night, a bright afternoon, a sulky moment, and the evening settling down.
        let shape: [(Double, Double, Double, Double)] = [
            (Double(hours) * 60 - 5, 0, 0.3, 0.35), (Double(hours) * 45, 0.05, 0.28, 0.35), (Double(hours) * 30, 0.32, 0.55, 0.5),
            (Double(hours) * 20, -0.26, 0.4, 0.2), (Double(hours) * 8, 0.1, 0.35, 0.4), (30, 0.28, 0.3, 0.45),
        ]
        let points = shape.map { minutesAgo, valence, arousal, openness in
            ShannonMoodHistoryDTO.Point(
                at: Self.iso(minutesAgo: minutesAgo), valence: valence, arousal: arousal, openness: openness,
                mood: .init(expression: "calm", feeling: nil), present: nil
            )
        }
        return ShannonMoodHistoryDTO(schemaVersion: 1, generatedAt: Self.iso(minutesAgo: 0), hours: hours, points: points, downsampled: false)
    }

    func loadShannonRecentActivity(scopeKey: String) async throws -> ShannonAutonomyActivityDTO {
        ShannonAutonomyActivityDTO(control: .init(state: "active", enabled: true, paused: false), days: [])
    }
}
#endif
