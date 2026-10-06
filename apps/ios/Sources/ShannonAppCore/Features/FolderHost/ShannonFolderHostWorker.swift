#if os(macOS)
import Foundation

/// The part of the Mac app that touches her folder (A18 S2 reads, S3 changes). It is handed a folder and a step and returns
/// a report; it never sees the device token, the server, or the network (`ShannonFolderHostClaimClient` does that), so
/// whatever a step asks, the most it can do is read and change text inside the fence of `ShannonFolderHostRoot`, with every
/// overwrite and delete going to the trash first (`ShannonFolderHostWrites`).
public actor ShannonFolderHostWorker {
    private var folder: URL?
    private let now: @Sendable () -> Date

    public init(now: @escaping @Sendable () -> Date = Date.init) {
        self.now = now
    }

    /// The folder the owner chose; nil while none is, or while the chosen one cannot be opened (a bookmark that failed):
    /// every step is then refused with `folder_not_configured`.
    public func setFolder(_ folder: URL?) {
        self.folder = folder
    }

    /// Carries out one step. `stopped`: the owner's stop switch on this Mac, read as the step arrives.
    public func perform(_ step: ShannonFolderHostStep, stopped: Bool) -> ShannonFolderHostReport {
        if stopped { return .refused(.init(.stoppedLocally)) }
        guard ShannonFolderHostWire.operations.contains(step.operation) else { return .refused(.init(.unsupportedOperation)) }
        guard let folder else { return .refused(.init(.folderNotConfigured)) }
        do {
            let root = try ShannonFolderHostRoot(folder: folder)
            switch step.operation {
            case "list":
                return .done(.list(try ShannonFolderHostOperations.list(
                    root, relativePath: step.relativePath ?? "", recursive: step.recursive ?? false, limit: step.limit ?? ShannonFolderHostLimits.listEntries)))
            case "read":
                guard let path = step.relativePath else { return .refused(.init(.pathNotAllowed)) }
                return .done(.read(try ShannonFolderHostOperations.read(
                    root, relativePath: path, offset: step.offset ?? 0, maxBytes: step.maxBytes ?? ShannonFolderHostLimits.readBytes)))
            case "search":
                guard let query = step.query, !query.isEmpty, query.count <= 100 else { return .refused(.init(.pathNotAllowed)) }
                return .done(.search(try ShannonFolderHostOperations.search(
                    root, query: query, relativePath: step.relativePath ?? "", limit: step.limit ?? 20, now: now)))
            case "create":
                guard let path = step.relativePath else { return .refused(.init(.pathNotAllowed)) }
                return .done(.write(try ShannonFolderHostWrites.create(
                    root, relativePath: path, content: step.content, contentSha256: step.contentSha256, bytes: step.bytes)))
            case "update":
                guard let path = step.relativePath else { return .refused(.init(.pathNotAllowed)) }
                return .done(.write(try ShannonFolderHostWrites.update(
                    root, relativePath: path, content: step.content, contentSha256: step.contentSha256, bytes: step.bytes,
                    expectedSha256: step.expectedSha256, now: now())))
            case "move":
                guard let path = step.relativePath else { return .refused(.init(.pathNotAllowed)) }
                return .done(.write(try ShannonFolderHostWrites.move(root, relativePath: path, toRelativePath: step.toRelativePath)))
            case "delete":
                guard let path = step.relativePath else { return .refused(.init(.pathNotAllowed)) }
                return .done(.write(try ShannonFolderHostWrites.delete(root, relativePath: path, now: now())))
            default:
                return .refused(.init(.unsupportedOperation))
            }
        } catch {
            return .refused(error)
        }
    }
}

/// The network side: the binding, the long-poll claim and the report, with the paired device's token (`ShannonAPIClient`).
/// It hands the worker a step and takes back a report; it never opens a file.
public protocol ShannonFolderHostTransport: Sendable {
    func binding() async throws -> ShannonFolderHostBinding
    func claim(_ request: ShannonFolderHostClaimRequest) async throws -> ShannonFolderHostStep?
    func report(id: String, _ report: ShannonFolderHostReport) async throws
}

public enum ShannonFolderHostTransportError: Error, Equatable, Sendable {
    /// This Mac is not paired (no device token) or its pairing was revoked.
    case notPaired
    /// `403 HOST_NOT_BOUND`: this Mac is not registered for the host.
    case notBound
    case rejected(status: Int)
}

public struct ShannonFolderHostClaimClient: ShannonFolderHostTransport {
    let api: ShannonAPIClient
    private let session: URLSession

    public init(api: ShannonAPIClient, session: URLSession? = nil) {
        self.api = api
        // A claim is held open up to 25 seconds; the request waits a little longer than that.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 40
        configuration.waitsForConnectivity = false
        self.session = session ?? URLSession(configuration: configuration)
    }

    /// The paired device's id (not its token), to show the owner what to register.
    public var deviceID: String? { api.currentConnection()?.deviceID }

    public func binding() async throws -> ShannonFolderHostBinding {
        let connection = try paired()
        var components = URLComponents(url: api.baseURL.appending(path: "/v1/autonomy/host-steps/binding"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "scopeKey", value: connection.scopeKey)]
        guard let url = components?.url else { throw ShannonAPIError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        api.authorize(&request, connection: connection)
        return try JSONDecoder().decode(ShannonFolderHostBinding.self, from: try await send(request))
    }

    public func claim(_ claim: ShannonFolderHostClaimRequest) async throws -> ShannonFolderHostStep? {
        let connection = try paired()
        var scoped = claim
        scoped.scopeKey = connection.scopeKey
        var request = post("/v1/autonomy/host-steps/claim", connection: connection)
        request.timeoutInterval = TimeInterval(claim.waitSeconds + 15)
        request.httpBody = try JSONEncoder().encode(scoped)
        return try JSONDecoder().decode(ShannonFolderHostClaimResponse.self, from: try await send(request)).step
    }

    public func report(id: String, _ report: ShannonFolderHostReport) async throws {
        let connection = try paired()
        guard id.range(of: "^[0-9a-f-]{36}$", options: .regularExpression) != nil else { throw ShannonAPIError.invalidResponse }
        var request = post("/v1/autonomy/host-steps/\(id)/report", connection: connection)
        request.httpBody = try report.body(scopeKey: connection.scopeKey)
        _ = try await send(request)
    }

    private func paired() throws -> ShannonConnectionCredential {
        guard let connection = api.currentConnection() else { throw ShannonFolderHostTransportError.notPaired }
        return connection
    }

    private func post(_ path: String, connection: ShannonConnectionCredential) -> URLRequest {
        var request = URLRequest(url: api.baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        api.authorize(&request, connection: connection)
        return request
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShannonAPIError.invalidResponse }
        switch http.statusCode {
        case 200..<300: return data
        case 401: throw ShannonFolderHostTransportError.notPaired
        case 403: throw ShannonFolderHostTransportError.notBound
        default: throw ShannonFolderHostTransportError.rejected(status: http.statusCode)
        }
    }
}
#endif
