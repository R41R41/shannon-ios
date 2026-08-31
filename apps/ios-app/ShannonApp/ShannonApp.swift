import ShannonAppCore
import SwiftUI
#if os(iOS)
import UIKit
#endif

@main
struct ShannonApp: App {
    var body: some Scene {
        WindowGroup {
            ShannonRootView()
        }
    }
}

private struct ShannonRootView: View {
    @State private var conversationModel: ShannonConversationModel
    @State private var connectionModel: ShannonConnectionModel

    init() {
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
            deviceName: {
#if os(iOS)
                UIDevice.current.name
#else
                "Apple device"
#endif
            }
        ))
    }

    var body: some View {
        ShannonConversationView(model: conversationModel, connectionModel: connectionModel)
    }
}
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
}
