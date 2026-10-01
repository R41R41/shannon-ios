#if os(iOS)
import Observation
import PhotosUI
import SwiftUI
import UIKit

/// Unsubmitted input and previews outlive the expanded call screen.
@MainActor
@Observable
final class ShannonVoiceWorkspaceState {
    var threadContext: ShannonVoiceThreadContext?
    var connectionRequestID: UUID?
    var typedMessage = ""
    /// The multiline composer revealed by the call screen's 文字 control.
    var showsTextComposer = false
    var showsInputPicker = false
    var showsParticipantModePicker = false
    var showsPhotoSource = false
    var showsCamera = false
    var showsPhotoLibrary = false
    var selectedLibraryPhoto: PhotosPickerItem?
    var pendingCameraImage: UIImage?
    var pendingCameraData: Data?
    var pendingPhotoFromLibrary = false
    var cameraErrorMessage: String?
    var isSharingCameraSnapshot = false
    var isLoadingLibraryPhoto = false
    var cameraPrimerPhase: ShannonPermissionPrimerPhase?
    var showsPhotoUnavailable = false
    /// Set when a call that had a 「友人も一緒」 period ends; memory only.
    var callSummaryPrompt: ShannonVoiceCallSummaryPromptState?

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

/// Previous turn writes retain their context across a new call or guest switch.
@MainActor
@Observable
final class ShannonVoiceThreadContext {
    var threadID: String?
    init(threadID: String?) { self.threadID = threadID }
}
#endif
