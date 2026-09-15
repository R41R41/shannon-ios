import AppKit
import ShannonAppCore
import SwiftUI

extension ShannonDesktopRootView {
    var developmentStatusBar: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                DevelopmentRouteBadge(host: selectedDevelopmentHost)
                Text(developmentRoutingExplanation)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 12)
                Label(developmentBillingLabel, systemImage: developmentBillingSymbol)
                    .foregroundStyle(developmentBillingColor)
            }

            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    DevelopmentRouteBadge(host: selectedDevelopmentHost)
                    Spacer()
                    Label(developmentBillingLabel, systemImage: developmentBillingSymbol)
                        .foregroundStyle(developmentBillingColor)
                }
                Text(developmentRoutingExplanation)
                    .lineLimit(2)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    var developmentProjectMenu: some View {
        Menu {
            Picker("プロジェクト", selection: $selectedAgentProject) {
                ForEach(developmentProjectKeys, id: \.self) { project in
                    Text(project).tag(project)
                }
            }
            Divider()
            Button {
                showsAddAgentProject = true
            } label: {
                Label("GitHubリポジトリを追加", systemImage: "plus")
            }
            if let provisioning = conversation.agentProjectProvisioning.first,
               provisioning.status != .ready {
                Divider()
                Label(
                    provisioning.errorMessage
                        ?? "\(provisioning.projectKey) · \(provisioning.status.japaneseName)",
                    systemImage: provisioning.status == .failed ? "exclamationmark.triangle" : "arrow.down.circle"
                )
            }
        } label: {
            Label(selectedAgentProject, systemImage: "folder")
        }
        .help("プロジェクトを選択")
        .accessibilityLabel("プロジェクト、\(selectedAgentProject)")
    }

    var developmentExecutionMenu: some View {
        Menu {
            Picker("実行先", selection: Binding(
                get: { agentHostPreference },
                set: { agentHostPreference = $0 }
            )) {
                ForEach(ShannonAgentRoutingPreference.allCases) { preference in
                    Text(preference.japaneseName).tag(preference)
                }
            }
        } label: {
            Label(agentHostPreference.japaneseName, systemImage: developmentHostSymbol)
        }
        .help("実行先を選択。自動はこのMacを優先します")
        .accessibilityLabel("実行先、\(agentHostPreference.japaneseName)")
    }

    var developmentModelMenu: some View {
        Menu {
            Section("モデル") {
                Picker("モデル", selection: $selectedAgentModel) {
                    Text("ホストの既定").tag("")
                    ForEach(developmentModels) { model in
                        Text(model.displayName).tag(model.id)
                    }
                }
            }
            Section("思考") {
                Picker("思考", selection: Binding(
                    get: { agentReasoningEffort },
                    set: { agentReasoningEffort = $0 }
                )) {
                    ForEach(availableReasoningEfforts) { effort in
                        Text(effort.japaneseName).tag(effort)
                    }
                }
            }
        } label: {
            Label(developmentModelLabel, systemImage: "cpu")
        }
        .help("モデルと思考レベルを選択")
        .accessibilityLabel("モデル設定、\(developmentModelLabel)、思考\(agentReasoningEffort.japaneseName)")
    }

    var developmentProjectPicker: some View {
        HStack(spacing: 6) {
            Picker("プロジェクト", selection: $selectedAgentProject) {
                ForEach(developmentProjectKeys, id: \.self) { project in
                    Text(project).tag(project)
                }
            }
            Button {
                showsAddAgentProject = true
            } label: {
                Label("GitHubリポジトリを追加", systemImage: "plus")
            }
            .labelStyle(.iconOnly)
            .help("GitHubリポジトリを安全な作業領域へ追加")
        }
    }

    var developmentHostPicker: some View {
        Picker("実行先", selection: Binding(
            get: { agentHostPreference },
            set: { agentHostPreference = $0 }
        )) {
            ForEach(ShannonAgentRoutingPreference.allCases) { preference in
                Text(preference.japaneseName).tag(preference)
            }
        }
        .help("自動はこのMacを優先し、利用できない場合だけクラウドへ切り替えます")
    }

    var developmentModelPicker: some View {
        Picker("モデル", selection: $selectedAgentModel) {
            Text("ホストの既定").tag("")
            ForEach(developmentModels) { model in
                Text(model.displayName).tag(model.id)
            }
        }
    }

    var developmentReasoningPicker: some View {
        Picker("思考", selection: Binding(
            get: { agentReasoningEffort },
            set: { agentReasoningEffort = $0 }
        )) {
            ForEach(availableReasoningEfforts) { effort in
                Text(effort.japaneseName).tag(effort)
            }
        }
    }
}
