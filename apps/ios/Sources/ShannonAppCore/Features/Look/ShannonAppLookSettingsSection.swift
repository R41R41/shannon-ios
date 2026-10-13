import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The settings section for looks through this app's camera, shared by the iPhone and Mac apps.
/// The switch is the owner's; the camera permission stays with the system and is only reported here.
public struct ShannonAppLookSettingsSection: View {
    @AppStorage(ShannonAppLookPreference.enabledDefaultsKey) private var enabled = true
    /// 「アプリを開いている間は見る」 (Syzygy ADR-0011 §4.4), on unless the owner turned it off.
    @AppStorage(ShannonCameraWatchPreference.enabledDefaultsKey) private var watches = true
    @State private var permission = ShannonMediaPermission.undetermined
    @State private var hasCamera = true
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    public init() {}

    public var body: some View {
        Section {
            Toggle(isOn: $enabled) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ShannonAppLookCopy.toggleTitle)
                        Text(ShannonAppLookCopy.statusText(enabled: enabled, permission: permission, hasCamera: hasCamera))
                            .font(.shannon(.footnote))
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("app-look-status")
                    }
                } icon: {
#if os(iOS)
                    Image(systemName: "eye").foregroundStyle(ShannonPalette.resolve(colorScheme).action)
#else
                    Image(systemName: "eye")
#endif
                }
            }
            .disabled(!hasCamera)
            .frame(minHeight: ShannonTouchTarget.minimum)
            .accessibilityHint(ShannonAppLookCopy.toggleHint)
            .accessibilityIdentifier("settings-app-look")
            if enabled, hasCamera, permission == .denied {
                Button(ShannonAppLookCopy.openSettingsTitle) {
                    if let url = Self.cameraPrivacySettingsURL { openURL(url) }
                }
                .frame(minHeight: ShannonTouchTarget.minimum)
                .accessibilityIdentifier("settings-app-look-permission")
            }
        } header: {
            Text(ShannonAppLookCopy.sectionTitle)
        } footer: {
            Text(ShannonAppLookCopy.explanation)
        }
        .onAppear(perform: refresh)
        // The permission may have been changed in the system's settings while the app was away.
        .onChange(of: scenePhase) { refresh() }
        watchSection
    }

    /// Watching while the app is open: its own switch, under the one-shot look. It never asks for the camera itself.
    private var watchSection: some View {
        Section {
            Toggle(isOn: $watches) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ShannonCameraWatchCopy.toggleTitle)
                        Text(ShannonCameraWatchCopy.statusText(enabled: watches, permission: permission, hasCamera: hasCamera))
                            .font(.shannon(.footnote))
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("camera-watch-status")
                    }
                } icon: {
#if os(iOS)
                    Image(systemName: "eye.circle").foregroundStyle(ShannonPalette.resolve(colorScheme).action)
#else
                    Image(systemName: "eye.circle")
#endif
                }
            }
            .disabled(!hasCamera)
            .frame(minHeight: ShannonTouchTarget.minimum)
            .accessibilityHint(ShannonCameraWatchCopy.toggleHint)
            .accessibilityIdentifier("settings-camera-watch")
        } footer: {
            Text(ShannonCameraWatchCopy.explanation)
        }
    }

    private func refresh() {
        permission = ShannonMediaPermission.currentVideoCapture()
        hasCamera = !ShannonAppLookCameraCapture().cameras().isEmpty
    }

    static var cameraPrivacySettingsURL: URL? {
#if os(iOS)
        URL(string: UIApplication.openSettingsURLString)
#else
        URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
#endif
    }
}
