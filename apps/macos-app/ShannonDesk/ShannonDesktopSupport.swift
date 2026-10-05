import Foundation
import ShannonAppCore
import SwiftUI

enum DesktopDevelopmentTool: String, CaseIterable, Hashable, Identifiable {
    case files
    case terminal
    case changes
    case git
    case build
    var id: String { rawValue }
    var title: String {
        switch self {
        case .files: "ファイル"
        case .terminal: "ターミナル"
        case .changes: "差分"
        case .git: "Git"
        case .build: "ビルド"
        }
    }
    var symbolName: String {
        switch self {
        case .files: "folder"
        case .terminal: "terminal"
        case .changes: "doc.text.magnifyingglass"
        case .git: "arrow.triangle.branch"
        case .build: "hammer"
        }
    }
}

struct ShannonDesktopWindowChromeState: Equatable {
    let showsInspector: Bool, auxiliaryPanel: DesktopAuxiliaryPanel
}
enum ShannonDesktopWindowRestoration {
    static let lastInspectorVisibleKey = "shannon.desktop.lastShowsInspector"
    static let lastAuxiliaryPanelKey = "shannon.desktop.lastAuxiliaryPanel"
    static func destination(sceneRawValue: String?, lastRawValue: String) -> DesktopDestination {
        if let sceneRawValue, let destination = DesktopDestination(restoring: sceneRawValue) {
            return destination
        }
        return DesktopDestination(restoring: lastRawValue) ?? .talk
    }
    static func identifier(sceneValue: String?, lastValue: String) -> String? {
        if let sceneValue, !sceneValue.isEmpty { return sceneValue }
        return lastValue.isEmpty ? nil : lastValue
    }
    static func inspectorVisible(sceneRawValue: String?, lastValue: Bool) -> Bool {
        switch sceneRawValue {
        case "visible": true
        case "hidden": false
        default: lastValue
        }
    }

    static func auxiliaryPanel(sceneRawValue: String?, lastRawValue: String) -> DesktopAuxiliaryPanel {
        if let sceneRawValue, let panel = DesktopAuxiliaryPanel(rawValue: sceneRawValue) {
            return panel
        }
        return DesktopAuxiliaryPanel(rawValue: lastRawValue) ?? .task
    }

    static func windowChrome(sceneInspectorRawValue: String?, sceneAuxiliaryPanelRawValue: String?,
                             lastInspectorVisible: Bool, lastAuxiliaryPanelRawValue: String)
        -> ShannonDesktopWindowChromeState {
        ShannonDesktopWindowChromeState(
            showsInspector: inspectorVisible(sceneRawValue: sceneInspectorRawValue, lastValue: lastInspectorVisible),
            auxiliaryPanel: auxiliaryPanel(sceneRawValue: sceneAuxiliaryPanelRawValue,
                                           lastRawValue: lastAuxiliaryPanelRawValue)
        )
    }
}

enum ShannonDesktopDevelopmentOptions {
    static func normalizedModelID(
        _ selectedModelID: String,
        models: [ShannonAgentModelDTO]
    ) -> String {
        ShannonAgentDevelopmentOptions.normalizedModelID(selectedModelID, models: models)
    }

    static func normalizedReasoningEffort(
        _ selectedEffort: ShannonAgentReasoningEffort,
        modelID: String,
        models: [ShannonAgentModelDTO]
    ) -> ShannonAgentReasoningEffort {
        ShannonAgentDevelopmentOptions.normalizedReasoningEffort(
            selectedEffort,
            modelID: modelID,
            models: models
        )
    }
}

struct DevelopmentFileNode: Identifiable {
    let path: String
    let name: String
    let children: [DevelopmentFileNode]?
    var id: String { path }

    static func roots(paths: [String]) -> [DevelopmentFileNode] {
        nodes(prefix: "", paths: paths)
    }

    private static func nodes(prefix: String, paths: [String]) -> [DevelopmentFileNode] {
        let groups = Dictionary(grouping: paths) { $0.split(separator: "/").first.map(String.init) ?? $0 }
        return groups.keys.sorted().map { component in
            let path = prefix.isEmpty ? component : "\(prefix)/\(component)"
            let descendants = (groups[component] ?? []).compactMap { value -> String? in
                let parts = value.split(separator: "/", maxSplits: 1).map(String.init)
                return parts.count == 2 ? parts[1] : nil
            }
            return DevelopmentFileNode(
                path: path,
                name: component,
                children: descendants.isEmpty ? nil : nodes(prefix: path, paths: descendants)
            )
        }
    }
}

struct ShannonDesktopCommandActions {
    let focusThreadSearch: () -> Void
    let showTalk: () -> Void
    let showWork: () -> Void
    let showShannon: () -> Void
    let showDevelopment: () -> Void
    let showRelease: () -> Void
    let showSettings: () -> Void
    let toggleOutline: () -> Void
    let toggleTaskInspector: () -> Void
}

private struct ShannonDesktopCommandActionsKey: FocusedValueKey {
    typealias Value = ShannonDesktopCommandActions
}

extension FocusedValues {
    var shannonDesktopCommandActions: ShannonDesktopCommandActions? {
        get { self[ShannonDesktopCommandActionsKey.self] }
        set { self[ShannonDesktopCommandActionsKey.self] = newValue }
    }
}

enum ShannonDesktopThreadSearch {
    static func matches(_ threads: [ChatThreadDTO], query: String) -> [ChatThreadDTO] {
        let foldedQuery = normalized(query)
        guard !foldedQuery.isEmpty else { return threads }
        return threads.filter { thread in
            searchableValues(for: thread).contains { normalized($0).contains(foldedQuery) }
        }
    }

    static func firstResultID(in threads: [ChatThreadDTO], query: String) -> String? {
        matches(threads, query: query).first?.threadId
    }

    static func matchContext(for thread: ChatThreadDTO, query: String) -> String? {
        let foldedQuery = normalized(query)
        guard !foldedQuery.isEmpty else { return nil }
        return [thread.summary].compactMap { $0 }.first { normalized($0).contains(foldedQuery) }
            ?? (thread.sections ?? []).first { normalized($0).contains(foldedQuery) }
    }

    private static func searchableValues(for thread: ChatThreadDTO) -> [String] {
        [thread.title] + [thread.summary].compactMap { $0 } + (thread.sections ?? [])
    }

    private static func normalized(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(
                options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
                locale: .current
            )
    }
}

struct ShannonDesktopThreadProjection {
    let initiative: [ChatThreadDTO]
    let conversations: [ChatThreadDTO]
    let isSearching: Bool

    init(threads: [ChatThreadDTO], initiativeThreadIDs: Set<String>, query: String) {
        let isSearching = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let visible = ShannonDesktopThreadSearch.matches(threads, query: query)
        self.isSearching = isSearching
        if isSearching {
            initiative = []
            conversations = visible
        } else {
            initiative = visible.filter { initiativeThreadIDs.contains($0.threadId) }
            conversations = visible.filter { !initiativeThreadIDs.contains($0.threadId) }
        }
    }

    var allVisible: [ChatThreadDTO] {
        initiative + conversations
    }
}

enum ShannonDesktopTaskFilter: String, CaseIterable, Identifiable {
    case all, attention, active, proposed, finished
    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: "すべて"
        case .attention: "対応待ち"
        case .active: "進行中"
        case .proposed: "提案"
        case .finished: "終了"
        }
    }
}

struct ShannonDesktopWorkProjection {
    let pinned: [ShannonAgentTask]
    let active: [ShannonAgentTask]
    let proposed: [ShannonAgentTask]
    let finished: [ShannonAgentTask]
    let archived: [ShannonAgentTask]

    init(tasks: [ShannonAgentTask], query: String = "", filter: ShannonDesktopTaskFilter = .all) {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let matching = tasks.filter { task in
            let matchesQuery = normalizedQuery.isEmpty || [
                task.title, task.goal, task.summary, task.currentAction,
                task.projectHint, task.assignedHostID
            ].compactMap { $0 }.contains { $0.localizedCaseInsensitiveContains(normalizedQuery) }
            guard matchesQuery else { return false }
            switch filter {
            case .all: return true
            case .attention: return task.status == .waitingApproval || task.needsOwnerToContinue || task.status == .failed
            case .active: return task.status.isActive
            case .proposed: return task.status == .proposed
            case .finished: return task.status.isTerminal
            }
        }
        let sorted = matching.sorted {
            if $0.isPinned != $1.isPinned { return $0.isPinned }
            return $0.updatedAt > $1.updatedAt
        }
        archived = sorted.filter(\.isArchived)
        let visible = sorted.filter { !$0.isArchived }
        pinned = visible.filter(\.isPinned)
        active = visible.filter { !$0.isPinned && $0.status.isActive }
        proposed = visible.filter { !$0.isPinned && $0.status == .proposed }
        finished = visible.filter { !$0.isPinned && $0.status.isTerminal }
    }

    static func nextAction(for task: ShannonAgentTask) -> String {
        if task.status == .waitingApproval { return "あなたが許可するかを決める" }
        if let nextAction = task.nextAction { return nextAction }
        if let item = task.plan.first(where: { $0.status == .pending }) { return item.title }
        if task.status == .proposed { return "あなたが開始するかを選ぶ" }
        if task.status.isTerminal { return "結果を確認し、必要なら次の作業を決める" }
        return "次の作業工程を確認中"
    }
}

enum ShannonDesktopTaskRestoration {
    static func resolve(rawValue: String?, tasks: [ShannonAgentTask]) -> UUID? {
        if let rawValue,
           let restoredID = UUID(uuidString: rawValue),
           tasks.contains(where: { $0.id == restoredID }) {
            return restoredID
        }

        let projection = ShannonDesktopWorkProjection(tasks: tasks)
        return projection.pinned.first?.id
            ?? projection.active.first?.id
            ?? projection.proposed.first?.id
            ?? projection.finished.first?.id
    }
}

struct ShannonDesktopConversationContext: Equatable {
    let threadID: String
    let sourceMessageID: UUID?

    init(task: ShannonAgentTask) {
        threadID = task.conversationThreadID
        sourceMessageID = task.sourceMessageID
    }

    func title(in threads: [ChatThreadDTO]) -> String {
        threads.first(where: { $0.threadId == threadID })?.title ?? "この作業を始めたトーク"
    }
}

struct ShannonDesktopTaskActionPolicy: Equatable {
    let canStart: Bool
    let canPause: Bool
    let canResume: Bool
    let canSteer: Bool
    let canCancel: Bool

    init(status: ShannonAgentTaskStatus) {
        canStart = status == .proposed
        canPause = status == .running
        canResume = status == .paused
        canSteer = [.queued, .starting, .running, .waitingApproval, .paused].contains(status)
        canCancel = !status.isTerminal
    }
}

struct ShannonDesktopConversationOutlineEntry: Equatable, Identifiable {
    enum Kind: Equatable {
        case request
        case heading
    }

    let id: String
    let messageID: UUID
    let title: String
    let level: Int
    let kind: Kind
}

enum ShannonDesktopConversationOutline {
    static func requestAnchorID(messageID: UUID) -> String {
        "\(messageID.uuidString)-request"
    }

    static func headingAnchorID(messageID: UUID, blockIndex: Int) -> String {
        "\(messageID.uuidString)-heading-\(blockIndex)"
    }

    static func entries(from messages: [ConversationMessage]) -> [ShannonDesktopConversationOutlineEntry] {
        var result: [ShannonDesktopConversationOutlineEntry] = []
        for message in messages {
            switch message.role {
            case .user:
                guard let title = excerpt(from: message.text) else { continue }
                result.append(ShannonDesktopConversationOutlineEntry(
                    id: requestAnchorID(messageID: message.id),
                    messageID: message.id,
                    title: title,
                    level: 0,
                    kind: .request
                ))
            case .shannon:
                for (index, block) in ShannonMessageMarkdown.blocks(from: message.text).enumerated() {
                    guard case let .heading(level, text) = block else { continue }
                    let title = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !title.isEmpty else { continue }
                    result.append(ShannonDesktopConversationOutlineEntry(
                        id: headingAnchorID(messageID: message.id, blockIndex: index),
                        messageID: message.id,
                        title: title,
                        level: level,
                        kind: .heading
                    ))
                }
            }
        }
        return result
    }

    static func activeEntryID(
        entries: [ShannonDesktopConversationOutlineEntry],
        verticalPositions: [String: CGFloat],
        activationLine: CGFloat
    ) -> String? {
        let positioned = entries.compactMap { entry -> (String, CGFloat)? in
            guard let position = verticalPositions[entry.id] else { return nil }
            return (entry.id, position)
        }
        guard !positioned.isEmpty else { return nil }

        if let passed = positioned
            .filter({ $0.1 <= activationLine })
            .max(by: { $0.1 < $1.1 }) {
            return passed.0
        }
        return positioned.min(by: { $0.1 < $1.1 })?.0
    }

    static func searchTargetMessageID(in messages: [ConversationMessage], query: String) -> UUID? {
        let query = normalized(query)
        guard !query.isEmpty else { return nil }
        if let section = entries(from: messages).first(where: { normalized($0.title).contains(query) }) {
            return section.messageID
        }
        return messages.reversed().first { normalized($0.text).contains(query) }?.id
    }

    private static func excerpt(from text: String) -> String? {
        let compact = text
            .split(whereSeparator: \Character.isWhitespace)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !compact.isEmpty else { return nil }
        let limit = 68
        guard compact.count > limit else { return compact }
        return String(compact.prefix(limit)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }


    private static func normalized(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(
                options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
                locale: .current
            )
    }
}

/// Names come from the shared `ShannonFace` table; the Mac keeps no table of its own.
enum DesktopExpressionLabel {
    static func stateDescription(for face: ShannonFace) -> String {
        "\(face.japaneseName)。作業の判断は状態ではなく、計画と検証結果に基づいて行います。"
    }
}
struct ShannonDesktopRepositoryInput: Equatable {
    let repositoryURL: String
    let projectKey: String

    init(repositoryURL: String, projectKey: String) {
        self.repositoryURL = repositoryURL.trimmingCharacters(in: .whitespacesAndNewlines)
        self.projectKey = projectKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    var isValid: Bool {
        guard let components = URLComponents(string: repositoryURL),
              components.scheme == "https",
              components.host?.lowercased() == "github.com",
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.split(separator: "/").count == 2 else { return false }
        let coordinatePattern = #"^[A-Za-z0-9_.-]+$"#
        let coordinates = components.path.split(separator: "/").map(String.init)
        let owner = coordinates[0]
        let repository = coordinates[1].replacingOccurrences(
            of: #"\.git$"#,
            with: "",
            options: .regularExpression
        )
        guard owner != ".", owner != "..", repository != ".", repository != "..",
              owner.range(of: coordinatePattern, options: .regularExpression) != nil,
              repository.range(of: coordinatePattern, options: .regularExpression) != nil else { return false }
        return projectKey.range(of: #"^[a-z0-9][a-z0-9._-]{0,63}$"#, options: .regularExpression) != nil
    }

    static func suggestedKey(from repositoryURL: String) -> String {
        guard let component = URLComponents(string: repositoryURL)?.path.split(separator: "/").last else { return "" }
        return String(component).replacingOccurrences(of: ".git", with: "").lowercased()
    }
}
