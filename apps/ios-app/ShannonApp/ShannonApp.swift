import ShannonAppCore
import SwiftUI
#if os(iOS)
import UIKit
#endif

@main
struct ShannonApp: App {
#if os(iOS)
    @UIApplicationDelegateAdaptor(ShannonAppDelegate.self) private var appDelegate
#endif
    @State private var conversationModel: ShannonConversationModel
    @State private var connectionModel: ShannonConnectionModel

    init() {
#if os(iOS)
        let deviceDisplayName = UIDevice.current.name
#else
        let deviceDisplayName = "Apple device"
#endif
        let connectionStore = ShannonKeychainConnectionStore()
        let client = ShannonAPIClient(
            baseURL: ShannonRuntimeConfiguration.apiBaseURL,
            apiToken: ShannonRuntimeConfiguration.apiToken,
            connectionStore: connectionStore
        )
        _conversationModel = State(initialValue: ShannonConversationModel(client: client))
        _connectionModel = State(initialValue: ShannonConnectionModel(
            baseURL: ShannonRuntimeConfiguration.apiBaseURL,
            store: connectionStore,
            deviceName: { deviceDisplayName }
        ))
    }

    var body: some Scene {
        WindowGroup {
            ShannonConversationView(model: conversationModel, connectionModel: connectionModel)
                .onOpenURL { url in
                    Task { await connectionModel.connect(using: url) }
                }
#if os(iOS)
                .task {
                    if let url = ShannonAppDelegate.takePendingConnectionURL() {
                        await connectionModel.connect(using: url)
                    } else if let code = ShannonRuntimeConfiguration.launchPairingCode {
                        await connectionModel.pair(code: code)
                    }
                }
#endif
        }
    }
}

#if os(iOS)
@MainActor
private final class ShannonAppDelegate: NSObject, UIApplicationDelegate {
    private static var pendingConnectionURL: URL?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        Self.pendingConnectionURL = launchOptions?[.url] as? URL
        return true
    }

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        Self.pendingConnectionURL = url
        return true
    }

    static func takePendingConnectionURL() -> URL? {
        defer { pendingConnectionURL = nil }
        return pendingConnectionURL
    }
}
#endif
private enum ShannonRuntimeConfiguration {
    static let apiBaseURL: URL = {
        let configured = Bundle.main.object(forInfoDictionaryKey: "ShannonAPIBaseURL") as? String
        if let configured,
           !configured.isEmpty,
           !configured.contains("$("),
           let url = URL(string: configured) {
            return url
        }
        return URL(string: "http://127.0.0.1:4317")!
    }()

    static let apiToken: String? = {
        let configured = Bundle.main.object(forInfoDictionaryKey: "ShannonAPIToken") as? String
        guard let configured, !configured.isEmpty, !configured.contains("$(") else { return nil }
        return configured
    }()

    static let launchPairingCode: String? = {
        let code = ProcessInfo.processInfo.environment["SHANNON_PAIRING_CODE"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        return code?.isEmpty == false ? code : nil
    }()
}
