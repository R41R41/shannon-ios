#if os(macOS)
import SwiftUI

/// 設定 › すがた › デスクトップの体 on the Mac (information-architecture.md 3: the desktop body's 入切, 常に手前 and
/// 大きさ are in 設定 › すがた and in the menu bar item): her window, whether she stays on top, her size, her eyes alone
/// when small, and whether she speaks up through it.
public struct ShannonDesktopBodySettingsSection: View {
    @Bindable private var model: ShannonDesktopBody

    public init(body: ShannonDesktopBody = .shared) {
        self.model = body
    }

    public var body: some View {
        Section {
            Toggle(ShannonGeneratedStrings.desktopBodyVisible, isOn: Binding(get: { model.isShown }, set: { model.setShown($0) }))
                .accessibilityIdentifier("settings-desktop-body-visible")
            Toggle(ShannonGeneratedStrings.desktopBodyAlwaysOnTop, isOn: Binding(get: { model.alwaysOnTop }, set: { model.setAlwaysOnTop($0) }))
                .accessibilityIdentifier("settings-desktop-body-on-top")
            Picker(ShannonGeneratedStrings.desktopBodySize, selection: Binding(
                get: { ShannonDesktopBodyGeometry.nearestPreset(model.scale) ?? model.scale },
                set: { model.setScale($0) }
            )) {
                if ShannonDesktopBodyGeometry.nearestPreset(model.scale) == nil {
                    Text("\(Int((model.scale * 100).rounded()))%").tag(model.scale)
                }
                ForEach(ShannonDesktopBodyGeometry.presets, id: \.self) { preset in
                    Text(ShannonDesktopBodySizeCopy.title(preset)).tag(preset)
                }
            }
            .help(ShannonGeneratedStrings.desktopBodySizeHint)
            .accessibilityIdentifier("settings-desktop-body-size")
            Toggle(isOn: Binding(get: { model.smallEyes }, set: { model.setSmallEyes($0) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(ShannonGeneratedStrings.settingsFigureSmallEyes)
                    if model.showsEyesBecauseSmall {
                        Text(ShannonGeneratedStrings.settingsFigureSmallEyesNote)
                            .font(.shannonDesktop(.caption))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .disabled(!ShannonLive2DStage.shared.offersEyes)
            .accessibilityIdentifier("settings-desktop-body-small-eyes")
            Toggle(isOn: Binding(get: { model.speaks }, set: { model.setSpeaks($0) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(ShannonGeneratedStrings.desktopBodySpeaks)
                    Text(ShannonGeneratedStrings.desktopBodySpeaksHint)
                        .font(.shannonDesktop(.caption))
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("settings-desktop-body-speaks")
            if let status {
                Text(status)
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("settings-desktop-body-status")
            }
        } header: {
            Text(ShannonGeneratedStrings.desktopBodySection)
        } footer: {
            Text(ShannonGeneratedStrings.desktopBodyExplanation)
                .font(.shannonDesktop(.caption))
                .foregroundStyle(.secondary)
        }
    }

    /// What keeps the body from reaching her, said plainly; nothing while it works or is not shown.
    private var status: String? {
        guard model.isShown else { return nil }
        switch model.support {
        case .unsupported: return ShannonGeneratedStrings.desktopBodyUnsupported
        case .notConnected: return ShannonGeneratedStrings.desktopBodyNotConnected
        case .unknown, .supported: return nil
        }
    }
}

/// 設定 › カメラ › デスクトップの体 on the Mac: whether her body may take one look at the room (off by default; Syzygy
/// ADR-0002, 部屋をひと目見る). Separate from the app's camera in a conversation, which has its own switch above it.
public struct ShannonDesktopBodyCameraSection: View {
    @Bindable private var model: ShannonDesktopBody

    public init(body: ShannonDesktopBody = .shared) {
        self.model = body
    }

    public var body: some View {
        Section {
            Toggle(isOn: Binding(get: { model.cameraAllowed }, set: { value in Task { await model.setCameraAllowed(value) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(ShannonGeneratedStrings.desktopBodyCamera)
                    Text(model.cameraState.line)
                        .font(.shannonDesktop(.caption))
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("settings-desktop-body-camera")
            if model.cameraAllowed, model.cameraPermission == .denied {
                Text(ShannonGeneratedStrings.desktopBodyCameraDenied)
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(ShannonGeneratedStrings.desktopBodySection)
        } footer: {
            Text(ShannonGeneratedStrings.desktopBodyCameraExplanation)
                .font(.shannonDesktop(.caption))
                .foregroundStyle(.secondary)
        }
    }
}
#endif
