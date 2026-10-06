#if os(macOS)
import SwiftUI

/// 設定 › すがた › 配信用の出力（OBS） on the Mac (information-architecture.md 3: with the desktop body, and in the menu
/// bar item): the switch, off by default, the page's address while it is out, and why it could not start.
public struct ShannonStreamOutputSettingsSection: View {
    @Bindable private var model: ShannonStreamOutput

    public init(output: ShannonStreamOutput = .shared) {
        self.model = output
    }

    public var body: some View {
        Section {
            Toggle(ShannonGeneratedStrings.desktopStreamTitle, isOn: Binding(get: { model.isOn }, set: { model.setOn($0) }))
                .accessibilityIdentifier("settings-stream-output")
            if let status {
                Text(status)
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("settings-stream-output-status")
            }
            if model.state == .live {
                Button(ShannonGeneratedStrings.desktopStreamCopyURL) { model.copyPageURL() }
                    .accessibilityIdentifier("settings-stream-output-copy")
            }
            // What to keep in mind while it is on (owner decision 2026-10-06): her desktop body shown; what changes.
            Text(ShannonGeneratedStrings.desktopStreamKeepBodyShown)
                .font(.shannonDesktop(.caption))
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("settings-stream-output-keep-body")
            Text(ShannonGeneratedStrings.desktopStreamWhileOn)
                .font(.shannonDesktop(.caption))
                .foregroundStyle(.secondary)
        } header: {
            Text(ShannonGeneratedStrings.desktopStreamTitle)
        } footer: {
            Text(ShannonGeneratedStrings.desktopStreamExplanation)
                .font(.shannonDesktop(.caption))
                .foregroundStyle(.secondary)
        }
    }

    private var status: String? {
        switch model.state {
        case .off: nil
        case .starting: ShannonGeneratedStrings.desktopStreamStarting
        case .live: ShannonGeneratedStrings.desktopStreamLive(url: model.pageURL.absoluteString)
        case let .failed(reason): reason
        }
    }
}
#endif
