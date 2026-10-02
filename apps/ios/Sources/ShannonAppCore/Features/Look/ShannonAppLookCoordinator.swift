import CoreGraphics
import Foundation
import Observation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The facts and devices a look depends on, so that the rules can be tested without a camera.
public struct ShannonAppLookEnvironment: Sendable {
    public var isEnabled: @MainActor @Sendable () -> Bool
    public var isForeground: @MainActor @Sendable () -> Bool
    public var permission: @MainActor @Sendable () -> ShannonMediaPermission
    public var requestPermission: @MainActor @Sendable () async -> Bool
    public var camera: any ShannonAppLookCapturing

    public init(
        isEnabled: @escaping @MainActor @Sendable () -> Bool,
        isForeground: @escaping @MainActor @Sendable () -> Bool,
        permission: @escaping @MainActor @Sendable () -> ShannonMediaPermission,
        requestPermission: @escaping @MainActor @Sendable () async -> Bool,
        camera: any ShannonAppLookCapturing
    ) {
        self.isEnabled = isEnabled
        self.isForeground = isForeground
        self.permission = permission
        self.requestPermission = requestPermission
        self.camera = camera
    }

    public static var live: ShannonAppLookEnvironment {
        ShannonAppLookEnvironment(
            isEnabled: { ShannonAppLookPreference.isEnabled() },
            isForeground: {
#if os(iOS)
                UIApplication.shared.applicationState == .active
#elseif os(macOS)
                // In front, with a window on screen to show the sign in.
                NSApplication.shared.isActive
                    && NSApplication.shared.windows.contains { $0.isVisible && !$0.isMiniaturized && $0.canBecomeMain }
#else
                false
#endif
            },
            permission: { ShannonMediaPermission.currentVideoCapture() },
            requestPermission: { await ShannonAppLookSystemCamera.requestAccess() },
            camera: ShannonAppLookCameraCapture()
        )
    }
}

/// What came of one ask.
public enum ShannonAppLookOutcome: Equatable, Sendable {
    case seen(camera: ShannonAppLookCamera, frame: ShannonAppLookFrame)
    case refused(ShannonAppLookRefusal)
}

/// Shannon's eyes in this app for one turn: says what the camera can do, takes the one frame
/// the server asked for, and shows the owner that it happened. It keeps no image: the frame is
/// returned to the caller once, and the thumbnail of the sign is dropped after a few seconds.
@MainActor
@Observable
public final class ShannonAppLookCoordinator {
    /// The sign 「いま見ました」 with the frame that was taken.
    public struct Cue: Identifiable {
        public let id: UUID
        public let thumbnail: CGImage
    }

    public static let cueSeconds = 4.0

    public private(set) var cue: Cue?
    /// Non-nil while the explanation that precedes the system's camera prompt is on screen.
    public private(set) var primerPhase: ShannonPermissionPrimerPhase?

    @ObservationIgnored private let environment: ShannonAppLookEnvironment
    private var presenters: [UUID] = []
    @ObservationIgnored private var primerChoice: CheckedContinuation<Bool, Never>?
    @ObservationIgnored private var isLooking = false

    public init(environment: ShannonAppLookEnvironment = .live) {
        self.environment = environment
    }

    /// What this turn tells the server about the camera.
    public func clientState() -> ShannonAppLookClientStateDTO {
        let cameras = environment.camera.cameras()
        return ShannonAppLookClientStateDTO(
            state: ShannonAppLookAvailability.state(
                enabled: environment.isEnabled(), foreground: environment.isForeground(),
                permission: environment.permission(), cameras: cameras),
            cameras: cameras, platform: ShannonAppLookAvailability.platform
        )
    }

    /// Takes the one frame of an ask, or says why not. nil when the ask closed before the camera could open:
    /// the server has then already answered it, and nothing is captured.
    public func look(_ ask: ShannonAppLookAskDTO) async -> ShannonAppLookOutcome? {
        guard !isLooking else { return .refused(.busy) }
        isLooking = true
        defer { isLooking = false }
        guard let deadline = ask.deadline(receivedAt: Date()), Date() < deadline else { return nil }
        let state = clientState()
        if let refusal = ShannonAppLookAvailability.refusal(state.state) { return .refused(refusal) }
        if state.state == .undetermined {
            let refusal = await authorize(until: deadline)
            // An explanation nobody answered in time is not a refusal: the ask has simply closed.
            guard Date() < deadline else { return nil }
            if let refusal { return .refused(refusal) }
            await settleAfterSystemPrompt()
        }
        // The explanation and the system prompt take time, and the app may have left the screen meanwhile.
        guard Date() < deadline else { return nil }
        if let refusal = ShannonAppLookAvailability.refusal(clientState().state) { return .refused(refusal) }
        let camera = state.cameras.contains(ask.camera) ? ask.camera : state.cameras.first ?? ask.camera
        do {
            let image = try await environment.camera.capture(camera)
            // A frame taken as the app left the screen is dropped unseen.
            guard environment.isForeground(), environment.isEnabled() else {
                return .refused(environment.isEnabled() ? .background : .switchedOff)
            }
            guard Date() < deadline else { return nil }
            // No frame leaves the app without its sign: the thumbnail is part of a look.
            guard let frame = ShannonAppLookEncoder.frame(from: image),
                  let thumbnail = ShannonAppLookEncoder.thumbnail(from: image) else { return .refused(.failed) }
            show(thumbnail)
            return .seen(camera: camera, frame: frame)
        } catch ShannonAppLookCaptureError.noCamera {
            return .refused(.noCamera)
        } catch ShannonAppLookCaptureError.busy {
            return .refused(environment.isForeground() ? .busy : .background)
        } catch {
            return .refused(environment.isForeground() ? .failed : .background)
        }
    }

    // MARK: The camera permission, asked on the first look

    /// nil once the camera is allowed. On iPhone the explanation comes first and the system prompt runs on the owner's tap.
    private func authorize(until deadline: Date) async -> ShannonAppLookRefusal? {
#if os(iOS)
        if !presenters.isEmpty {
            primerPhase = .explain
            // The explanation does not wait for ever: when the ask closes it is put away as 「今はしない」.
            let expiry = Task { [weak self] in
                try? await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow)))
                if !Task.isCancelled { self?.closePrimer() }
            }
            let allowed = await withCheckedContinuation { primerChoice = $0 }
            expiry.cancel()
            guard allowed else {
                primerPhase = nil
                return .declined
            }
            primerPhase = .requesting
        }
#endif
        if await environment.requestPermission() {
            primerPhase = nil
            return nil
        }
        // The sheet stays, now saying where the camera is switched on.
        if primerPhase != nil { primerPhase = .denied }
        return .denied
    }

    /// The system's prompt takes the app out of the active state for a moment after it closes;
    /// that moment is not "the app left the screen".
    private func settleAfterSystemPrompt() async {
        for _ in 0..<15 where !environment.isForeground() {
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    public func allowFromPrimer() {
        guard primerPhase == .explain else { return }
        resolvePrimer(true)
    }

    /// 「あとで」, or the sheet was put away.
    public func closePrimer() {
        switch primerPhase {
        case .explain: resolvePrimer(false)
        case .denied: primerPhase = nil
        case .requesting, nil: break
        }
    }

    private func resolvePrimer(_ allowed: Bool) {
        let choice = primerChoice
        primerChoice = nil
        choice?.resume(returning: allowed)
    }

    // MARK: Where the sign and the explanation are shown

    /// The frontmost surface shows them: a sheet over the Talk, the call screen, or the Talk itself.
    public func register(presenter id: UUID) {
        presenters.removeAll { $0 == id }
        presenters.append(id)
    }

    public func unregister(presenter id: UUID) {
        presenters.removeAll { $0 == id }
        // Nobody is left to show the explanation: it counts as 「あとで」.
        if presenters.isEmpty { closePrimer() }
    }

    public func isFrontmost(presenter id: UUID) -> Bool {
        presenters.last == id
    }

    private func show(_ thumbnail: CGImage) {
        let shown = Cue(id: UUID(), thumbnail: thumbnail)
        cue = shown
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.cueSeconds))
            self?.dismissCue(shown.id)
        }
    }

    public func dismissCue(_ id: UUID? = nil) {
        guard id == nil || cue?.id == id else { return }
        cue = nil
    }
}
