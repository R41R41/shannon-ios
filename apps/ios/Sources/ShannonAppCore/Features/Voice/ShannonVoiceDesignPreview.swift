import Foundation

enum ShannonVoiceDesignPreview {
    static var isEnabled: Bool {
#if DEBUG
        ProcessInfo.processInfo.arguments.contains("-ShannonPreviewVoice")
#else
        false
#endif
    }
}
