import Foundation

#if DEBUG
/// Fictional data for design previews and screenshots of 「ようす › 学び」: `-ShannonDesignPreview -ShannonPreviewYousu learning`
/// (`-ShannonPreviewLearning frozen` for a value table that was rolled back). Never real skills or values, and nothing here
/// reaches a server: a pin, a rollback and a resume answer as a server would, without keeping anything.
extension ShannonYousuFixtureClient {
    private static var learningVariant: String? {
        UserDefaults.standard.string(forKey: "ShannonPreviewLearning")
    }

    private static func ago(hours: Double) -> String {
        Date().addingTimeInterval(-hours * 3600).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    static let fixtureSkills: [ShannonSkillDTO] = [
        .init(id: "s-research", name: "research-notes", description: "調べものをメモにまとめる", status: "active", version: 3, pinned: true, uses: 8, successes: 7),
        .init(id: "s-folder", name: "sort-folder-by-kind", description: "フォルダを種類で整理する", status: "trial", version: 2, pinned: false,
              trial: .init(baseVersion: 1, uses: 2, of: 3), uses: 6, successes: 4),
        .init(id: "s-review", name: "weekly-review", description: "週のふりかえりを三つに絞る", status: "active", version: 4, pinned: false, ownerVersion: true, uses: 5, successes: 4),
        .init(id: "s-outline", name: "outline-first", description: "物語の章立てを先に決める", status: "active", version: 1, pinned: false, uses: 4, successes: 3),
        .init(id: "s-wood", name: "gather-wood", description: "Minecraft で木を集める", status: "active", version: 1, pinned: false, uses: 0, successes: 0),
        .init(id: "s-nudge", name: "nudge-before-event", description: "予定の前に一言そえる", status: "trial", version: 1, pinned: false,
              trial: .init(baseVersion: nil, uses: 0, of: 3), uses: 0, successes: 0),
        .init(id: "s-weather", name: "weather-symbols", description: "天気の記号を読む", status: "retired", statusReason: "low_success", version: 2, pinned: false, uses: 8, successes: 2),
        .init(id: "s-old", name: "old-note-summary", description: "古いメモを要約する", status: "retired", statusReason: "source_forgotten", version: 1, pinned: false, uses: 1, successes: 1),
    ]

    private static func fixtureValues(frozen: Bool) -> ShannonValuesDTO {
        let versions: [ShannonValuesDTO.Version] = [
            .init(versionId: "v-1", createdAt: ago(hours: 52), madeBy: "sleep", evidenceFrom: 1, evidenceTo: 96, state: "retired", frozen: false),
            .init(versionId: "v-2", createdAt: ago(hours: 28), madeBy: "sleep", baseVersion: "v-1", evidenceFrom: 1, evidenceTo: 104, state: "retired", frozen: false),
            .init(versionId: "v-3", createdAt: ago(hours: 5), madeBy: "sleep", baseVersion: "v-2", evidenceFrom: 1, evidenceTo: 120, state: frozen ? "retired" : "active", frozen: false),
        ] + (frozen ? [
            .init(versionId: "v-4", createdAt: ago(hours: 0.1), madeBy: "owner_rollback", baseVersion: "v-2", evidenceFrom: 1, evidenceTo: 104, state: "active", frozen: true),
        ] : [])
        let cells: [ShannonValuesDTO.Cell] = [
            .init(level: "root", choice: "", n: 120, mean: 0.31, lastAt: ago(hours: 1)),
            .init(level: "family", choice: "reach_out", n: 30, mean: 0.2, lastAt: ago(hours: 3)),
            .init(level: "choice", choice: "show", n: 8, mean: 0.53, lastAt: ago(hours: 2)),
            .init(level: "choice", choice: "reach_out.share", n: 12, mean: 0.23, lastAt: ago(hours: 3)),
            .init(level: "choice", choice: "tool.study.search", n: 4, mean: 0.61, lastAt: ago(hours: 6)),
            .init(level: "choice", choice: "skill.use", n: 6, mean: 0.44, lastAt: ago(hours: 20)),
            .init(level: "choice", choice: "tier.luna_plus", n: 9, mean: 0.12, lastAt: ago(hours: 26)),
            .init(level: "choice", choice: "note", n: 2, mean: 0.35, lastAt: ago(hours: 40)),
            .init(level: "choice", choice: "reach_out.wonder", n: 3, mean: -0.08, lastAt: ago(hours: 70)),
            .init(level: "choice", choice: "look", n: 5, mean: 0.4, lastAt: ago(hours: 24 * 10)),
            .init(level: "band", choice: "show", context: "night", n: 3, mean: 0.6, lastAt: ago(hours: 2)),
        ]
        return ShannonValuesDTO(active: versions.last, frozen: frozen, versions: versions, cells: cells)
    }

    func loadShannonValues(scopeKey: String) async throws -> ShannonValuesDTO {
        Self.fixtureValues(frozen: Self.learningVariant == "frozen")
    }

    func rollbackShannonValues(scopeKey: String, versionID: String?) async throws -> ShannonValuesDTO {
        Self.fixtureValues(frozen: true)
    }

    func resumeShannonValues(scopeKey: String) async throws -> ShannonValuesDTO {
        Self.fixtureValues(frozen: false)
    }

    func loadShannonSkills(scopeKey: String) async throws -> ShannonSkillsDTO {
        ShannonSkillsDTO(capacity: .init(used: Self.fixtureSkills.filter { !$0.isRetired }.count, limit: 20), skills: Self.fixtureSkills)
    }

    func loadShannonSkill(scopeKey: String, id: String) async throws -> ShannonSkillDetailDTO {
        guard let skill = Self.fixtureSkills.first(where: { $0.id == id }) else { throw ShannonAPIError.rejected(status: 404) }
        let hidden = skill.statusReason == "source_forgotten"
        let body = hidden ? "" : """
        ---
        name: \(skill.name)
        description: \(skill.description)
        ---

        ## 手順
        1. 調べたことを三つの見出しに分ける。
        2. 見出しごとに、分かったことを一文で書く。
        3. 出典を最後にまとめる。

        ## 助け
        - 書斎の検索で、前のメモを先に見る。

        ## 参考
        - 会話から（作り例）
        """
        let versions = (1...skill.version).map { version in
            ShannonSkillDetailDTO.Revision(
                version: version, kind: "version", actor: version == 1 ? "sleep" : (skill.ownerVersion && version == skill.version ? "owner" : "sleep"),
                reason: version == 1 ? "built" : "patch", uses: version == skill.version ? skill.uses : 3, successes: version == skill.version ? skill.successes : 2,
                createdAt: Self.ago(hours: Double(24 * (skill.version - version + 1)))
            )
        }
        return ShannonSkillDetailDTO(skill: skill, body: body, bodyHidden: hidden, versions: versions)
    }

    func setShannonSkillPinned(scopeKey: String, id: String, pinned: Bool) async throws -> ShannonSkillDTO {
        guard var skill = Self.fixtureSkills.first(where: { $0.id == id }) else { throw ShannonAPIError.rejected(status: 404) }
        try? await Task.sleep(for: .milliseconds(400))
        skill.pinned = pinned
        return skill
    }
}
#endif
