import Foundation
import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonConnectionTests: XCTestCase {
    override func tearDown() {
        URLProtocolStub.handler = nil
        super.tearDown()
    }

    func testPairingStoresServerBoundCredential() async throws {
        let store = MemoryConnectionStore()
        let session = stubSession { request in
            XCTAssertEqual(request.url?.absoluteString, "https://shannon.example/companion/v1/pair")
            XCTAssertEqual(request.httpMethod, "POST")
            let body = try XCTUnwrap(requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
            XCTAssertEqual(json["code"], "ABCD1234EF90")
            XCTAssertEqual(json["deviceName"], "Test iPhone")
            return try response(
                url: request.url!,
                json: [
                    "token": String(repeating: "a", count: 43),
                    "deviceId": "device-1",
                    "scopeKey": "owner-a",
                    "displayName": "Test iPhone",
                    "expiresAt": "2099-08-31T00:00:00.000Z",
                ]
            )
        }
        let model = ShannonConnectionModel(
            baseURL: URL(string: "https://shannon.example/companion")!,
            store: store,
            session: session,
            deviceName: { "Test iPhone" }
        )
        let connected = await model.connect(using: URL(string: "shannon://connect?code=abcd-1234-ef90")!)

        XCTAssertTrue(connected)
        XCTAssertTrue(model.isConnected)
        XCTAssertEqual(model.statusLabel, "接続済み・Test iPhone")
        XCTAssertEqual(try store.load()?.scopeKey, "owner-a")
        XCTAssertEqual(try store.load()?.baseURL.absoluteString, "https://shannon.example/companion")
    }

    func testAPIClientUsesKeychainTokenAndBoundScope() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: String(repeating: "b", count: 43),
            deviceID: "device-2",
            scopeKey: "owner-from-server",
            displayName: "Test iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        let session = stubSession { request in
            XCTAssertEqual(request.url?.absoluteString, "https://shannon.example/companion/v1/chat")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(String(repeating: "b", count: 43))")
            let body = try XCTUnwrap(requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["scopeKey"] as? String, "owner-from-server")
            return try response(url: request.url!, json: chatResponseJSON())
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        _ = try await client.send(message: "こんにちは", scopeKey: "untrusted-client-scope")
    }

    func testExpiredOrDifferentServerCredentialIsNotConnected() throws {
        let stored = ShannonConnectionCredential(
            baseURL: URL(string: "https://old.example")!,
            token: String(repeating: "c", count: 43),
            deviceID: "device-3",
            scopeKey: "owner",
            displayName: "Old iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        )
        let model = ShannonConnectionModel(
            baseURL: URL(string: "https://new.example")!,
            store: MemoryConnectionStore(credential: stored)
        )
        XCTAssertFalse(model.isConnected)
        XCTAssertEqual(model.status, .disconnected)
    }

    func testInvalidCodeNeverStartsNetworkPairing() async {
        let model = ShannonConnectionModel(
            baseURL: URL(string: "https://shannon.example")!,
            store: MemoryConnectionStore()
        )
        let connected = await model.pair(code: "short")
        XCTAssertFalse(connected)
        guard case .failed(let message) = model.status else {
            return XCTFail("Invalid code must fail locally")
        }
        XCTAssertTrue(message.contains("正しく"))
    }

    func testConnectionLinkAcceptsOnlyShannonConnectURLs() async {
        XCTAssertEqual(
            ShannonConnectionModel.pairingCode(from: URL(string: "shannon://connect?code=abcd-EF12-3456")!),
            "ABCDEF123456"
        )
        XCTAssertNil(ShannonConnectionModel.pairingCode(from: URL(string: "https://example.com/connect?code=ABCDEF123456")!))
        XCTAssertNil(ShannonConnectionModel.pairingCode(from: URL(string: "shannon://other?code=ABCDEF123456")!))
        XCTAssertNil(ShannonConnectionModel.pairingCode(from: URL(string: "shannon://connect?code=short")!))
    }

    func testProvisioningDoesNotReplaceAnExistingConnection() async {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let original = ShannonConnectionCredential(
            baseURL: baseURL,
            token: String(repeating: "d", count: 43),
            deviceID: "existing-device",
            scopeKey: "owner",
            displayName: "Existing iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        )
        let store = MemoryConnectionStore(credential: original)
        let session = stubSession { _ in
            XCTFail("An existing Keychain connection must not be paired again")
            throw ShannonConnectionError.invalidResponse
        }
        let model = ShannonConnectionModel(baseURL: baseURL, store: store, session: session)

        let connected = await model.pair(code: "ABCD-EF12-3456")
        XCTAssertTrue(connected)
        XCTAssertEqual(try? store.load(), original)
    }
}

private final class MemoryConnectionStore: ShannonConnectionStoreProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var credential: ShannonConnectionCredential?

    init(credential: ShannonConnectionCredential? = nil) {
        self.credential = credential
    }

    func load() throws -> ShannonConnectionCredential? {
        lock.withLock { credential }
    }

    func save(_ credential: ShannonConnectionCredential) throws {
        lock.withLock { self.credential = credential }
    }

    func delete() throws {
        lock.withLock { credential = nil }
    }
}

private final class URLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: ShannonConnectionError.invalidResponse)
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@MainActor
private func stubSession(
    handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
) -> URLSession {
    URLProtocolStub.handler = handler
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolStub.self]
    return URLSession(configuration: configuration)
}

private func response(url: URL, json: [String: Any]) throws -> (HTTPURLResponse, Data) {
    let response = try XCTUnwrap(HTTPURLResponse(
        url: url,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["content-type": "application/json"]
    ))
    return (response, try JSONSerialization.data(withJSONObject: json))
}

private func requestBody(_ request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 1_024)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        result.append(buffer, count: count)
    }
    return result
}

private func chatResponseJSON() -> [String: Any] {
    [
        "mode": "local-stub",
        "reply": "こんにちは",
        "snapshotVersion": 0,
        "messageEmotion": [
            "valence": 0,
            "arousal": 0.3,
            "openness": 0.35,
            "expression": "calm",
        ],
        "systemPrompt": "prompt",
        "state": [
            "scopeKey": "owner-from-server",
            "version": 0,
            "updatedAt": "2026-08-31T00:00:00.000Z",
            "temperament": [
                "curiosity": 0.65,
                "initiative": 0.25,
                "closeness": 0.15,
                "calmness": 0.60,
                "needForContinuity": 0.70,
                "confidenceAboutUser": 0.05,
            ],
            "emotion": ["valence": 0, "arousal": 0.3, "openness": 0.35],
            "interests": [],
            "userFacts": [],
            "activeMemories": [],
        ],
    ]
}
