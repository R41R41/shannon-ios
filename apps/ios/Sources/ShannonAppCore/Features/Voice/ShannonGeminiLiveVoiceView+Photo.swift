#if os(iOS)
@preconcurrency import AVFoundation
import PhotosUI
import SwiftUI
import UIKit

extension ShannonGeminiLiveVoiceView {
    func clearPendingPhoto() {
        workspace.pendingCameraImage = nil
        workspace.pendingCameraData = nil
        workspace.cameraErrorMessage = nil
    }

    func choosePhotoAgain() {
        clearPendingPhoto()
        if workspace.pendingPhotoFromLibrary { workspace.showsPhotoLibrary = true } else { presentCamera() }
    }

    @MainActor
    func receiveCameraImage(_ image: UIImage) {
        workspace.showsCamera = false
        guard model.participantMode.allowsCameraSharing, workspace.threadContext != nil else { return }
        guard let snapshot = image.shannonCameraSnapshot() else {
            workspace.cameraErrorMessage = "写真を共有用に準備できませんでした。撮り直してください。"
            return
        }
        workspace.pendingCameraImage = snapshot.preview
        workspace.pendingCameraData = snapshot.data
        workspace.pendingPhotoFromLibrary = false
        workspace.cameraErrorMessage = nil
    }

    @MainActor
    func receiveLibraryPhoto(_ item: PhotosPickerItem) async {
        guard let context = workspace.threadContext, model.participantMode.allowsCameraSharing else { return }
        workspace.isLoadingLibraryPhoto = true
        defer {
            if workspace.threadContext === context {
                workspace.isLoadingLibraryPhoto = false
                workspace.selectedLibraryPhoto = nil
            }
        }
        do {
            let photo = try await ShannonPhotoLibrarySelection.prepare(item)
            guard workspace.threadContext === context, model.participantMode.allowsCameraSharing else { return }
            workspace.pendingCameraImage = photo.preview
            workspace.pendingCameraData = photo.jpegData
            workspace.pendingPhotoFromLibrary = true
            workspace.cameraErrorMessage = nil
        } catch {
            guard workspace.threadContext === context else { return }
            workspace.cameraErrorMessage = (error as? LocalizedError)?.errorDescription
                ?? "写真を読み込めませんでした。もう一度お試しください。"
        }
    }

    @MainActor
    func presentCamera() {
        workspace.cameraErrorMessage = nil
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            workspace.cameraErrorMessage = "この端末ではカメラを利用できません。実機でお試しください。"
            return
        }
        switch ShannonMediaPermission.currentCamera() {
        case .granted: workspace.showsCamera = true
        case .undetermined: workspace.cameraPrimerPhase = .explain
        case .denied: workspace.cameraPrimerPhase = .denied
        }
    }

    /// Runs the real camera request from the primer's continue button.
    @MainActor
    func confirmCameraPrimer() {
        guard workspace.cameraPrimerPhase == .explain else { return }
        workspace.cameraPrimerPhase = .requesting
        Task { @MainActor in
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            guard workspace.cameraPrimerPhase == .requesting else { return }
            if granted {
                workspace.cameraPrimerPhase = nil
                workspace.showsCamera = true
            } else {
                workspace.cameraPrimerPhase = .denied
            }
        }
    }

    var permissionPrimerKind: Binding<ShannonVoicePermissionPrimerKind?> {
        Binding(
            get: {
                if model.microphonePrimerPhase != nil { return .microphone }
                if workspace.cameraPrimerPhase != nil { return .camera }
                return nil
            },
            set: { value in
                guard value == nil else { return }
                closePermissionPrimer()
            }
        )
    }

    func closePermissionPrimer() {
        if let phase = model.microphonePrimerPhase {
            // Declining the explanation ends the call that is waiting for the microphone.
            if phase == .explain { end() } else if phase == .denied { model.dismissMicrophonePrimer() }
        } else if workspace.cameraPrimerPhase != .requesting {
            workspace.cameraPrimerPhase = nil
        }
    }

    @ViewBuilder
    func permissionPrimerSheet(_ kind: ShannonVoicePermissionPrimerKind) -> some View {
        switch kind {
        case .microphone:
            ShannonPermissionPrimerSheet(
                content: kind.content,
                phase: model.microphonePrimerPhase ?? .explain,
                allow: model.confirmMicrophonePrimer,
                notNow: closePermissionPrimer
            )
        case .camera:
            ShannonPermissionPrimerSheet(
                content: kind.content,
                phase: workspace.cameraPrimerPhase ?? .explain,
                allow: confirmCameraPrimer,
                notNow: closePermissionPrimer
            )
        }
    }

    func shareCameraSnapshot(_ data: Data) {
        guard !workspace.isSharingCameraSnapshot, let context = workspace.threadContext else { return }
        workspace.isSharingCameraSnapshot = true
        workspace.cameraErrorMessage = nil
        Task { @MainActor in
            guard workspace.threadContext === context else { return }
            defer {
                if workspace.threadContext === context { workspace.isSharingCameraSnapshot = false }
            }
            do {
                try await model.shareCameraSnapshot(jpegData: data, analyze: analyzeCameraSnapshot)
                guard workspace.threadContext === context else { return }
                clearPendingPhoto()
            } catch {
                guard workspace.threadContext === context else { return }
                workspace.cameraErrorMessage = "写真をシャノンへ共有できませんでした。もう一度お試しください。"
            }
        }
    }
}
#endif
