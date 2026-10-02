import Foundation
import Observation

/// What the settings row says about calls from Shannon.
public enum ShannonIncomingCallStatus: Equatable, Sendable {
    /// The owner has not switched it on.
    case off
    /// On, and this iPhone is not connected to Shannon yet.
    case notPaired
    /// On, and the phone has not handed the app its call address yet, or the server was not told yet.
    case preparing
    /// On, and the server cannot ring: no key for Apple's push service there, or calls are switched off there.
    case serverNotReady
    /// On, and the server could not be reached to register.
    case unreachable
    /// On: she can call.
    case ready
}

/// The owner's switch 「シャノンからの着信を受ける」 (owner decision 2026-10-03), and what follows from it:
/// this iPhone's VoIP push token is registered with the server while the switch is on, and withdrawn
/// (`enabled: false`) when it goes off. Off until he turns it on.
///
/// The token is the phone's address for calls. It is kept in memory only; the phone hands it over at
/// every launch.
@MainActor
@Observable
public final class ShannonIncomingCallSettings {
    public private(set) var isEnabled: Bool
    public private(set) var status: ShannonIncomingCallStatus = .off

    @ObservationIgnored private let server: (any ShannonIncomingCallServing)?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let environment: ShannonPushEnvironmentDTO
    @ObservationIgnored private let bundleID: String
    @ObservationIgnored private var token: String?
    @ObservationIgnored private var isRegistering = false
    @ObservationIgnored private var needsAnotherPass = false
    /// While the switch is on, the device's connection is stored so that it can be read while the phone is locked
    /// (after its first unlock): a call answered on the lock screen has to reach the server.
    @ObservationIgnored public var setCredentialReadableWhileLocked: @MainActor (Bool) -> Void = { _ in }

    public static let enabledDefaultsKey = "shannon.incomingCall.enabled"
    /// The server holds this phone's token with the switch on: turning it off has to be told.
    public static let registeredDefaultsKey = "shannon.incomingCall.registered"

    public init(
        server: (any ShannonIncomingCallServing)?, environment: ShannonPushEnvironmentDTO, bundleID: String,
        defaults: UserDefaults = .standard
    ) {
        self.server = server
        self.environment = environment
        self.bundleID = bundleID
        self.defaults = defaults
        isEnabled = defaults.bool(forKey: Self.enabledDefaultsKey)
        status = isEnabled ? .preparing : .off
    }

    public func setEnabled(_ enabled: Bool) {
        guard enabled != isEnabled else { return }
        isEnabled = enabled
        defaults.set(enabled, forKey: Self.enabledDefaultsKey)
        setCredentialReadableWhileLocked(enabled)
        status = enabled ? .preparing : .off
        Task { await synchronize() }
    }

    /// The phone handed the app its call address (at launch, or when it changed).
    public func received(token: String) {
        guard token != self.token else { return }
        self.token = token
        Task { await synchronize() }
    }

    /// Tells the server the token and the switch. Called when either changes, when the app is opened, and when it connects.
    public func synchronize() async {
        guard !isRegistering else {
            needsAnotherPass = true
            return
        }
        isRegistering = true
        defer { isRegistering = false }
        repeat {
            needsAnotherPass = false
            await register()
        } while needsAnotherPass
    }

    private func register() async {
        // The stored switch is the truth: a launch before the phone's first unlock could not read it.
        let stored = defaults.bool(forKey: Self.enabledDefaultsKey)
        if stored != isEnabled { isEnabled = stored }
        let enabled = isEnabled
        // Nothing is sent about a phone whose owner never switched calls on.
        guard enabled || defaults.bool(forKey: Self.registeredDefaultsKey) else {
            status = .off
            return
        }
        guard let server, server.incomingCallIsPaired() else {
            status = enabled ? .notPaired : .off
            return
        }
        guard let token else {
            status = enabled ? .preparing : .off
            return
        }
        do {
            let answer = try await server.registerIncomingCalls(deviceToken: token, environment: environment, bundleId: bundleID, enabled: enabled)
            defaults.set(enabled, forKey: Self.registeredDefaultsKey)
            guard enabled == isEnabled else { return }
            status = !enabled ? .off : answer.available ? .ready : .serverNotReady
        } catch {
            guard enabled == isEnabled else { return }
            // An older server has no such route; one that is down answers nothing. Either way she cannot call yet.
            if case ShannonAPIError.rejected(status: 404) = error {
                status = enabled ? .serverNotReady : .off
            } else {
                status = enabled ? .unreachable : .off
            }
        }
    }
}

/// Wording of the call settings. Neutral status text, not Shannon's voice.
public enum ShannonIncomingCallCopy {
    public static let sectionTitle = "シャノンからの電話"
    public static let toggleTitle = "シャノンからの着信を受ける"
    public static let toggleHint = "オンにすると、シャノンが自分から話しかけたいときに、このiPhoneへ電話をかけます"
    /// The name the phone shows for the caller.
    public static let callerName = "シャノン"

    public static let explanation = "オンにすると、シャノンが自分から話しかけたいときに、ほかの方法で声を届けられなければ、このiPhoneに電話をかけます。"
        + "アプリを閉じていても、画面をロックしていても鳴ります。出るかどうかは、そのとき選べます。"
        + "出ると、シャノンがまず一言話し、そのまま音声会話になります。会話はいつもどおり保存されます。"
        + "出なかったときは不在着信として残り、シャノンの言葉はトークに残ります。\n\n"
        + "時間帯の制限はありません。夜中に鳴ることもあります。鳴らしたくないときは、iPhoneの集中モード（おやすみモードなど）を使ってください。"
        + "イヤホンをつないでいなくても鳴ります。イヤホンなしで出ると、iPhoneの受話口かスピーカーから声が出ます。\n\n"
        + "着信と不在着信は「電話」アプリの履歴にも残ります。"
        + "ロック中でも電話に出られるように、オンの間は、このiPhoneとシャノンの接続情報をロック中でも読める形で保存します（再起動のあと、一度ロックを解除するまでは読めません）。"
        + "最初はオフです。"

    public static let confirmTitle = "シャノンからの着信を受けますか"
    public static let confirmMessage = "シャノンが自分から話しかけたいときに、このiPhoneに電話をかけます。時間帯の制限はなく、夜中に鳴ることもあります（集中モード中は鳴りません）。"
        + "出るかどうかは、そのとき選べます。着信は「電話」アプリの履歴にも残ります。"
    public static let confirmAccept = "受ける"
    public static let confirmCancel = "やめておく"

    public static let microphoneDenied = "マイクが許可されていないため、電話に出てもシャノンの一言を聞くだけで、会話はできません。"

    public static func statusText(_ status: ShannonIncomingCallStatus) -> String {
        switch status {
        case .off: return "オフ"
        case .notPaired: return "シャノンに接続すると、着信を受けられます"
        case .preparing: return "準備しています"
        case .serverNotReady: return "サーバー側の準備がまだです"
        case .unreachable: return "サーバーに届きませんでした。アプリを開き直すと、もう一度試します"
        case .ready: return "着信を受けられます"
        }
    }
}
