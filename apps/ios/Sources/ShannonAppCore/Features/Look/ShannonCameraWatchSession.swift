@preconcurrency import AVFoundation
import CoreImage
import Foundation
import Vision

/// One frame that passed the edge gate, ready to send: the JPEG in memory, and what the gate saw.
public struct ShannonCameraWatchShot: Sendable {
    public let frame: ShannonAppLookFrame
    public let capturedAt: Date
    public let reason: ShannonVisionGateReason
    public let difference: Double?
    public let personCount: Int?

    public init(frame: ShannonAppLookFrame, capturedAt: Date, reason: ShannonVisionGateReason, difference: Double?, personCount: Int?) {
        self.frame = frame
        self.capturedAt = capturedAt
        self.reason = reason
        self.difference = difference
        self.personCount = personCount
    }
}

public enum ShannonCameraWatchEvent: Sendable {
    case shot(ShannonCameraWatchShot)
    /// Two or more people were seen: the camera has already closed.
    case othersSeen(personCount: Int)
    /// The camera could not open, or the system took it away (another app, a call, a runtime error).
    case interrupted
}

/// The camera that watches. The coordinator starts and stops it; nothing it sees outlives the frame being judged.
public protocol ShannonCameraWatchCapturing: AnyObject, Sendable {
    func start(limits: ShannonCameraWatchLimits, events: @escaping @Sendable (ShannonCameraWatchEvent) -> Void)
    /// Closes the camera, in order with any `start` asked before or after it. No event arrives after the close.
    func stop()
    /// Returns once everything asked so far has been done (the camera is closed after a `stop`).
    func waitUntilIdle() async
    /// The frame in flight was answered: the gate may send another, not before `notBefore`.
    func settle(notBefore: Date?)
}

/// Counts people in a frame with Apple Vision's human rectangles. No face is detected, identified or recognised.
enum ShannonCameraWatchPeople {
    static func count(in buffer: CVPixelBuffer) -> Int? {
        let request = VNDetectHumanRectanglesRequest()
        request.upperBodyOnly = true
        let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up, options: [:])
        guard (try? handler.perform([request])) != nil else { return nil }
        return request.results?.count ?? 0
    }
}

/// A continuous, video-only capture at a low preset (Syzygy ADR-0011 §4.4), separate from the one-shot look.
/// Frames are judged on the capture queue at most twice a second; the rest are dropped unread. A judged frame becomes a
/// 32 × 32 brightness grid and a person count, and only a frame the gate lets through is scaled and encoded, in memory.
/// Nothing is written to disk, the photo library, a log or a cache, and the audio session is never touched.
final class ShannonCameraWatchSession: NSObject, ShannonCameraWatchCapturing, AVCaptureVideoDataOutputSampleBufferDelegate,
    @unchecked Sendable {
    private let queue = DispatchQueue(label: "shannon.camera-watch", qos: .utility)
    private lazy var imageContext = CIContext(options: [.cacheIntermediates: false])
    // Everything below is touched on `queue` only.
    private var session: AVCaptureSession?
    private var events: (@Sendable (ShannonCameraWatchEvent) -> Void)?
    private var gate = ShannonCameraWatchGate()
    private var observers: [NSObjectProtocol] = []

    func start(limits: ShannonCameraWatchLimits, events: @escaping @Sendable (ShannonCameraWatchEvent) -> Void) {
        queue.async { self.begin(limits: limits, events: events) }
    }

    func stop() {
        queue.async { self.close() }
    }

    func waitUntilIdle() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async { done.resume() }
        }
    }

    func settle(notBefore: Date?) {
        queue.async { self.gate.settle(notBefore: notBefore) }
    }

    private static var device: AVCaptureDevice? {
#if os(iOS)
        // The camera that faces the owner while the app is open.
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
#else
        AVCaptureDevice.default(for: .video)
#endif
    }

    private func begin(limits: ShannonCameraWatchLimits, events: @escaping @Sendable (ShannonCameraWatchEvent) -> Void) {
        close()
        guard let device = Self.device, let input = try? AVCaptureDeviceInput(device: device) else {
            events(.interrupted)
            return
        }
        let session = AVCaptureSession()
        let output = AVCaptureVideoDataOutput()
        session.beginConfiguration()
#if os(iOS)
        // Video only: a call's microphone and playback stay exactly as they are.
        session.automaticallyConfiguresApplicationAudioSession = false
#endif
        if session.canSetSessionPreset(.vga640x480) { session.sessionPreset = .vga640x480 }
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        guard session.canAddInput(input), session.canAddOutput(output) else {
            session.commitConfiguration()
            events(.interrupted)
            return
        }
        session.addInput(input)
        session.addOutput(output)
        output.setSampleBufferDelegate(self, queue: queue)
        if let connection = output.connection(with: .video) {
            let angle = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: nil).videoRotationAngleForHorizonLevelCapture
            if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
        }
        session.commitConfiguration()
        self.session = session
        self.events = events
        gate.limits = limits
        gate.restart(at: Date())
        observe(session)
        session.startRunning()
        if !session.isRunning { fail() }
    }

    private func observe(_ session: AVCaptureSession) {
        let center = NotificationCenter.default
        observers = [AVCaptureSession.runtimeErrorNotification, AVCaptureSession.wasInterruptedNotification].map { name in
            center.addObserver(forName: name, object: session, queue: nil) { [weak self] _ in
                guard let self else { return }
                self.queue.async { if self.session === session { self.fail() } }
            }
        }
    }

    private func fail() {
        let events = self.events
        close()
        events?(.interrupted)
    }

    /// Closes the camera and forgets the gate's grid. Safe to call when nothing is open.
    private func close() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        events = nil
        guard let session else { return }
        self.session = nil
        session.outputs.forEach { ($0 as? AVCaptureVideoDataOutput)?.setSampleBufferDelegate(nil, queue: nil) }
        if session.isRunning { session.stopRunning() }
        gate.restart(at: Date())
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard session != nil, let events else { return }
        let now = Date()
        // Most frames end here, unread.
        guard gate.shouldJudge(at: now), let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let luma = Self.luma(of: buffer)
        let people = ShannonCameraWatchPeople.count(in: buffer)
        switch gate.decide(luma: luma, personCount: people, at: now) {
        case .skip:
            return
        case let .stopForOthers(count):
            close()
            events(.othersSeen(personCount: count))
        case let .send(reason, difference):
            guard let frame = encode(buffer) else {
                gate.settle(notBefore: nil)
                return
            }
            events(.shot(ShannonCameraWatchShot(frame: frame, capturedAt: now, reason: reason, difference: difference, personCount: people)))
        }
    }

    private static func luma(of buffer: CVPixelBuffer) -> [UInt8] {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return [] }
        let bytes = UnsafeRawBufferPointer(start: base, count: bytesPerRow * height)
        return ShannonCameraWatchFrameMath.luma(bgra: bytes, width: width, height: height, bytesPerRow: bytesPerRow)
    }

    /// The frame as a small JPEG without metadata, in memory. The bitmap is dropped when this returns.
    private func encode(_ buffer: CVPixelBuffer) -> ShannonAppLookFrame? {
        let image = CIImage(cvPixelBuffer: buffer)
        guard let bitmap = imageContext.createCGImage(image, from: image.extent) else { return nil }
        return ShannonAppLookEncoder.frame(from: bitmap, maximumSide: gate.limits.longSide, maximumBytes: gate.limits.frameBytes)
    }
}
