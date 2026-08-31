import ShannonAppCore
import SwiftUI

@main
struct ShannonApp: App {
    var body: some Scene {
        WindowGroup {
            ShannonConversationView(
                model: ShannonConversationModel(
                    client: ShannonAPIClient(baseURL: ShannonRuntimeConfiguration.apiBaseURL)
                )
            )
        }
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
}
