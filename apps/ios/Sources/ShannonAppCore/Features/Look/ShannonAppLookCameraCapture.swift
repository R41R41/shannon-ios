@preconcurrency import AVFoundation
import CoreImage
import Foundation

public enum ShannonAppLookCaptureError: Error, Equatable, Sendable {
    case noCamera
    /// The camera is held by something else, or the system took it away.
    case busy
    case failed
}

/// One still frame from a camera, upright, with no preview and no tap.
public protocol ShannonAppLookCapturing: Sendable {
    func cameras() -> [ShannonAppLookCamera]
    func capture(_ camera: ShannonAppLookCamera) async throws -> CGImage
}

/// Opens the camera for about half a second, takes one frame of video once exposure has settled, and closes it.
/// Video frames are used instead of a photo capture so that no shutter sound interrupts a call.
/// The frame exists only as the returned bitmap; nothing is written to disk or to the photo library,
/// and the audio session of a running call is never touched.
final class ShannonAppLookCameraCapture: NSObject, ShannonAppLookCapturing, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private static let warmUpSeconds = 0.4
    private static let settleSeconds = 1.0
    private static let timeoutSeconds = 6.0

    private let queue = DispatchQueue(label: "shannon.app-look.camera")
    private lazy var imageContext = CIContext(options: [.cacheIntermediates: false])
    // Everything below is touched on `queue` only.
    private var session: AVCaptureSession?
    private var device: AVCaptureDevice?
    private var continuation: CheckedContinuation<CGImage, Error>?
    private var firstFrameAt: CFAbsoluteTime?
    private var observers: [NSObjectProtocol] = []

    func cameras() -> [ShannonAppLookCamera] {
#if os(iOS)
        ShannonAppLookCamera.allCases.filter { Self.device(for: $0) != nil }
#else
        // A Mac has one camera to offer, and it faces the person at the screen.
        Self.device(for: .front) == nil ? [] : [.front]
#endif
    }

    func capture(_ camera: ShannonAppLookCamera) async throws -> CGImage {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { self.begin(camera, continuation) }
        }
    }

    private static func device(for camera: ShannonAppLookCamera) -> AVCaptureDevice? {
#if os(iOS)
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: camera == .front ? .front : .back)
#else
        AVCaptureDevice.default(for: .video)
#endif
    }

    private func begin(_ camera: ShannonAppLookCamera, _ continuation: CheckedContinuation<CGImage, Error>) {
        guard self.continuation == nil else {
            continuation.resume(throwing: ShannonAppLookCaptureError.busy)
            return
        }
        guard let device = Self.device(for: camera) else {
            continuation.resume(throwing: ShannonAppLookCaptureError.noCamera)
            return
        }
        let session = AVCaptureSession()
        let output = AVCaptureVideoDataOutput()
        guard let input = try? AVCaptureDeviceInput(device: device) else {
            continuation.resume(throwing: ShannonAppLookCaptureError.failed)
            return
        }
        session.beginConfiguration()
#if os(iOS)
        // Video only: a call's microphone and playback stay exactly as they are.
        session.automaticallyConfiguresApplicationAudioSession = false
#endif
        if session.canSetSessionPreset(.hd1280x720) { session.sessionPreset = .hd1280x720 }
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        guard session.canAddInput(input), session.canAddOutput(output) else {
            session.commitConfiguration()
            continuation.resume(throwing: ShannonAppLookCaptureError.failed)
            return
        }
        session.addInput(input)
        session.addOutput(output)
        output.setSampleBufferDelegate(self, queue: queue)
        if let connection = output.connection(with: .video) {
            // Upright however the device is held.
            let angle = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: nil).videoRotationAngleForHorizonLevelCapture
            if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
        }
        session.commitConfiguration()

        self.session = session
        self.device = device
        self.continuation = continuation
        firstFrameAt = nil
        let center = NotificationCenter.default
        observers = [AVCaptureSession.runtimeErrorNotification, AVCaptureSession.wasInterruptedNotification].map { name in
            center.addObserver(forName: name, object: session, queue: nil) { [weak self] note in
                let error: ShannonAppLookCaptureError = note.name == AVCaptureSession.wasInterruptedNotification ? .busy : .failed
                guard let self else { return }
                self.queue.async { self.finish(session, .failure(error)) }
            }
        }
        session.startRunning()
        guard session.isRunning else {
            finish(session, .failure(ShannonAppLookCaptureError.busy))
            return
        }
        queue.asyncAfter(deadline: .now() + Self.timeoutSeconds) { [weak self] in
            self?.finish(session, .failure(ShannonAppLookCaptureError.failed))
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let session, continuation != nil else { return }
        let now = CFAbsoluteTimeGetCurrent()
        let first = firstFrameAt ?? now
        firstFrameAt = first
        // The first frames are dark or unfocused; wait until exposure has settled, but not for long.
        let elapsed = now - first
        guard elapsed >= Self.settleSeconds || (elapsed >= Self.warmUpSeconds && device?.isAdjustingExposure != true) else { return }
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let image = CIImage(cvPixelBuffer: buffer)
        guard let frame = imageContext.createCGImage(image, from: image.extent) else {
            finish(session, .failure(ShannonAppLookCaptureError.failed))
            return
        }
        finish(session, .success(frame))
    }

    /// Ends the one capture that `session` belongs to: the camera is closed before the caller hears of it.
    private func finish(_ session: AVCaptureSession, _ result: Result<CGImage, Error>) {
        guard self.session === session, let continuation else { return }
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        self.continuation = nil
        self.session = nil
        device = nil
        session.outputs.forEach { ($0 as? AVCaptureVideoDataOutput)?.setSampleBufferDelegate(nil, queue: nil) }
        if session.isRunning { session.stopRunning() }
        continuation.resume(with: result)
    }
}

extension ShannonMediaPermission {
    /// The system's answer about the camera, on iPhone and on the Mac.
    static func currentVideoCapture() -> ShannonMediaPermission {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: .granted
        case .denied, .restricted: .denied
        case .notDetermined: .undetermined
        @unknown default: .undetermined
        }
    }
}

enum ShannonAppLookSystemCamera {
    static func requestAccess() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .video)
    }
}
