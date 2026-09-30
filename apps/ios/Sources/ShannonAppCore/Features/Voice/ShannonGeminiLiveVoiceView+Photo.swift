#if os(iOS)
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
        workspace.showsCamera = true
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
