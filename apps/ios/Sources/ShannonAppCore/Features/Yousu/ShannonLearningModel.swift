import Foundation
import Observation

/// 「ようす › 学び」 (Syzygy ADR-0008 §13, option A): her skills, 手応え (the value table's recent cells) and the value table's
/// version with 「前の版に戻す」 and resume. The skills and the values are read on their own: a part the server does not offer
/// to this device (403, 404) is left out, as 気分の推移 is, and any other failure keeps the last good answer with
/// 「読めませんでした」.
@MainActor
@Observable
public final class ShannonLearningModel {
    public enum Phase: Equatable, Sendable {
        /// Not answered yet.
        case loading
        case loaded
        /// Not offered to this device: the part is not shown.
        case hidden
        /// The last read failed; the last good answer, if any, is kept.
        case unreadable
    }

    public private(set) var valuesPhase: Phase = .loading
    public private(set) var skillsPhase: Phase = .loading
    public private(set) var values: ShannonValuesDTO?
    public private(set) var skills: ShannonSkillsDTO?
    /// When the values were last read: 手応え counts its seven days back from here.
    public private(set) var readAt = Date()
    /// Skills whose pin is being sent: their switch waits for the answer.
    public private(set) var pinsInFlight: Set<String> = []
    /// One sentence when a pin or unpin did not go through (the switch is back where it was).
    public private(set) var skillNotice: String?
    /// One sentence when a rollback or a resume did not go through.
    public private(set) var valuesNotice: String?
    public private(set) var isChangingValues = false

    private let scopeKey: String
    private let client: (any ShannonYousuServing)?
    /// The pinned state shown while its request is in flight, laid over every answer that arrives meanwhile.
    private var optimisticPins: [String: Bool] = [:]
    private var generation = 0
    /// Moves on when a pin starts and when it ends: a list read that started before either is older than what the screen
    /// shows, and is not applied (it could undo the pin).
    private var skillsGeneration = 0

    public init(scopeKey: String = "local-owner", client: (any ShannonYousuServing)?) {
        self.scopeKey = scopeKey
        self.client = client
        if client == nil {
            valuesPhase = .hidden
            skillsPhase = .hidden
        }
    }

    /// Neither part is offered to this device: the 学び tab is not offered either.
    public var isUnavailable: Bool { valuesPhase == .hidden && skillsPhase == .hidden }
    /// Some part has been read successfully on this device: only then is the 学び tab offered.
    public var isOffered: Bool { skills != nil || values != nil }
    public var isLoading: Bool { valuesPhase == .loading || skillsPhase == .loading }

    public var activeSkills: [ShannonSkillDTO] { (skills?.skills ?? []).filter { !$0.isRetired } }
    public var retiredSkills: [ShannonSkillDTO] { (skills?.skills ?? []).filter(\.isRetired) }
    public var recentValues: [ShannonValueLine] { ShannonLearning.recentLines(values?.cells ?? [], now: readAt) }
    public var rollbackTarget: ShannonValuesDTO.Version? { values.flatMap(ShannonLearning.rollbackTarget) }

    public func reload() async {
        guard let client else { return }
        generation += 1
        let (scopeKey, request, skillsRequest) = (scopeKey, generation, skillsGeneration)
        async let valuesRead = Self.read { try await client.loadShannonValues(scopeKey: scopeKey) }
        async let skillsRead = Self.read { try await client.loadShannonSkills(scopeKey: scopeKey) }
        let (valuesResult, skillsResult) = await (valuesRead, skillsRead)
        guard request == generation else { return }
        switch valuesResult {
        case .value(let answer):
            values = answer
            readAt = Date()
            valuesPhase = .loaded
        case .absent:
            values = nil
            valuesPhase = .hidden
        case .failed:
            valuesPhase = .unreadable
        case .cancelled:
            if valuesPhase == .loading, values == nil { valuesPhase = .unreadable }
        }
        // A pin started or ended while the list was read: what the screen shows is newer than this answer.
        guard skillsRequest == skillsGeneration else { return }
        switch skillsResult {
        case .value(var answer):
            for index in answer.skills.indices {
                if let pinned = optimisticPins[answer.skills[index].id] { answer.skills[index].pinned = pinned }
            }
            skills = answer
            skillsPhase = .loaded
        case .absent:
            skills = nil
            skillsPhase = .hidden
        case .failed:
            skillsPhase = .unreadable
        case .cancelled:
            if skillsPhase == .loading, skills == nil { skillsPhase = .unreadable }
        }
    }

    // MARK: Pins

    /// Pins or unpins a skill at once on screen, then asks the server. When the server does not take it, the switch goes back
    /// and one sentence says so; when it does, the skill is shown as the server answered.
    public func setPinned(_ skillID: String, pinned: Bool) async {
        guard let client, !pinsInFlight.contains(skillID), let index = skills?.skills.firstIndex(where: { $0.id == skillID }),
              !skills!.skills[index].isWithheld else { return }
        let before = skills!.skills[index].pinned
        guard before != pinned else { return }
        skillNotice = nil
        skillsGeneration += 1
        pinsInFlight.insert(skillID)
        optimisticPins[skillID] = pinned
        skills!.skills[index].pinned = pinned
        defer {
            skillsGeneration += 1
            pinsInFlight.remove(skillID)
            optimisticPins[skillID] = nil
        }
        do {
            let answer = try await client.setShannonSkillPinned(scopeKey: scopeKey, id: skillID, pinned: pinned)
            replace(answer)
        } catch {
            if let current = skills?.skills.firstIndex(where: { $0.id == skillID }) { skills!.skills[current].pinned = before }
            skillNotice = pinned ? ShannonGeneratedStrings.yousuLearningSkillsPinFailed : ShannonGeneratedStrings.yousuLearningSkillsUnpinFailed
        }
    }

    private func replace(_ skill: ShannonSkillDTO) {
        guard let index = skills?.skills.firstIndex(where: { $0.id == skill.id }) else { return }
        skills!.skills[index] = skill
    }

    // MARK: The value table

    /// 「前の版に戻す」, after the owner confirmed it: back to `target` (the version the confirmation named).
    public func rollback(to target: ShannonValuesDTO.Version?) async {
        await changeValues(expectsFrozen: true) { client, scopeKey in try await client.rollbackShannonValues(scopeKey: scopeKey, versionID: target?.versionId) }
    }

    /// 「更新を再開する」, after the owner confirmed it.
    public func resume() async {
        await changeValues(expectsFrozen: false) { client, scopeKey in try await client.resumeShannonValues(scopeKey: scopeKey) }
    }

    /// `expectsFrozen`: whether the table is frozen once the change has arrived (after a rollback, yes; after a resume, no).
    private func changeValues(expectsFrozen: Bool, _ operation: @escaping (any ShannonYousuServing, String) async throws -> ShannonValuesDTO) async {
        guard let client, !isChangingValues else { return }
        isChangingValues = true
        valuesNotice = nil
        defer { isChangingValues = false }
        do {
            let answer = try await operation(client, scopeKey)
            generation += 1
            values = answer
            readAt = Date()
            valuesPhase = .loaded
        } catch {
            // What the server holds now is read again, so the card never shows a change that did not happen, and never says
            // a change failed that in fact arrived (a timeout after the server wrote it). The request is never sent twice.
            if let rejected = error as? ShannonAPIError, case .rejected(let status) = rejected, (400..<500).contains(status) {
                valuesNotice = ShannonGeneratedStrings.yousuLearningVersionFailed
                await reload()
                return
            }
            let before = values?.active?.versionId
            valuesNotice = ShannonGeneratedStrings.yousuLearningVersionChecking
            await reload()
            guard valuesPhase == .loaded, let now = values else {
                valuesNotice = ShannonGeneratedStrings.yousuLearningVersionUnknown
                return
            }
            let arrived = now.active?.versionId != before && now.frozen == expectsFrozen
            valuesNotice = arrived ? ShannonGeneratedStrings.yousuLearningVersionArrived : ShannonGeneratedStrings.yousuLearningVersionFailed
        }
    }

    // MARK: Reading

    private enum Read<Value: Sendable>: Sendable {
        case value(Value)
        case absent
        case failed
        case cancelled
    }

    private nonisolated static func read<Value: Sendable>(_ operation: @Sendable () async throws -> Value) async -> Read<Value> {
        do {
            return .value(try await operation())
        } catch let error as ShannonAPIError where error == .rejected(status: 404) || error == .rejected(status: 403) {
            return .absent
        } catch where ShannonOpsModel.isCancellation(error) {
            return .cancelled
        } catch {
            return .failed
        }
    }
}

/// One skill's page: its SKILL.md (or the note in its place) and its versions.
@MainActor
@Observable
public final class ShannonSkillDetailModel {
    public enum Phase: Equatable, Sendable { case loading, loaded, unreadable }

    public private(set) var phase: Phase = .loading
    public private(set) var detail: ShannonSkillDetailDTO?

    public let skillID: String
    private let scopeKey: String
    private let client: (any ShannonYousuServing)?

    public init(skillID: String, scopeKey: String, client: (any ShannonYousuServing)?) {
        self.skillID = skillID
        self.scopeKey = scopeKey
        self.client = client
    }

    public func load() async {
        guard let client else { phase = .unreadable; return }
        do {
            detail = try await client.loadShannonSkill(scopeKey: scopeKey, id: skillID)
            phase = .loaded
        } catch where ShannonOpsModel.isCancellation(error) {
            if detail == nil { phase = .unreadable }
        } catch {
            phase = .unreadable
        }
    }

    /// The versions the owner reads: the safety copies taken before a rollback are left out, the newest first.
    public var versions: [ShannonSkillDetailDTO.Revision] {
        (detail?.versions ?? []).filter { $0.kind != "snapshot" }.sorted { $0.version > $1.version }
    }
}

extension ShannonLearningModel {
    /// The page of one skill, reading through the same client.
    public func detailModel(for skillID: String) -> ShannonSkillDetailModel {
        ShannonSkillDetailModel(skillID: skillID, scopeKey: scopeKey, client: client)
    }
}
