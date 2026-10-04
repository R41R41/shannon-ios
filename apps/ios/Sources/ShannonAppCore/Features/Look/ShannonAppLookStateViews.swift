import SwiftUI

/// The camera's state as the owner always sees it (docs/product/information-architecture.md, 1 and 2):
/// 切, 見てよい, or いま見ています while a frame is being taken.
public enum ShannonAppLookVisibleState: Equatable, Sendable {
    case off
    case allowed
    case looking

    /// 見てよい only when she really could look: the owner's switch is on, there is a camera, the system
    /// has not refused it (an unanswered permission is asked on the first look, so it counts as allowed), and
    /// nobody else is in the call (with 「友人も一緒」 the app does not offer her the camera).
    public static func make(
        enabled: Bool, hasCamera: Bool, permission: ShannonMediaPermission, othersPresent: Bool = false, isCapturing: Bool
    ) -> Self {
        if isCapturing { return .looking }
        guard enabled, hasCamera, permission != .denied, !othersPresent else { return .off }
        return .allowed
    }

    public var word: String {
        switch self {
        case .off: ShannonGeneratedStrings.lookStateOff
        case .allowed: ShannonGeneratedStrings.lookStateAllowed
        case .looking: ShannonGeneratedStrings.lookStateLooking
        }
    }

    /// 「カメラ：切」, as 「ようす」 writes the body's camera.
    public var line: String { ShannonAppLookCopy.stateLine(word) }

    var symbol: String {
        switch self {
        case .off: "eye.slash"
        case .allowed: "eye"
        case .looking: "eye.fill"
        }
    }
}

extension ShannonAppLookCopy {
    public static func stateLine(_ state: String) -> String { "カメラ：\(state)" }
}

/// Reads the facts the state is made of and keeps them current while the view is up.
struct ShannonAppLookStateReader<Content: View>: View {
    let coordinator: ShannonAppLookCoordinator
    var othersPresent = false
    @ViewBuilder let content: (ShannonAppLookVisibleState) -> Content

    @AppStorage(ShannonAppLookPreference.enabledDefaultsKey) private var enabled = true
    @State private var permission = ShannonMediaPermission.undetermined
    @State private var hasCamera = true
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        content(ShannonAppLookVisibleState.make(
            enabled: enabled, hasCamera: hasCamera, permission: permission, othersPresent: othersPresent,
            isCapturing: coordinator.isCapturing
        ))
        // The system's permission can change in the Settings app: read again whenever the app comes back.
        .task(id: scenePhase == .active) {
            permission = coordinator.permission
            hasCamera = coordinator.hasCamera
        }
        // The first look asks the system: its answer shows as soon as the frame is taken or refused.
        .onChange(of: coordinator.isCapturing) { permission = coordinator.permission }
        .onChange(of: coordinator.primerPhase) { permission = coordinator.permission }
    }
}

/// The small state over the dialogue display and the voice call: always there, never a button.
struct ShannonAppLookStateBadge: View {
    let coordinator: ShannonAppLookCoordinator
    var othersPresent = false

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        ShannonAppLookStateReader(coordinator: coordinator, othersPresent: othersPresent) { state in
            Label(state.line, systemImage: state.symbol)
                .font(.caption.weight(state == .looking ? .semibold : .regular))
                .foregroundStyle(state == .looking ? palette.textPrimary : palette.textSecondary)
                .lineLimit(1)
                .padding(.horizontal, ShannonSpacing.small)
                .padding(.vertical, ShannonSpacing.extraSmall)
                .background {
                    if reduceTransparency { Capsule().fill(palette.elevatedSurface) } else { Capsule().fill(.thinMaterial) }
                }
                .fixedSize()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(state.line)
                .accessibilityIdentifier("app-look-state")
        }
    }
}
