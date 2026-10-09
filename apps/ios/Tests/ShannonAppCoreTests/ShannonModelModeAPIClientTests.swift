import Foundation
import Testing
@testable import ShannonAppCore

@Suite(.serialized) @MainActor
struct ShannonModelModeAPIClientTests {
    @Test(arguments: [false, true])
    func settingsUsePairedOwnerWithDefaultConversationScope(cachedConnected: Bool) async throws {
        let store = ModelModeConnectionStore(modeCredential(scope: "owner-from-server"))
        ModelModeURLProtocol.fixture.reset { request in
            (200, try JSONEncoder().encode(request.httpMethod == "PUT" ? modeFixture(.sonnet, revision: 1) : modeFixture()))
        }
        defer { ModelModeURLProtocol.fixture.reset() }
        let client = makeClient(store)
        let conversation = ShannonConversationModel(client: client, usesDisplayCache: false)
        let section = ShannonModelModeSettingsSection(conversation: conversation, connected: cachedConnected)
        let context = section.connectionContext
        #expect(conversation.scopeKey == "local-owner")
        #expect(context.scopeKey == "owner-from-server" && context.isPaired)
        let model = context.makeModel(client: client)
        await model.reload()
        #expect(model.isFresh && model.canChange && model.snapshot?.mode == .haiku)
        await model.select(.sonnet)
        #expect(model.snapshot?.mode == .sonnet && model.snapshot?.revision == 1)
        #expect(conversation.scopeKey == "local-owner") // Display-cache identity is not a server authorization scope.
        let requests = ModelModeURLProtocol.fixture.requests
        #expect(requests.map(\.httpMethod) == ["GET", "PUT"])
        #expect(requests.allSatisfy { $0.url?.path == "/companion/v1/model-mode" })
        let body = try #require(ModelModeURLProtocol.fixture.bodies.last)
        let command = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(command["mode"] as? String == "sonnet" && command["expectedRevision"] as? Int == 0)
        #expect(command["scopeKey"] == nil)
    }

    @Test(arguments: ["missing", "expired", "other-server"])
    func cachedConnectedLabelCannotAuthorizeModelSettings(credentialState: String) async throws {
        let valid = modeCredential(scope: "owner-from-server")
        let credential = switch credentialState {
        case "expired": ShannonConnectionCredential(baseURL: valid.baseURL, token: valid.token, deviceID: valid.deviceID,
            scopeKey: valid.scopeKey, displayName: valid.displayName, expiresAt: .distantPast)
        case "other-server": modeCredential(scope: "owner-from-server", server: "https://other.invalid/companion")
        default: nil as ShannonConnectionCredential?
        }
        ModelModeURLProtocol.fixture.reset()
        defer { ModelModeURLProtocol.fixture.reset() }
        let client = makeClient(ModelModeConnectionStore(credential))
        let conversation = ShannonConversationModel(client: client, usesDisplayCache: false)
        let context = ShannonModelModeSettingsSection(conversation: conversation, connected: true).connectionContext
        #expect(!context.isPaired && context.scopeKey == "local-owner")
        let model = context.makeModel(client: client)
        await model.reload()
        await model.select(.sonnet)
        #expect(model.connectionIdentity == nil && !model.canChange && model.snapshot == nil)
        #expect(model.statusText == "シャノンに接続すると切り替えられます。")
        #expect(ModelModeURLProtocol.fixture.requests.isEmpty)
    }

    @Test(arguments: ["scope", "token", "server"])
    func settingsIdentityChangesAndLateReadCannotPublishForReplacedPairing(changedPart: String) async throws {
        let original = modeCredential(scope: "owner-from-server")
        let replacement = modeCredential(scope: changedPart == "scope" ? "other-owner" : original.scopeKey,
            token: changedPart == "token" ? "other-token" : original.token,
            server: changedPart == "server" ? "https://other.invalid/companion" : original.baseURL.absoluteString)
        let store = ModelModeConnectionStore(original)
        ModelModeURLProtocol.fixture.reset { _ in
            try store.save(replacement)
            return (200, try JSONEncoder().encode(modeFixture()))
        }
        defer { ModelModeURLProtocol.fixture.reset() }
        let client = makeClient(store)
        let conversation = ShannonConversationModel(client: client, usesDisplayCache: false)
        let context = ShannonModelModeSettingsSection(conversation: conversation, connected: true).connectionContext
        let oldModel = context.makeModel(client: client)
        await oldModel.reload()
        #expect(oldModel.snapshot == nil && !oldModel.canChange)
        #expect(ModelModeURLProtocol.fixture.requests.count == 1)

        let nextClient = makeClient(store, baseURL: replacement.baseURL)
        let nextConversation = ShannonConversationModel(client: nextClient, usesDisplayCache: false)
        let nextContext = ShannonModelModeSettingsSection(conversation: nextConversation, connected: false).connectionContext
        #expect(nextContext != context && nextContext.scopeKey == replacement.scopeKey && nextContext.isPaired)
        let nextModel = nextContext.makeModel(client: nextClient)
        await nextModel.reload()
        #expect(nextModel.isFresh && nextModel.canChange)
        #expect(ModelModeURLProtocol.fixture.requests.map(\.httpMethod) == ["GET", "GET"])
    }

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

    @Test(arguments: [401, 403, 404, 503])
    func pairedSettingsRetainReadOnlyRecoveryAfterRejectedRead(status: Int) async throws {
        ModelModeURLProtocol.fixture.reset { _ in (status, Data(#"{"error":"synthetic-rejection"}"#.utf8)) }
        defer { ModelModeURLProtocol.fixture.reset() }
        let client = makeClient(ModelModeConnectionStore(modeCredential(scope: "owner-from-server")))
        let conversation = ShannonConversationModel(client: client, usesDisplayCache: false)
        let context = ShannonModelModeSettingsSection(conversation: conversation, connected: false).connectionContext
        let model = context.makeModel(client: client)
        await model.reload()
        #expect(context.isPaired && model.connectionIdentity != nil)
        #expect(model.snapshot == nil && !model.canChange)
        #expect(model.statusText != "シャノンに接続すると切り替えられます。")
        #expect(status == 404 ? model.isUnsupported : model.notice != nil)
        await model.select(.sonnet)
        #expect(ModelModeURLProtocol.fixture.requests.map(\.httpMethod) == ["GET"])

        ModelModeURLProtocol.fixture.reset { _ in (200, try JSONEncoder().encode(modeFixture())) }
        await model.reload()
        #expect(model.isFresh && model.canChange && !model.isUnsupported && model.notice == nil)
        #expect(ModelModeURLProtocol.fixture.requests.map(\.httpMethod) == ["GET"])
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

    private func makeClient(_ store: ModelModeConnectionStore, baseURL: URL = modeCredential().baseURL) -> ShannonAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ModelModeURLProtocol.self]
        return ShannonAPIClient(baseURL: baseURL, apiToken: "synthetic-local-token",
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
