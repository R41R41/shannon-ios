import SwiftUI

/// One server-owned choice, with native rows on each platform. No local model override is persisted.
public struct ShannonModelModeSettingsSection: View {
    private let scopeKey: String
    private let client: (any ShannonModelModeServing)?
    private let connected: Bool
    private let isDesignPreview: Bool

    public init(scopeKey: String, client: (any ShannonModelModeServing)?, connected: Bool, isDesignPreview: Bool = false) {
        self.scopeKey = scopeKey; self.client = client; self.connected = connected; self.isDesignPreview = isDesignPreview
    }

    public init(conversation: ShannonConversationModel, connected: Bool) {
        self.init(scopeKey: conversation.scopeKey, client: conversation.client as? any ShannonModelModeServing,
                  connected: connected, isDesignPreview: conversation.isDesignPreview)
    }

    public var body: some View {
        ShannonModelModeSectionContent(scopeKey: scopeKey, client: client, connected: connected, isDesignPreview: isDesignPreview)
            .id(Identity(scope: scopeKey, connection: client?.modelModeConnection()))
    }

    private struct Identity: Hashable {
        let scope: String
        let connection: ShannonModelModeConnection?
    }
}

private struct ShannonModelModeSectionContent: View {
    @State private var model: ShannonModelModeModel
    private let connected: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme

    init(scopeKey: String, client: (any ShannonModelModeServing)?, connected: Bool, isDesignPreview: Bool) {
#if DEBUG
        if isDesignPreview, let preview = ShannonModelModePreview.configured(scopeKey: scopeKey) {
            _model = State(initialValue: ShannonModelModeModel(scopeKey: scopeKey, client: preview))
            self.connected = true
            return
        }
#endif
        _model = State(initialValue: ShannonModelModeModel(scopeKey: scopeKey, client: client))
        self.connected = connected
    }

    var body: some View {
        Section {
            ForEach(ShannonModelMode.allCases, id: \.self) { mode in
                choice(mode)
            }
            if let label = model.snapshot?.configuredModelLabel {
                Text(label)
                    .font(.shannon(.footnote))
                    .foregroundStyle(palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("settings-model-mode-configured")
            }
            HStack(spacing: ShannonSpacing.small) {
                if model.isLoading || model.isSaving { ProgressView().controlSize(.small) }
                Text(connected ? model.statusText : "シャノンに接続すると切り替えられます。")
                    .font(.shannon(.footnote))
                    .foregroundStyle(palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("settings-model-mode-status")
            if let notice = model.notice {
                Text(notice)
                    .font(.shannon(.footnote))
                    .foregroundStyle(palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !model.isLoading && !model.isSaving && connected && model.connectionIdentity != nil {
                Button("現在の設定を読み直す") { Task { await model.reload() } }
                    .frame(minHeight: ShannonTouchTarget.minimum)
                    .accessibilityIdentifier("settings-model-mode-reload")
            }
        } header: {
            Text("判断モデル")
        } footer: {
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                if let label = model.snapshot?.applicationLabel { Text(label) }
                Text("次に始まる処理から反映されます。高精度は費用が高めです。iPhoneとMacで共通の設定です。")
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .task(id: ReadKey(connection: model.connectionIdentity, connected: connected, active: scenePhase == .active)) {
            model.connectionDidChange()
            guard connected, scenePhase == .active else { return }
            await model.reload()
        }
    }

    private var palette: ShannonPalette { ShannonPalette.resolve(colorScheme) }

    private func choice(_ mode: ShannonModelMode) -> some View {
        let selected = model.snapshot?.isSelected(mode) == true
        let available = model.snapshot?.isAvailable(mode) == true
        return Button { Task { await model.select(mode) } } label: {
            HStack(spacing: ShannonSpacing.small) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(mode.title).foregroundStyle(palette.textPrimary)
                    if model.snapshot != nil && !available {
                        Text("サーバーで利用できません")
                            .font(.shannon(.caption))
                            .foregroundStyle(palette.textSecondary)
                    }
                }
                Spacer(minLength: ShannonSpacing.small)
                if selected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(palette.action)
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!connected || !model.canChange || !available)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityHint(available ? "次に始まる処理から反映されます" : "現在は切り替えられません")
        .accessibilityIdentifier("settings-model-mode-\(mode.rawValue)")
    }

    private struct ReadKey: Hashable {
        let connection: ShannonModelModeConnection?
        let connected: Bool
        let active: Bool
    }
}
