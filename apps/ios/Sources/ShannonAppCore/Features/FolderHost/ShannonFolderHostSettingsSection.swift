#if os(macOS)
import SwiftUI

/// 設定 › 専用フォルダ on the Mac (A18 S2), the same items as on Windows: the state and place, choosing the folder, the
/// pause on this Mac, opening it, the self-check, stopping, and the local log of what was done (never what a file says).
/// Buttons and plain rows only: no system segmented picker in a list row (it hung accessibility before).
public struct ShannonFolderHostSettingsSection: View {
    @Bindable private var model: ShannonFolderHostModel
    @State private var confirmsForget = false
    @State private var checking = false

    public init(model: ShannonFolderHostModel = .shared) {
        self.model = model
    }

    public var body: some View {
        Section {
            LabeledContent(ShannonGeneratedStrings.folderHostState, value: stateText)
                .accessibilityIdentifier("settings-folder-state")
            if let folder = model.folder {
                LabeledContent(ShannonGeneratedStrings.folderHostPlace, value: folder.path)
                    .textSelection(.enabled)
            }
            if let problem = model.problem {
                Text(problem)
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(Color.shannonDanger)
            }
            if model.isChosen {
                Text(linkText)
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("settings-folder-link")
            }
            if model.state == .paused {
                Text(ShannonGeneratedStrings.folderHostPausedNote)
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(.secondary)
            }
            buttons
            if let check = model.check {
                VStack(alignment: .leading, spacing: 4) {
                    Text(check.ok ? ShannonGeneratedStrings.folderHostCheckOK : ShannonGeneratedStrings.folderHostCheckFailed)
                    ForEach(check.steps) { step in
                        Label {
                            Text(step.detail.map { "\(step.label) — \($0)" } ?? step.label)
                                .font(.shannonDesktop(.caption))
                        } icon: {
                            Image(systemName: step.ok ? "checkmark.circle" : "xmark.circle")
                                .foregroundStyle(step.ok ? Color.shannonSuccess : Color.shannonDanger)
                        }
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("settings-folder-check")
            }
        } header: {
            Text(ShannonGeneratedStrings.folderHostSection)
        } footer: {
            Text(ShannonGeneratedStrings.folderHostExplanation)
                .font(.shannonDesktop(.caption))
                .foregroundStyle(.secondary)
        }
        if !model.recent.isEmpty {
            Section(ShannonGeneratedStrings.folderHostLog(count: String(model.recent.count))) {
                ForEach(Array(model.recent.enumerated()), id: \.offset) { _, entry in
                    Text(logLine(entry))
                        .font(.shannonDesktop(.caption))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var buttons: some View {
        HStack(spacing: ShannonDesktopSpacing.small) {
            Button(ShannonGeneratedStrings.folderHostChoose) { model.chooseFolder() }
                .accessibilityIdentifier("settings-folder-choose")
            if model.isChosen {
                Button(model.isPaused ? ShannonGeneratedStrings.folderHostResume : ShannonGeneratedStrings.folderHostPause) {
                    model.setPaused(!model.isPaused)
                }
                .accessibilityIdentifier("settings-folder-pause")
                Button(ShannonGeneratedStrings.folderHostOpen) { model.openFolder() }
                    .disabled(model.folder == nil)
                Button(ShannonGeneratedStrings.folderHostCheck) {
                    checking = true
                    Task {
                        await model.runSelfCheck()
                        checking = false
                    }
                }
                .disabled(checking)
                .accessibilityIdentifier("settings-folder-check-button")
                Button(ShannonGeneratedStrings.folderHostForget, role: .destructive) { confirmsForget = true }
                    .accessibilityIdentifier("settings-folder-forget")
            }
        }
        .confirmationDialog(ShannonGeneratedStrings.folderHostForgetConfirm, isPresented: $confirmsForget) {
            Button(ShannonGeneratedStrings.folderHostForget, role: .destructive) { model.stopUsing() }
        }
    }

    private var stateText: String {
        switch model.state {
        case .unset: ShannonGeneratedStrings.folderHostStateUnset
        case .running: ShannonGeneratedStrings.folderHostStateRunning
        case .paused: ShannonGeneratedStrings.folderHostStatePaused
        case .failed: ShannonGeneratedStrings.folderHostStateError
        }
    }

    private var linkText: String {
        switch model.link {
        case .waiting: ShannonGeneratedStrings.folderHostWaiting
        case .notPaired: ShannonGeneratedStrings.folderHostNotPaired
        case .notRegistered: ShannonGeneratedStrings.folderHostNotRegistered(deviceId: model.deviceID ?? "—")
        case .connected(let host, let label, _): ShannonGeneratedStrings.folderHostConnected(label: label ?? host)
        case .offline: ShannonGeneratedStrings.folderHostOffline
        }
    }

    private func logLine(_ entry: ShannonFolderHostLogEntry) -> String {
        let when = ISO8601DateFormatter().date(from: entry.at.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression))
            .map { $0.formatted(date: .numeric, time: .shortened) } ?? entry.at
        let action = switch entry.operation {
        case "list": ShannonGeneratedStrings.folderHostLogList
        case "read": ShannonGeneratedStrings.folderHostLogRead
        case "search": ShannonGeneratedStrings.folderHostLogSearch
        default: entry.operation
        }
        let refused = entry.outcome == "done" ? "" : "（\(ShannonGeneratedStrings.folderHostLogRefused(code: entry.code ?? entry.outcome))）"
        return "\(when) \(action) \(entry.path.map { $0.isEmpty ? "/" : $0 } ?? "")\(refused)"
    }
}
#endif
