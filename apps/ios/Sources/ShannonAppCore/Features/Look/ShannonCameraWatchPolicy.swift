import Foundation

/// The owner's switch 「アプリを開いている間は見る」 (Syzygy ADR-0011 §4.4). On unless he turned it off.
public enum ShannonCameraWatchPreference {
    public static let enabledDefaultsKey = "shannon.camera-watch.enabled"

    public static func isEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: enabledDefaultsKey) as? Bool ?? true
    }
}

/// What the server says about watching, as last read.
public enum ShannonCameraWatchServerVerdict: Equatable, Sendable {
    /// Not read since the camera was last stopped: it is read before the camera opens.
    case unknown
    case allowed
    case refused(ShannonVisionStopReason)
    /// The vision worker did not answer (ADR-0011 §8.1): watching stops until it answers again.
    case unreachable
    /// This server has no vision route, or refused this device: watching stays off until the app is opened again.
    case unsupported
}

/// Every fact watching depends on, read at one moment. ADR-0011 §4.4: all must hold, or the camera is closed.
public struct ShannonCameraWatchConditions: Equatable, Sendable {
    /// iPhone: the app is active. Mac: one of Shannon's windows is on screen (not hidden, minimised or covered).
    public var appInFront = true
    /// iPhone: protected data is available (the device is unlocked). Mac: the screen is not locked, asleep or saving.
    public var unlocked = true
    public var permission = ShannonMediaPermission.granted
    public var hasCamera = true
    /// 「アプリを開いている間は見る」.
    public var settingOn = true
    public var lowPowerMode = false
    /// The device's thermal state is `.serious` or `.critical`.
    public var thermalHeavy = false
    /// Someone else may be listening on this device (「友人も一緒」, a recent companion, the stream output).
    public var othersPresent = false
    /// The device itself saw two or more people since the app was last opened.
    public var othersSeen = false
    /// The owner pressed 「止める」 on the sign.
    public var stoppedByOwner = false
    /// A one-shot look holds the camera.
    public var lookInProgress = false
    /// The camera could not open or was taken away (another app, a call): tried again on the next change or after a while.
    public var cameraBusy = false
    /// A surface that shows 「見ています」 is on screen. No camera without its sign.
    public var hasSign = true
    /// The client can send frames (a real server connection, not a design preview).
    public var canSend = true
    public var server = ShannonCameraWatchServerVerdict.allowed

    public init() {}
}

/// Why the camera is closed now. Ordered as `ShannonCameraWatchPolicy.verdict` checks them.
public enum ShannonCameraWatchHold: Equatable, Sendable {
    case notConnected
    case noSign
    case background
    case locked
    case switchedOff
    case stoppedByOwner
    case noCamera
    case noPermission
    case lowPower
    case hot
    case othersPresent
    case othersSeen
    case lookInProgress
    case cameraBusy
    case server(ShannonVisionStopReason)
    case serverUnreachable
    case unsupported
}

public enum ShannonCameraWatchVerdict: Equatable, Sendable {
    /// Every condition holds: the camera may run.
    case watch
    /// Everything on the device holds; the server's word is read before the camera opens.
    case askServer
    case hold(ShannonCameraWatchHold)
}

/// The one rule for whether the camera watches (Syzygy ADR-0011 §4.4). Pure, so that each condition is tested on its own.
public enum ShannonCameraWatchPolicy {
    public static func verdict(_ facts: ShannonCameraWatchConditions) -> ShannonCameraWatchVerdict {
        if let hold = deviceHold(facts) { return .hold(hold) }
        switch facts.server {
        case .allowed: return .watch
        case .unknown: return .askServer
        case let .refused(reason): return .hold(.server(reason))
        case .unreachable: return .hold(.serverUnreachable)
        case .unsupported: return .hold(.unsupported)
        }
    }

    /// The first fact on the device that closes the camera, or nil when all of them allow it.
    /// The permission is never asked for here: only an answer the owner already gave (the one-shot look asks).
    static func deviceHold(_ facts: ShannonCameraWatchConditions) -> ShannonCameraWatchHold? {
        let checks: [(Bool, ShannonCameraWatchHold)] = [
            (facts.canSend, .notConnected),
            (facts.hasSign, .noSign),
            (facts.appInFront, .background),
            (facts.unlocked, .locked),
            (facts.settingOn, .switchedOff),
            (!facts.stoppedByOwner, .stoppedByOwner),
            (facts.hasCamera, .noCamera),
            (facts.permission == .granted, .noPermission),
            (!facts.lowPowerMode, .lowPower),
            (!facts.thermalHeavy, .hot),
            (!facts.othersPresent, .othersPresent),
            (!facts.othersSeen, .othersSeen),
            (!facts.lookInProgress, .lookInProgress),
            (!facts.cameraBusy, .cameraBusy),
        ]
        return checks.first { !$0.0 }?.1
    }

    /// The server's answer, as a verdict. The server allows only `owner_alone`; the device also keeps the camera closed at
    /// degrade 2 or above (ADR-0011 §7.3: 「カメラの見続けも止める」), whatever `watchAllowed` says.
    public static func serverVerdict(_ status: ShannonVisionStatus) -> ShannonCameraWatchServerVerdict {
        guard status.watchAllowed else { return .refused(status.reason ?? .disabled) }
        return status.degrade >= stopDegrade ? .refused(.degraded) : .allowed
    }

    /// From this degrade step on, watching stops (§7.3).
    public static let stopDegrade = 2

    /// How often the server's word is read again while the app is open.
    public static let statusRefreshSeconds: Double = 30
}

/// Copy of watching, in one place. Status words are neutral; nothing here is said as Shannon.
public enum ShannonCameraWatchCopy {
    public static let toggleTitle = "アプリを開いている間は見る"
    public static let toggleHint = "オンにすると、アプリが画面に出ている間、シャノンがカメラで様子を見ます。オフにすると見続けません"
    public static let explanation = "アプリが画面に出ている間、シャノンがカメラで様子を見ます。映像は端末の中で変化を確かめるだけに使い、何か変わった時だけ、小さくした1枚を送ります。映像も送った1枚も、端末にもサーバーにも保存しません。ほかの人が映った時、後ろへ回した時、ロックした時は止めます。見ている間は「見ています」と表示し、そこからいつでも止められます。"
    public static let watching = "見ています"
    public static let watchingAccessibility = "シャノンがカメラで様子を見ています"
    public static let stop = "止める"
    public static let stopHint = "カメラで見るのを止めます。アプリを開き直すか、再開を押すまで止めたままです"
    public static let resume = "再開"
    public static let resumeHint = "カメラで見るのを再開します"
    public static let stoppedByOwner = "見るのを止めています"

    /// The line under the switch. Watching never asks for the camera: without the system's permission it does not watch.
    public static func statusText(enabled: Bool, permission: ShannonMediaPermission, hasCamera: Bool) -> String {
        if !hasCamera { return "この端末にはカメラがありません" }
        if !enabled { return "見続けません" }
        switch permission {
        case .granted: return "アプリが画面に出ている間、変化があった時だけ送ります"
        case .undetermined: return "カメラを許可すると見ます"
        case .denied: return "カメラの権限がありません"
        }
    }

    /// Why watching stopped, shown for a few seconds on the sign. nil for a stop that needs no word.
    public static func stopped(_ hold: ShannonCameraWatchHold) -> String? {
        switch hold {
        case .othersSeen: "ほかの人が映ったので、見るのを止めました"
        case .server(.audience): "ほかの人がいるので、見るのを止めました"
        case .server(.budget): "今日の分を使い切ったので、見るのを止めました"
        case .server(.degraded), .serverUnreachable: "いまは見られないので、見るのを止めました"
        case .server(.disabled): "見る仕組みが止まっているので、見るのを止めました"
        case .hot: "端末が熱くなっているので、見るのを止めました"
        default: nil
        }
    }
}
