import ShannonAppCore
import SwiftUI

extension ShannonDesktopRootView {
    func loadDevelopmentWorkspaceResource(
        path: String,
        kind: ShannonAgentWorkspaceResourceKind
    ) {
        let projectKey = selectedAgentProject
        developmentWorkspaceResource = .loading(path: path, kind: kind)
        Task {
            do {
                let resource = try await conversation.loadAgentWorkspaceResource(
                    projectKey: projectKey,
                    path: path,
                    kind: kind,
                    hostPreference: agentHostPreference
                )
                guard selectedAgentProject == projectKey, selectedDevelopmentFilePath == path else { return }
                developmentWorkspaceResource = resource.status == .failed
                    ? .failed(
                        path: path,
                        kind: kind,
                        message: resource.errorMessage ?? "内容を取得できませんでした。"
                    )
                    : .loaded(resource)
            } catch is CancellationError {
                return
            } catch {
                guard selectedAgentProject == projectKey, selectedDevelopmentFilePath == path else { return }
                developmentWorkspaceResource = .failed(
                    path: path,
                    kind: kind,
                    message: "Agent Hostから内容を取得できませんでした。接続を確認して再試行してください。"
                )
            }
        }
    }
}
