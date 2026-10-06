import CoreGraphics
import Foundation
import ShannonAppCore

extension DesktopDevelopmentTool {
    static var initialValue: DesktopDevelopmentTool {
#if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if let flag = arguments.firstIndex(of: "-ShannonPreviewTool"), arguments.indices.contains(flag + 1),
           let tool = DesktopDevelopmentTool(rawValue: arguments[flag + 1]) {
            return tool
        }
#endif
        return .changes
    }
}

enum ShannonDesktopDevelopmentLayout {
    static let taskNavigatorThreshold: CGFloat = 720
    static let changeNavigatorThreshold: CGFloat = 680

    static func showsTaskNavigator(availableWidth: CGFloat) -> Bool {
        availableWidth >= taskNavigatorThreshold
    }

    static func showsChangeNavigator(availableWidth: CGFloat) -> Bool {
        availableWidth >= changeNavigatorThreshold
    }

    /// A shown navigator stays until the width is this far below its threshold, so that a width at the
    /// threshold cannot switch the arrangement back and forth. 24 points covers what the switch itself can
    /// take from the width: a legacy (always shown) scroller of about 16 points appearing in a pane, plus a
    /// divider and a little rounding. Down to the threshold minus 24 the wide panes still fit (696 points
    /// for a 240-point list and a 360-point workspace, 656 for a 270-point list and a 360-point detail).
    static let hysteresis: CGFloat = 24

    /// Whether the wide arrangement is shown at `width`, given the one shown now (nil before the first reading).
    static func showsWide(width: CGFloat, threshold: CGFloat, showingWide: Bool?) -> Bool {
        showingWide == true ? width >= threshold - hysteresis : width >= threshold
    }
}

struct ShannonDesktopReviewChange: Equatable, Identifiable {
    let id: String
    let displayName: String
    let path: String
    let summary: String
    let status: String?
    let additions: Int
    let deletions: Int
    let diffPreview: String?

    static func items(
        project: ShannonAgentProjectDTO?,
        task: ShannonAgentTask
    ) -> [ShannonDesktopReviewChange] {
        if !task.changes.isEmpty {
            return deduplicated(task.changes.map { change in
                let path = change.path ?? change.displayName
                return ShannonDesktopReviewChange(
                    id: path,
                    displayName: change.displayName,
                    path: path,
                    summary: change.summary,
                    status: nil,
                    additions: change.additions,
                    deletions: change.deletions,
                    diffPreview: change.diffPreview
                )
            })
        }

        return deduplicated((project?.changes ?? []).map { change in
            ShannonDesktopReviewChange(
                id: change.path,
                displayName: URL(fileURLWithPath: change.path).lastPathComponent,
                path: change.path,
                summary: "ワークスペースの変更",
                status: change.status,
                additions: change.additions,
                deletions: change.deletions,
                diffPreview: nil
            )
        })
    }

    private static func deduplicated(
        _ changes: [ShannonDesktopReviewChange]
    ) -> [ShannonDesktopReviewChange] {
        var order: [String] = []
        var latestByID: [String: ShannonDesktopReviewChange] = [:]
        for change in changes {
            if latestByID[change.id] == nil {
                order.append(change.id)
            }
            latestByID[change.id] = change
        }
        return order.compactMap { latestByID[$0] }
    }
}

struct ShannonDesktopDiffLine: Equatable, Identifiable {
    let id: Int
    let text: String
}

enum ShannonDesktopDiffProjection {
    static func lines(in diff: String) -> [ShannonDesktopDiffLine] {
        diff.components(separatedBy: .newlines).enumerated().map { offset, line in
            ShannonDesktopDiffLine(id: offset, text: line)
        }
    }
}

enum ShannonDesktopWorkspaceResourceState: Equatable {
    case idle
    case loading(path: String, kind: ShannonAgentWorkspaceResourceKind)
    case loaded(ShannonAgentWorkspaceResourceDTO)
    case failed(path: String, kind: ShannonAgentWorkspaceResourceKind, message: String)

    func matches(path: String, kind: ShannonAgentWorkspaceResourceKind) -> Bool {
        switch self {
        case let .loading(resourcePath, resourceKind), let .failed(resourcePath, resourceKind, _):
            resourcePath == path && resourceKind == kind
        case let .loaded(resource):
            resource.path == path && resource.kind == kind
        case .idle:
            false
        }
    }
}
