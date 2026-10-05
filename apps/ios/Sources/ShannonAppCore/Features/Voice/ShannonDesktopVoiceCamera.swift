#if os(macOS)
@preconcurrency import AVFoundation
import AppKit
import CoreImage
import SwiftUI

/// The Mac's camera for a photo during a call: a live picture in a sheet and one frame when the owner
/// clicks 撮る. Frames of the video are used, not a photo capture, so that no shutter sound reaches the
/// call's microphone; nothing is written to disk or to the photo library.
final class ShannonDesktopCameraSession: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "shannon.voice.camera")
    private let lock = NSLock()
    private var latest: CVPixelBuffer?
    private lazy var context = CIContext(options: [.cacheIntermediates: false])

    static var hasCamera: Bool { AVCaptureDevice.default(for: .video) != nil }

    func start() {
        queue.async { [self] in
            guard session.inputs.isEmpty, let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device) else { return }
            let output = AVCaptureVideoDataOutput()
            output.alwaysDiscardsLateVideoFrames = true
            output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            output.setSampleBufferDelegate(self, queue: queue)
            session.beginConfiguration()
            session.sessionPreset = .high
            if session.canAddInput(input) { session.addInput(input) }
            if session.canAddOutput(output) { session.addOutput(output) }
            session.commitConfiguration()
            session.startRunning()
        }
    }

    func stop() {
        queue.async { [self] in
            session.stopRunning()
            lock.lock()
            latest = nil
            lock.unlock()
        }
    }

    /// The newest frame as a JPEG, or nil before the first frame.
    func takeJPEG() -> Data? {
        lock.lock()
        let buffer = latest
        lock.unlock()
        guard let buffer, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return context.jpegRepresentation(of: CIImage(cvPixelBuffer: buffer), colorSpace: space, options: [:])
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lock.lock()
        latest = buffer
        lock.unlock()
    }
}

/// The live picture of the camera session.
private struct ShannonDesktopCameraPreview: NSViewRepresentable {
    let session: AVCaptureSession

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.wantsLayer = true
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspect
        view.layer = layer
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// カメラで撮る: the picture, 撮る and キャンセル. The frame taken is shown in the call bar before it is shared.
struct ShannonDesktopVoiceCameraSheet: View {
    let take: (Data) -> Void
    let cancel: () -> Void
    /// Made once when the sheet appears, not with every rebuild of the view.
    @State private var camera: ShannonDesktopCameraSession?
    @State private var failed = false

    var body: some View {
        VStack(spacing: ShannonDesktopSpacing.medium) {
            Group {
                if let camera { ShannonDesktopCameraPreview(session: camera.session) } else { Color.black }
            }
                .frame(minWidth: 480, minHeight: 360)
                .background(Color.black)
                .clipShape(RoundedRectangle(cornerRadius: ShannonDesktopRadius.medium))
                .accessibilityLabel(ShannonGeneratedStrings.voiceMacCameraPreview)
            if failed {
                Text(ShannonGeneratedStrings.voiceMacCameraNotReady)
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(.secondary)
            }
            HStack {
                Button(ShannonGeneratedStrings.voiceMacCancel, role: .cancel, action: cancel)
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button(ShannonGeneratedStrings.voiceMacCameraTake) {
                    if let jpeg = camera?.takeJPEG() { take(jpeg) } else { failed = true }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(ShannonDesktopSpacing.large)
        .onAppear {
            if camera == nil { camera = ShannonDesktopCameraSession() }
            camera?.start()
        }
        .onDisappear { camera?.stop() }
    }
}
#endif
