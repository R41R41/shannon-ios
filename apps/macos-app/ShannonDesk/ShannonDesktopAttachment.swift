import ShannonAppCore

typealias ShannonDesktopAttachmentLimits = ShannonChatAttachmentLimits
typealias ShannonDesktopAttachmentError = ShannonChatAttachmentError
typealias ShannonDesktopAttachmentLoader = ShannonChatAttachmentLoader

/// Where ⌘↩︎ sends the draft. During 「友人も一緒」 nothing ever goes to the owner's Talk: into the live call, or,
/// with that call failed and still on screen, nowhere until it is ended or connected again (his attachments, web
/// search and photo, which are hidden then, are never sent with it).
enum DesktopComposerRoute: Equatable {
    case call, talk, none

    static func route(callHoldsMicrophone: Bool, hidesOwnerScreens: Bool) -> DesktopComposerRoute {
        if callHoldsMicrophone { return .call }
        return hidesOwnerScreens ? .none : .talk
    }
}
