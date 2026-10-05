#if os(macOS)
import AppKit

/// The Mac app's delegate. Quitting during a voice conversation ends the call first, as 終了 does (a
/// 「友人も一緒」 period is handed over to be remembered), and waits briefly, at most
/// `ShannonDesktopVoiceCall.quitLimit`, for `callEnded` and that period to reach the server; otherwise her
/// desktop body would stay quiet until the server's own limit.
@MainActor
public final class ShannonDesktopAppDelegate: NSObject, NSApplicationDelegate {
    /// The app's call. Set by the call itself when it is attached.
    static weak var voiceCall: ShannonDesktopVoiceCall?

    /// Answers a `.terminateLater`. Replaced in tests.
    var replyToTerminate: @MainActor (Bool) -> Void = { NSApplication.shared.reply(toApplicationShouldTerminate: $0) }

    public override init() {
        super.init()
    }

    public func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let call = Self.voiceCall, call.isShown else { return .terminateNow }
        Task { @MainActor [replyToTerminate] in
            await call.endForQuit()
            replyToTerminate(true)
        }
        return .terminateLater
    }
}
#endif
