import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The settings section for calendar sharing, shared by the iPhone and Mac apps.
/// It shows nothing when the app did not provide a sharing model.
public struct ShannonCalendarSharingSettingsSection: View {
    @Environment(ShannonCalendarSharingModel.self) private var model: ShannonCalendarSharingModel?

    /// The section's header: its own name, another part of 設定's, or none when it follows the one before (plan A).
    let header: String?

    public init(header: String? = ShannonCalendarSharingCopy.sectionTitle) {
        self.header = header
    }

    public var body: some View {
        if let model {
            ShannonCalendarSharingSectionContent(model: model, header: header)
        }
    }
}

struct ShannonCalendarSharingSectionContent: View {
    let model: ShannonCalendarSharingModel
    let header: String?
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Section {
            Toggle(isOn: Binding(
                get: { model.isEnabled },
                set: { enabled in Task { await model.setEnabled(enabled) } }
            )) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ShannonCalendarSharingCopy.toggleTitle)
                        Text(ShannonCalendarSharingCopy.statusText(model.status))
                            .font(.shannon(.footnote))
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("calendar-sharing-status")
                    }
                } icon: {
#if os(iOS)
                    Image(systemName: "calendar").foregroundStyle(ShannonPalette.resolve(colorScheme).action)
#else
                    Image(systemName: "calendar")
#endif
                }
            }
            .disabled(model.isChanging)
            .frame(minHeight: ShannonTouchTarget.minimum)
            .accessibilityHint(ShannonCalendarSharingCopy.toggleHint)
            .accessibilityIdentifier("settings-calendar-sharing")
            if model.status.needsPermission {
                Button(ShannonCalendarSharingCopy.openSettingsTitle) {
                    Task {
                        if await model.resolvePermission(), let url = Self.calendarPrivacySettingsURL {
                            openURL(url)
                        }
                    }
                }
                .frame(minHeight: ShannonTouchTarget.minimum)
                .accessibilityIdentifier("settings-calendar-permission")
            }
        } header: {
            if let header { Text(header) }
        } footer: {
            Text(ShannonCalendarSharingCopy.explanation)
        }
        .onAppear { model.refresh() }
    }

    static var calendarPrivacySettingsURL: URL? {
#if os(iOS)
        URL(string: UIApplication.openSettingsURLString)
#else
        URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")
#endif
    }
}

public extension View {
    /// Provides the sharing model to the settings and keeps the snapshot current:
    /// at launch, on calendar changes, on a timer, and (when asked) on return to the foreground.
    func shannonCalendarSharing(_ model: ShannonCalendarSharingModel, syncsOnForeground: Bool) -> some View {
        modifier(ShannonCalendarSharingLifecycle(model: model, syncsOnForeground: syncsOnForeground))
    }
}

private struct ShannonCalendarSharingLifecycle: ViewModifier {
    let model: ShannonCalendarSharingModel
    let syncsOnForeground: Bool
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .environment(model)
            .task { await model.run() }
            .onChange(of: scenePhase) {
                guard syncsOnForeground else { return }
                model.isForeground = scenePhase == .active
                if scenePhase == .active {
                    Task { await model.sync(.foreground) }
                }
            }
    }
}
