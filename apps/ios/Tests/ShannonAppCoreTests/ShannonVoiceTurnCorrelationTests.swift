import Foundation
import Testing
@testable import ShannonAppCore

struct ShannonVoiceTurnCorrelationTests {
    @Test func concurrentHistoryWritesKeepTheirUtteranceIdentity() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [VoiceCorrelationURLProtocol.self]
        let session = URLSession(configuration: config)
        let client = ShannonAPIClient(baseURL: URL(string: "https://voice-correlation.invalid")!,
            apiToken: "fixture", session: session)
        defer { session.invalidateAndCancel() }
        await withTaskGroup(of: Void.self) { group in
            for id in ["first", "second"] {
                group.addTask {
                    await ShannonVoiceTurnCorrelation.$utteranceID.withValue(id) {
                        await Task.yield()
                        // The fixture rejects after inspecting the real request; no response state is needed.
                        _ = try? await client.commitRealtimeVoiceTurn(scopeKey: "owner", threadId: "talk",
                            userTranscript: id, shannonTranscript: "visible text", emotion: nil,
                            companionPresent: false, feedbackRecordID: nil)
                    }
                }
            }
        }
        #expect(ShannonVoiceTurnCorrelation.utteranceID == nil)
        _ = try? await client.commitRealtimeVoiceTurn(scopeKey: "owner", threadId: "talk",
            userTranscript: "legacy", shannonTranscript: "visible text", emotion: nil,
            companionPresent: false, feedbackRecordID: nil)
        #expect(VoiceCorrelationURLProtocol.receipts.values == ["first": "first", "second": "second", "legacy": "absent"])
    }
}

private final class VoiceCorrelationReceipts: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: String] = [:]
    var values: [String: String] { lock.withLock { stored } }
    func record(_ key: String, _ value: String) { lock.withLock { stored[key] = value } }
}
private final class VoiceCorrelationURLProtocol: URLProtocol, @unchecked Sendable {
    static let receipts = VoiceCorrelationReceipts()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                body.append(contentsOf: buffer.prefix(count))
            }
        }
        if let value = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
           let text = value["userTranscript"] as? String {
            Self.receipts.record(text, value["utteranceId"] as? String ?? "absent")
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
