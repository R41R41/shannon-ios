#if os(macOS)
import AppKit
import PhotosUI
import SwiftUI

/// Showing her a photo during a Mac call: taken with the Mac's camera, or picked from Photos or a file.
/// As on the iPhone the photo is shown first, can be taken or chosen again, and is shared only on the
/// owner's click; 「友人も一緒」 never shares one (its description would use the owner's Talk).
extension ShannonDesktopVoiceCall {
    /// What the photo control offers. `false` shows the explanation that 「友人も一緒」 cannot share a photo.
    var canSharePhoto: Bool { session.participantMode.allowsCameraSharing }

    /// カメラで撮る: asks the system for the camera on this click if it never asked, then opens the camera sheet.
    func requestCamera() {
        workspace.cameraErrorMessage = nil
        workspace.pendingPhotoFromLibrary = false
        guard ShannonDesktopCameraSession.hasCamera else {
            workspace.cameraErrorMessage = ShannonGeneratedStrings.voiceMacCameraMissing
            return
        }
        switch ShannonMediaPermission.currentVideoCapture() {
        case .granted:
            workspace.showsCamera = true
        case .undetermined:
            Task { @MainActor [weak self] in
                let granted = await ShannonAppLookSystemCamera.requestAccess()
                guard let self, self.holdsMicrophone else { return }
                if granted { self.workspace.showsCamera = true } else { self.workspace.cameraErrorMessage = ShannonGeneratedStrings.voiceMacCameraDenied }
            }
        case .denied:
            workspace.cameraErrorMessage = ShannonGeneratedStrings.voiceMacCameraDenied
        }
    }

    /// One frame from the camera sheet, as a JPEG.
    func receiveCameraFrame(_ jpeg: Data) {
        workspace.showsCamera = false
        usePhoto { try ShannonChatPhoto.prepare(jpeg) }
        workspace.pendingPhotoFromLibrary = false
    }

    /// A photo chosen in Photos.
    func receiveLibraryPhoto(_ item: PhotosPickerItem) async {
        guard let context = workspace.threadContext, canSharePhoto else { return }
        workspace.isLoadingLibraryPhoto = true
        defer {
            if workspace.threadContext === context {
                workspace.isLoadingLibraryPhoto = false
                workspace.selectedLibraryPhoto = nil
            }
        }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { throw ShannonChatPhoto.Failure.invalidImage }
            guard workspace.threadContext === context else { return }
            usePhoto { try ShannonChatPhoto.prepare(data) }
            workspace.pendingPhotoFromLibrary = true
        } catch {
            guard workspace.threadContext === context else { return }
            workspace.cameraErrorMessage = (error as? LocalizedError)?.errorDescription
                ?? "写真を読み込めませんでした。もう一度お試しください。"
        }
    }

    /// An image file chosen in the open panel.
    func receivePhotoFile(_ result: Result<[URL], Error>) {
        guard let url = try? result.get().first else { return }
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        usePhoto { try ShannonChatPhoto.prepare(Data(contentsOf: url, options: [.mappedIfSafe])) }
        workspace.pendingPhotoFromLibrary = true
    }

    func clearPendingPhoto() {
        workspace.pendingCameraImage = nil
        workspace.pendingCameraData = nil
        workspace.cameraErrorMessage = nil
    }

    /// 撮り直す／選び直す.
    func choosePhotoAgain() {
        let fromLibrary = workspace.pendingPhotoFromLibrary
        clearPendingPhoto()
        if fromLibrary { workspace.showsPhotoLibrary = true } else { requestCamera() }
    }

    /// 共有: the photo is described by the server and becomes a turn of the call.
    func sharePendingPhoto() {
        guard let data = workspace.pendingCameraData, !workspace.isSharingCameraSnapshot,
              let context = workspace.threadContext, let conversation else { return }
        workspace.isSharingCameraSnapshot = true
        workspace.cameraErrorMessage = nil
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { if self.workspace.threadContext === context { self.workspace.isSharingCameraSnapshot = false } }
            do {
                try await self.session.shareCameraSnapshot(jpegData: data) { jpeg in
                    guard let threadID = context.threadID else { throw ShannonAPIError.invalidResponse }
                    return try await conversation.analyzeVoiceCameraSnapshot(jpegData: jpeg, threadID: threadID)
                }
                guard self.workspace.threadContext === context else { return }
                self.clearPendingPhoto()
            } catch {
                guard self.workspace.threadContext === context else { return }
                self.workspace.cameraErrorMessage = "写真をシャノンへ共有できませんでした。もう一度お試しください。"
            }
        }
    }

    private func usePhoto(_ prepare: () throws -> ShannonChatPhoto) {
        guard canSharePhoto, workspace.threadContext != nil else { return }
        do {
            let photo = try prepare()
            workspace.pendingCameraData = photo.jpegData
            workspace.pendingCameraImage = NSImage(data: photo.jpegData)
            workspace.cameraErrorMessage = nil
        } catch {
            workspace.cameraErrorMessage = (error as? LocalizedError)?.errorDescription
                ?? "写真を共有用に準備できませんでした。別の写真を選んでください。"
        }
    }
}
#endif
