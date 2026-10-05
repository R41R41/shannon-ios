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
    /// What the owner had in the call's composer when a friend joined: set aside, never deleted, and put back when
    /// the call returns to 本人だけ or ends. Everything in the composer at that moment was typed outside
    /// 「友人も一緒」, so all of it is his; a draft typed while the friend is there stays where it is.
    private(set) var ownerMessageAside: String?
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

    /// Text that failed to send goes back into the empty composer.
    func restoreFailedText(_ text: String) {
        guard typedMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            showsTextComposer = true
            return
        }
        typedMessage = text
        showsTextComposer = true
    }

    /// A switch between 本人だけ and 「友人も一緒」: an unshared photo goes; into 「友人も一緒」 the owner's text is set
    /// aside (so it is neither shown nor sent as the guests' words), back in 本人だけ it returns.
    func participantModeChanged(to mode: ShannonVoiceParticipantMode) {
        clearPhoto()
        if mode == .guest { setOwnerMessageAside() } else { restoreOwnerMessage() }
    }

    private func setOwnerMessageAside() {
        guard !typedMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        ownerMessageAside = [ownerMessageAside, typedMessage].compactMap { $0 }.joined(separator: "\n")
        typedMessage = ""
    }

    /// Puts the owner's text back, ahead of anything typed meanwhile.
    func restoreOwnerMessage() {
        guard let aside = ownerMessageAside else { return }
        ownerMessageAside = nil
        typedMessage = typedMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? aside : aside + "\n" + typedMessage
        if !typedMessage.isEmpty { showsTextComposer = true }
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
