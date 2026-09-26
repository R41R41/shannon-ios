#if os(iOS)
import PhotosUI
import SwiftUI
import UIKit

extension ShannonGeminiLiveVoiceView {
    func clearPendingPhoto() {
        pendingCameraImage = nil
        pendingCameraData = nil
        cameraErrorMessage = nil
    }

    func choosePhotoAgain() {
        clearPendingPhoto()
        if pendingPhotoFromLibrary { showsPhotoLibrary = true } else { presentCamera() }
    }

    @MainActor
    func receiveCameraImage(_ image: UIImage) {
        showsCamera = false
        guard let snapshot = image.shannonCameraSnapshot() else {
            cameraErrorMessage = "写真を共有用に準備できませんでした。撮り直してください。"
            return
        }
        pendingCameraImage = snapshot.preview
        pendingCameraData = snapshot.data
        pendingPhotoFromLibrary = false
        cameraErrorMessage = nil
    }

    @MainActor
    func receiveLibraryPhoto(_ item: PhotosPickerItem) async {
        isLoadingLibraryPhoto = true
        defer {
            isLoadingLibraryPhoto = false
            selectedLibraryPhoto = nil
        }
        do {
            let photo = try await ShannonPhotoLibrarySelection.prepare(item)
            guard model.participantMode.allowsCameraSharing else { return }
            pendingCameraImage = photo.preview
            pendingCameraData = photo.jpegData
            pendingPhotoFromLibrary = true
            cameraErrorMessage = nil
        } catch {
            cameraErrorMessage = (error as? LocalizedError)?.errorDescription
                ?? "写真を読み込めませんでした。もう一度お試しください。"
        }
    }

    @MainActor
    func presentCamera() {
        cameraErrorMessage = nil
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            cameraErrorMessage = "この端末ではカメラを利用できません。実機でお試しください。"
            return
        }
        showsCamera = true
    }

    func shareCameraSnapshot(_ data: Data) {
        guard !isSharingCameraSnapshot else { return }
        isSharingCameraSnapshot = true
        cameraErrorMessage = nil
        Task { @MainActor in
            defer { isSharingCameraSnapshot = false }
            do {
                try await model.shareCameraSnapshot(jpegData: data, analyze: analyzeCameraSnapshot)
                clearPendingPhoto()
            } catch {
                cameraErrorMessage = "写真をシャノンへ共有できませんでした。もう一度お試しください。"
            }
        }
    }
}
#endif
