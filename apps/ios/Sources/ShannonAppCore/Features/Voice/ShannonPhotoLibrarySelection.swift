#if os(iOS)
import Foundation
import PhotosUI
import SwiftUI
import UIKit

struct ShannonPreparedPhoto {
    let preview: UIImage
    let jpegData: Data
}

enum ShannonPhotoLibraryError: LocalizedError {
    case unavailable
    case tooLarge
    case invalidImage

    var errorDescription: String? {
        switch self {
        case .unavailable: "写真を読み込めませんでした。別の写真を選んでください。"
        case .tooLarge: "この写真は大きすぎます。別の写真を選んでください。"
        case .invalidImage: "写真を共有用に準備できませんでした。別の写真を選んでください。"
        }
    }
}

@MainActor
enum ShannonPhotoLibrarySelection {
    static func prepare(_ item: PhotosPickerItem) async throws -> ShannonPreparedPhoto {
        guard let data = try await item.loadTransferable(type: Data.self) else {
            throw ShannonPhotoLibraryError.unavailable
        }
        guard data.count <= 30 * 1_024 * 1_024 else {
            throw ShannonPhotoLibraryError.tooLarge
        }
        guard let image = UIImage(data: data),
              let snapshot = image.shannonCameraSnapshot()
        else {
            throw ShannonPhotoLibraryError.invalidImage
        }
        return ShannonPreparedPhoto(preview: snapshot.preview, jpegData: snapshot.data)
    }
}
#endif
