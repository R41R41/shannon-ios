#if os(iOS)
import Foundation
@preconcurrency import AVFoundation
@preconcurrency import CallKit
@preconcurrency import PushKit

/// The iPhone's side of a call from Shannon: PushKit hands over the VoIP push, CallKit shows the call.
///
/// iOS ends an app that receives a VoIP push and does not report an incoming call, and stops delivering
/// such pushes to it. So every push is reported, inside the push's own callback: `receivedPush` shows a
/// call first, whatever the push holds, and ends it at once when it is not a call to ring with.
///
/// Both delegates are called on the main queue (it is the queue handed to them), so their callbacks run
/// the coordinator directly.
@MainActor
final class ShannonCallKitBridge: NSObject, ShannonSystemCalling {
    private let provider: CXProvider
    private let registry: PKPushRegistry
    /// Set right after creation, before any push can arrive.
    var coordinator: ShannonIncomingCallCoordinator?
    /// The phone's address for calls, as lowercase hexadecimal; nil when it was withdrawn.
    var tokenChanged: (@MainActor (String?) -> Void)?
    /// Calls the system was told about and has not answered for yet; one that is to end at once ends when it has.
    private var showing: Set<UUID> = []
    private var endsAfterShowing: [UUID: ShannonCallEndReason] = [:]

    override init() {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = false
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        // Her calls, answered or missed, are listed in the Phone app's recents, as the settings say.
        configuration.includesCallsInRecents = true
        provider = CXProvider(configuration: configuration)
        registry = PKPushRegistry(queue: .main)
        super.init()
        provider.setDelegate(self, queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
    }

    func showIncoming(_ id: UUID) {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: ShannonIncomingCallCopy.callerName)
        update.localizedCallerName = ShannonIncomingCallCopy.callerName
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        showing.insert(id)
        provider.reportNewIncomingCall(with: id, update: update) { error in
            let failure = error.map { ($0 as NSError).domain == CXErrorDomainIncomingCall ? ($0 as NSError).code : -1 }
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.showing.remove(id)
                let ending = self.endsAfterShowing.removeValue(forKey: id)
                guard let failure else {
                    if let ending { self.end(id, reason: ending) }
                    return
                }
                // The system did not take the call (a Focus silenced it, the caller is blocked): there is nothing to end.
                ShannonVoiceDiagnostics.shared.record("incoming_call.show.failed", metadata: ["code": String(failure)])
                self.coordinator?.showFailed(
                    id, silenced: failure == CXErrorCodeIncomingCallError.Code.filteredByDoNotDisturb.rawValue
                )
            }
        }
    }

    func end(_ id: UUID, reason: ShannonCallEndReason) {
        guard !showing.contains(id) else {
            endsAfterShowing[id] = reason
            return
        }
        let systemReason: CXCallEndedReason = switch reason {
        case .unanswered: .unanswered
        case .remoteEnded: .remoteEnded
        case .answeredElsewhere: .answeredElsewhere
        case .failed: .failed
        }
        provider.reportCall(with: id, endedAt: nil, reason: systemReason)
    }
}

extension ShannonCallKitBridge: PKPushRegistryDelegate {
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        MainActor.assumeIsolated { tokenChanged?(token) }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        MainActor.assumeIsolated { tokenChanged?(nil) }
    }

    nonisolated func pushRegistry(
        _ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        // Only identifiers and a time are read from the push; nothing of it is logged.
        let call = type == .voIP ? ShannonIncomingCallPayload(dictionary: payload.dictionaryPayload) : nil
        // The call is reported to the system here, before this callback returns.
        MainActor.assumeIsolated {
            if let coordinator {
                coordinator.receivedPush(call)
            } else {
                // Not set up (it always is, at launch): the push is still answered with a call that ends at once.
                let id = UUID()
                showIncoming(id)
                end(id, reason: .failed)
            }
        }
        completion()
    }
}

extension ShannonCallKitBridge: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        MainActor.assumeIsolated { coordinator?.systemReset() }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        let id = action.callUUID
        MainActor.assumeIsolated { coordinator?.answered(id) }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let id = action.callUUID
        MainActor.assumeIsolated { coordinator?.hungUp(id) }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        let id = action.callUUID
        let muted = action.isMuted
        MainActor.assumeIsolated { coordinator?.muted(id, muted) }
        action.fulfill()
    }

    /// A call from her cannot be put on hold: there is nobody to wait.
    nonisolated func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        action.fail()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXPlayDTMFCallAction) {
        action.fail()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetGroupCallAction) {
        action.fail()
    }

    /// The app never starts a call: a tap on her name in the phone's recents opens the app and nothing else.
    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        action.fail()
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated { coordinator?.audioActivated() }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated { coordinator?.audioDeactivated() }
    }
}
#endif
