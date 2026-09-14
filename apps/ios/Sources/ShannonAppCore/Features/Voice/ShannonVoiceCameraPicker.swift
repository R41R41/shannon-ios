#if os(iOS)
import SwiftUI
import UIKit

struct ShannonVoiceCameraPicker: UIViewControllerRepresentable {
    let onCapture: @MainActor (UIImage) -> Void
    let onCancel: @MainActor () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        private let onCapture: @MainActor (UIImage) -> Void
        private let onCancel: @MainActor () -> Void

        init(
            onCapture: @escaping @MainActor (UIImage) -> Void,
            onCancel: @escaping @MainActor () -> Void
        ) {
            self.onCapture = onCapture
            self.onCancel = onCancel
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage else {
                Task { @MainActor in onCancel() }
                return
            }
            Task { @MainActor in onCapture(image) }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            Task { @MainActor in onCancel() }
        }
    }
}

extension UIImage {
    @MainActor
    func shannonCameraSnapshot(
        maxDimension: CGFloat = 1_280,
        maxBytes: Int = 2_800_000
    ) -> (preview: UIImage, data: Data)? {
        let longest = max(size.width, size.height)
        let scale = longest > maxDimension ? maxDimension / longest : 1
        let target = CGSize(width: max(1, size.width * scale), height: max(1, size.height * scale))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let normalized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            draw(in: CGRect(origin: .zero, size: target))
        }
        for quality in stride(from: CGFloat(0.78), through: CGFloat(0.42), by: -0.12) {
            if let data = normalized.jpegData(compressionQuality: quality), data.count <= maxBytes {
                return (normalized, data)
            }
        }
        return nil
    }
}
#endif
