import Foundation
import Testing
@testable import ShannonAppCore

@Suite(.serialized) @MainActor
struct ShannonModelModeAPIClientTests {
    @Test func pairedGetAndPutUseCanonicalPathCredentialAndExactCASBody() async throws {
        let store = ModelModeConnectionStore(modeCredential())
        ModelModeURLProtocol.fixture.reset { request in
            let value = request.httpMethod == "PUT" ? modeFixture(.sonnet, revision: 1) : modeFixture()
            return (200, try JSONEncoder().encode(value))
        }
        defer { ModelModeURLProtocol.fixture.reset() }
        let client = makeClient(store)
        let first = try await client.loadModelMode()
        let changed = try await client.setModelMode(.sonnet, expectedRevision: first.revision)
        let sent = ModelModeURLProtocol.fixture.requests
        #expect(sent.count == 2 && changed.mode == .sonnet)
        #expect(sent.map { $0.url?.absoluteString } == Array(repeating: "https://synthetic.invalid/companion/v1/model-mode", count: 2))
        #expect(sent.map(\.httpMethod) == ["GET", "PUT"])
        #expect(sent.allSatisfy { $0.value(forHTTPHeaderField: "authorization") == "Bearer synthetic-token" })
        #expect(sent.allSatisfy { $0.value(forHTTPHeaderField: "cache-control") == "no-store" })
        let body = try #require(ModelModeURLProtocol.fixture.bodies.last)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(Set(json.keys) == ["mode", "expectedRevision"])
        #expect(json["mode"] as? String == "sonnet" && json["expectedRevision"] as? Int == 0)
    }

    @Test func staticBearerNeverSubstitutesForAPairedOwnerCredential() async {
        ModelModeURLProtocol.fixture.reset()
        defer { ModelModeURLProtocol.fixture.reset() }
        let client = makeClient(ModelModeConnectionStore(nil))
        await #expect(throws: ShannonModelModeAPIError.pairingRequired) { try await client.loadModelMode() }
        await #expect(throws: ShannonModelModeAPIError.pairingRequired) { try await client.setModelMode(.sonnet, expectedRevision: 0) }
        #expect(ModelModeURLProtocol.fixture.requests.isEmpty)
    }

    @Test func credentialChangedDuringNetworkSuspensionRejectsEvenAValidResponse() async {
        let store = ModelModeConnectionStore(modeCredential())
        ModelModeURLProtocol.fixture.reset { _ in
            try store.save(modeCredential(scope: "different-owner", token: "different-token"))
            return (200, try JSONEncoder().encode(modeFixture(.sonnet, revision: 1)))
        }
        defer { ModelModeURLProtocol.fixture.reset() }
        let client = makeClient(store)
        await #expect(throws: ShannonModelModeAPIError.connectionChanged) { try await client.setModelMode(.sonnet, expectedRevision: 0) }
        #expect(ModelModeURLProtocol.fixture.requests.count == 1)
    }

    @Test func credentialChangedBeforeSendCannotWriteAnotherOwnerAtTheSameRevision() async throws {
        let store = ModelModeConnectionStore(modeCredential())
        ModelModeURLProtocol.fixture.reset()
        defer { ModelModeURLProtocol.fixture.reset() }
        let client = makeClient(store)
        let original = try #require(client.modelModeConnection())
        try store.save(modeCredential(scope: "different-owner", token: "different-token"))
        await #expect(throws: ShannonModelModeAPIError.connectionChanged) {
            try await client.setModelMode(.sonnet, expectedRevision: 0, connection: original)
        }
        #expect(ModelModeURLProtocol.fixture.requests.isEmpty)
    }

    @Test(arguments: [401, 403, 404, 409, 503])
    func failureStatusIsPreservedWithoutConsumingErrorSnapshotAsSuccess(status: Int) async {
        ModelModeURLProtocol.fixture.reset { _ in
            (status, Data(#"{"error":"MODEL_MODE_CONFLICT","current":{"mode":"sonnet","revision":3}}"#.utf8))
        }
        defer { ModelModeURLProtocol.fixture.reset() }
        let client = makeClient(ModelModeConnectionStore(modeCredential()))
        await #expect(throws: ShannonModelModeAPIError.rejected(status: status)) {
            try await client.setModelMode(.sonnet, expectedRevision: 0)
        }
        #expect(ModelModeURLProtocol.fixture.requests.count == 1)
    }

    @Test func invalidModeResponseFailsClosedAndApplicationLabelsIgnoreUnknownScopes() async throws {
        ModelModeURLProtocol.fixture.reset { _ in (200, Data(#"{"mode":"unrecognized","revision":0}"#.utf8)) }
        defer { ModelModeURLProtocol.fixture.reset() }
        let client = makeClient(ModelModeConnectionStore(modeCredential()))
        await #expect(throws: (any Error).self) { try await client.loadModelMode() }
        let value = ShannonModelModeDTO(mode: .haiku, revision: 0, available: .init(haiku: true, sonnet: false),
            models: .init(haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5"), appliesTo: ["conversation", "future-unknown"])
        #expect(value.applicationLabel == "適用先：会話")
    }

    private func makeClient(_ store: ModelModeConnectionStore) -> ShannonAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ModelModeURLProtocol.self]
        return ShannonAPIClient(baseURL: modeCredential().baseURL, apiToken: "synthetic-local-token",
            connectionStore: store, session: URLSession(configuration: configuration))
    }
}

private final class ModelModeConnectionStore: ShannonConnectionStoreProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var value: ShannonConnectionCredential?
    init(_ value: ShannonConnectionCredential?) { self.value = value }
    func load() throws -> ShannonConnectionCredential? { lock.withLock { value } }
    func save(_ value: ShannonConnectionCredential) throws { lock.withLock { self.value = value } }
    func delete() throws { lock.withLock { value = nil } }
}

private final class ModelModeURLProtocol: URLProtocol, @unchecked Sendable {
    static let fixture = ModelModeHTTPFixture()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.fixture.reply(request)
            guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: status,
                httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"]) else { throw ShannonAPIError.invalidResponse }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private final class ModelModeHTTPFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
    private var seen: [URLRequest] = []
    private var sentBodies: [Data] = []
    var requests: [URLRequest] { lock.withLock { seen } }
    var bodies: [Data] { lock.withLock { sentBodies } }
    func reset(_ handler: (@Sendable (URLRequest) throws -> (Int, Data))? = nil) {
        lock.withLock { self.handler = handler; seen = []; sentBodies = [] }
    }
    func reply(_ request: URLRequest) throws -> (Int, Data) {
        let body: Data
        if let value = request.httpBody { body = value }
        else if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var value = Data(), buffer = [UInt8](repeating: 0, count: 1024)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                value.append(contentsOf: buffer.prefix(count))
            }
            body = value
        } else { body = Data() }
        let callback = lock.withLock { seen.append(request); sentBodies.append(body); return handler }
        guard let callback else { throw ShannonAPIError.invalidResponse }
        return try callback(request)
    }
}
