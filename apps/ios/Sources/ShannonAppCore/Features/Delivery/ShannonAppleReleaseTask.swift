import Foundation

public enum ShannonAppleReleaseTarget: String, CaseIterable, Equatable, Sendable {
    case iOS
    case macOS

    public var displayName: String {
        switch self {
        case .iOS: "iPhone版"
        case .macOS: "Mac版"
        }
    }
}

enum ShannonAppleReleaseTaskFactory {
    static func make(
        target: ShannonAppleReleaseTarget,
        threadID: String,
        sourceMessageID: UUID? = nil
    ) -> ShannonAgentTask {
        let gateNames = ["Build", "Archive", "Upload", "Processing", "Assignment", "Install", "Smoke"]
        let platformDetail = target == .iOS
            ? "iOSのArchiveをApp Store ConnectへUploadし、Internal TestFlightへ割り当てる"
            : "macOSのArchiveをApp Store ConnectへUploadし、Internal TestFlightへ割り当てる"
        return ShannonAgentTask(
            conversationThreadID: threadID,
            sourceMessageID: sourceMessageID,
            title: "Shannon \(target.displayName)を配信",
            goal: """
            Shannon \(target.displayName)の配信を、Build・Archive・Upload・Processing・Assignment・Install・Smokeの7ゲートで進めてください。\(platformDetail)。各ゲートは確認できた事実だけを報告し、未確認を完了扱いにしないでください。署名・Upload・配信先変更など承認が必要な操作は、内容と影響を示して承認を待ってください。InstallとSmokeはユーザーの実機確認を待ってください。
            """,
            hostHint: ShannonAgentRoutingPreference.auto.rawValue,
            projectHint: "shannon-ios",
            status: .proposed,
            summary: "配信の7ゲートを、証拠と承認を残しながら進める作業です。",
            plan: gateNames.enumerated().map { index, name in
                ShannonAgentPlanItem(id: "release-\(index + 1)", title: name, status: .pending)
            }
        )
    }
}
