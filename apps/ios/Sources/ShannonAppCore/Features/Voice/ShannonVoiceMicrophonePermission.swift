@preconcurrency import AVFoundation

/// The microphone permission of a voice conversation and of dictation, on the iPhone and on the Mac.
/// The Mac asks through the capture system, as its answer after an earphone message already does.
extension ShannonMediaPermission {
    static func currentMicrophone() -> ShannonMediaPermission {
#if os(iOS)
        switch AVAudioApplication.shared.recordPermission {
        case .granted: .granted
        case .denied: .denied
        case .undetermined: .undetermined
        @unknown default: .undetermined
        }
#else
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: .granted
        case .denied, .restricted: .denied
        case .notDetermined: .undetermined
        @unknown default: .undetermined
        }
#endif
    }

    /// Shows the system's question. Called only from a click or tap of the owner's.
    @MainActor
    static func requestMicrophone() async -> Bool {
#if os(iOS)
        await AVAudioApplication.requestRecordPermission()
#else
        await AVCaptureDevice.requestAccess(for: .audio)
#endif
    }
}
