import Observation
import PhotosUI
import SwiftUI
#if os(iOS)
import UIKit
/// A photo taken or picked for the call, before it is shared.
typealias ShannonVoicePendingImage = UIImage
#else
import AppKit
typealias ShannonVoicePendingImage = NSImage
#endif

/// Unsubmitted input and previews outlive the expanded call screen.
@MainActor
@Observable
final class ShannonVoiceWorkspaceState {
    var threadContext: ShannonVoiceThreadContext?
    var connectionRequestID: UUID?
    var typedMessage = ""
    /// Owner text that failed to send and was put back into the composer; cleared from it when a friend joins.
    var restoredFailedText: String?
    /// The multiline composer revealed by the call screen's 文字 control.
    var showsTextComposer = false
    var showsInputPicker = false
    var showsParticipantModePicker = false
    var showsPhotoSource = false
    var showsCamera = false
    var showsPhotoLibrary = false
    var selectedLibraryPhoto: PhotosPickerItem?
    var pendingCameraImage: ShannonVoicePendingImage?
    var pendingCameraData: Data?
    var pendingPhotoFromLibrary = false
    var cameraErrorMessage: String?
    var isSharingCameraSnapshot = false
    var isLoadingLibraryPhoto = false
    var cameraPrimerPhase: ShannonPermissionPrimerPhase?
    var showsPhotoUnavailable = false
    /// What the last call's 「友人も一緒」 periods left behind. Filled as each period ends and
    /// shown in the pill's place once the call is over.
    var callMemory: ShannonVoiceCallMemoryState?
    /// Counts calls ended through `endCall`, so every open call screen can close itself.
    var callEndRevision = 0
    /// The call screens that are up now: the root's, or one shown from inside Settings, the thread list or a
    /// work task (each modal has its own). A link never closes what is under any of them.
    private(set) var callScreenPresenters: Set<UUID> = []
    var callScreenIsUp: Bool { !callScreenPresenters.isEmpty }
    func setCallScreen(_ presenter: UUID, isUp: Bool) {
        if isUp { callScreenPresenters.insert(presenter) } else { callScreenPresenters.remove(presenter) }
    }

    func clearPhoto() {
        showsPhotoSource = false
        showsCamera = false
        showsPhotoLibrary = false
        selectedLibraryPhoto = nil
        pendingCameraImage = nil
        pendingCameraData = nil
        cameraErrorMessage = nil
        isSharingCameraSnapshot = false
        isLoadingLibraryPhoto = false
        cameraPrimerPhase = nil
    }
}

extension ShannonVoiceWorkspaceState {
    /// Hands one finished 「友人も一緒」 period to the server. An empty period only clears server state.
    func remember(_ period: ShannonVoiceGuestPeriod, threadID: String?, using model: ShannonConversationModel) {
        guard !period.isEmpty else {
            Task { try? await model.discardVoiceCalls([period.callID]) }
            return
        }
        var memory = callMemory ?? ShannonVoiceCallMemoryState()
        memory.began(period)
        callMemory = memory
        Task {
            let people = try? await model.rememberVoiceCall(period, threadID: threadID).people.map(\.displayName)
            // A new call may have replaced the card in the meantime.
            guard callMemory?.callIDs.contains(period.callID) == true else { return }
            callMemory?.finished(period, people: people)
        }
    }

    func retryCallMemory(using model: ShannonConversationModel) {
        guard let unsaved = callMemory?.unsaved, !unsaved.isEmpty else { return }
        callMemory?.unsaved = []
        for period in unsaved { remember(period, threadID: threadContext?.threadID, using: model) }
    }

    /// 「今回は残さない」: removes every period of the ended call from the server.
    func discardCallMemory(using model: ShannonConversationModel) {
        guard let callIDs = callMemory?.callIDs, !callIDs.isEmpty else { return }
        callMemory?.phase = .discarding
        Task {
            do {
                try await model.discardVoiceCalls(callIDs)
                guard callMemory?.callIDs == callIDs else { return }
                callMemory?.phase = .discarded
                callMemory?.unsaved = []
            } catch {
                if callMemory?.callIDs == callIDs { callMemory?.phase = .discardFailed }
            }
        }
    }
}

/// Previous turn writes retain their context across a new call or guest switch.
@MainActor
@Observable
final class ShannonVoiceThreadContext {
    var threadID: String?
    init(threadID: String?) { self.threadID = threadID }
}
