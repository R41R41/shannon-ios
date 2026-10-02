#if os(iOS)
@preconcurrency import AVFoundation
import SwiftUI

/// Pre-permission copy for the voice call. Statements stay within implemented facts:
/// barge-in is supported, microphone PCM is streamed for recognition but never stored
/// by the app or Shannon's server, and ending the call stops capture.
extension ShannonPermissionPrimerContent {
    static let microphone = ShannonPermissionPrimerContent(
        symbol: "mic.fill",
        title: "シャノンと声で話すために、マイクを使います",
        message: "このあと表示されるiPhoneの確認で「許可」を選ぶと、そのまま話し始められます。",
        benefits: [
            .init(symbol: "waveform", text: "シャノンが話している途中でも、声で割り込めます。"),
            .init(
                symbol: "lock.shield",
                text: "録音データは保存しません。声は聞き取りのためだけに送り、端末にもシャノンのサーバーにも残しません。"
            ),
            .init(symbol: "phone.down", text: "「終了」を押せば、マイクはいつでもすぐに止まります。"),
        ],
        allowTitle: "続ける",
        deniedTitle: "マイクがオフになっています",
        deniedMessage: "設定アプリの「シャノン」でマイクをオンにすると、声で話せます。"
    )

    static let camera = ShannonPermissionPrimerContent(
        symbol: "camera.fill",
        title: "写真を見せるために、カメラを使います",
        message: "このあと表示されるiPhoneの確認で「許可」を選ぶと、撮影画面が開きます。",
        benefits: [
            .init(symbol: "hand.tap", text: "撮影画面で撮るのは、あなたがシャッターを押した1枚だけです。"),
            .init(symbol: "eye", text: "許可すると、会話中に見てと言われた時や気になった時に、シャノンがカメラで1枚見ることもあります。見た時は表示し、設定でいつでも止められます。"),
            .init(symbol: "eye", text: "撮った写真は、共有する前に確認して撮り直せます。"),
            .init(symbol: "xmark.circle", text: "やめたいときは、撮影画面の「キャンセル」で閉じられます。"),
        ],
        allowTitle: "続ける",
        deniedTitle: "カメラがオフになっています",
        deniedMessage: "設定アプリの「シャノン」でカメラをオンにすると、写真を撮って見せられます。"
    )
}

enum ShannonVoicePermissionPrimerKind: String, Identifiable {
    case microphone
    case camera

    var id: String { rawValue }

    var content: ShannonPermissionPrimerContent {
        switch self {
        case .microphone: .microphone
        case .camera: .camera
        }
    }
}

extension ShannonMediaPermission {
    static func currentMicrophone() -> ShannonMediaPermission {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: .granted
        case .denied: .denied
        case .undetermined: .undetermined
        @unknown default: .undetermined
        }
    }

    static func currentCamera() -> ShannonMediaPermission {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: .granted
        case .denied, .restricted: .denied
        case .notDetermined: .undetermined
        @unknown default: .undetermined
        }
    }
}
#endif
