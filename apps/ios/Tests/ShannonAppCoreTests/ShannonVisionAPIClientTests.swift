import Foundation
import XCTest
@testable import ShannonAppCore

/// `/v1/vision/*` as the app sends it: the JPEG as the body with its description in one header, the presence report, and
/// what each answer means for watching (429 waits, 502/503/no answer stops).
final class ShannonVisionAPIClientTests: XCTestCase {
    override func tearDown() {
        VisionURLProtocol.fixture.reset()
        super.tearDown()
    }

    private func client() -> ShannonAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VisionURLProtocol.self]
        return ShannonAPIClient(baseURL: URL(string: "https://shannon.invalid/companion")!, apiToken: "synthetic-local-token",
            session: URLSession(configuration: configuration))
    }

    private let frame = ShannonVisionFrame(
        frameId: "frame-1", capturedAt: "2026-10-14T09:00:00.000Z", source: .init(kind: .appCamera, bodyId: nil, deviceId: "device-1"),
        sessionId: "watch-1", generation: 2, privacy: .ownerPrivate, audienceAtCapture: .ownerAlone, ttlMs: 4000,
        encoding: .init(width: 512, height: 384, format: .jpeg, byteLength: 4), gate: .init(reason: .difference, difference: 0.2, personCount: 1))
    private let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0])
    private let replyJSON = #"""
    {"schema":"vision.frame.reply.v1","frameId":"frame-1","watch":"continue","stopReason":null,"outcome":"chosen",
     "candidateId":"react:curious","reaction":null,"degrade":0,"nextFrameNotBefore":"2026-10-14T09:00:02.000Z"}
    """#

    func testAFrameIsTheJPEGBodyWithItsDescriptionInTheHeader() async throws {
        let replyJSON = replyJSON
        VisionURLProtocol.fixture.reset { _ in (200, Data(replyJSON.utf8), [:]) }
        let result = await client().sendVisionFrame(frame, jpeg: jpeg)
        guard case let .reply(reply) = result else { return XCTFail("a reply: \(result)") }
        XCTAssertEqual(reply.reactionToShow, .curious)
        let request = try XCTUnwrap(VisionURLProtocol.fixture.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/companion/v1/vision/frames")
        XCTAssertEqual(request.value(forHTTPHeaderField: "content-type"), "image/jpeg")
        XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer synthetic-local-token")
        XCTAssertEqual(VisionURLProtocol.fixture.bodies.first, jpeg)
        let header = try XCTUnwrap(request.value(forHTTPHeaderField: "x-shannon-vision-frame"))
        let decoded = try JSONDecoder().decode(ShannonVisionFrame.self, from: Data(header.utf8))
        XCTAssertEqual(decoded, frame)
        XCTAssertTrue(header.contains(#""receivedAt":null"#))
        XCTAssertTrue(header.contains(#""state":null"#))
    }

    func testTooSoonWaitsForTheTimeTheServerNamesOrTwoSeconds() async {
        VisionURLProtocol.fixture.reset { _ in (429, Data(#"{"error":"VISION_TOO_SOON","nextFrameNotBefore":"2026-10-14T09:00:05.000Z"}"#.utf8), [:]) }
        let named = await client().sendVisionFrame(frame, jpeg: jpeg)
        XCTAssertEqual(named, .notNow(until: ShannonVisionWire.date("2026-10-14T09:00:05.000Z")!))

        let sentAt = Date(timeIntervalSince1970: 1_800_000_000)
        let bare = ShannonAPIClient.frameResult(status: 429, data: Data(), retryAfter: nil, sentAt: sentAt)
        XCTAssertEqual(bare, .notNow(until: sentAt.addingTimeInterval(2)))
        let retry = ShannonAPIClient.frameResult(status: 429, data: Data(), retryAfter: "7", sentAt: sentAt)
        XCTAssertEqual(retry, .notNow(until: sentAt.addingTimeInterval(7)))
    }

    func testAWorkerThatIsDownOrSilentMeansStop() async {
        for status in [502, 503, 504] {
            VisionURLProtocol.fixture.reset { _ in (status, Data(), [:]) }
            let result = await client().sendVisionFrame(frame, jpeg: jpeg)
            XCTAssertEqual(result, .workerDown, "\(status)")
        }
        VisionURLProtocol.fixture.reset { _ in throw URLError(.notConnectedToInternet) }
        let silent = await client().sendVisionFrame(frame, jpeg: jpeg)
        XCTAssertEqual(silent, .workerDown)
        VisionURLProtocol.fixture.reset { _ in (404, Data(), [:]) }
        let missing = await client().sendVisionFrame(frame, jpeg: jpeg)
        XCTAssertEqual(missing, .rejected(status: 404))
    }

    func testStatusAndPresence() async throws {
        let status = #"""
        {"schema":"vision.status.v1","watchAllowed":true,"reason":null,"degrade":1,
         "limits":{"judgeFramesPerSecond":2,"sendIntervalMs":2000,"longSide":512,"frameBytes":160000,"ttlMs":4000}}
        """#
        VisionURLProtocol.fixture.reset { request in
            request.url?.path.hasSuffix("/status") == true ? (200, Data(status.utf8), [:]) : (204, Data(), [:])
        }
        let read = try await client().visionStatus()
        XCTAssertTrue(read.watchAllowed)
        XCTAssertEqual(read.degrade, 1)
        try await client().reportVisionPresence(personCount: 3, at: Date(timeIntervalSince1970: 1_800_000_000))
        let requests = VisionURLProtocol.fixture.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["GET", "POST"])
        XCTAssertEqual(requests.map { $0.url?.path }, ["/companion/v1/vision/status", "/companion/v1/vision/presence"])
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(VisionURLProtocol.fixture.bodies.last)) as? [String: Any])
        XCTAssertEqual(body["personCount"] as? Int, 3)
        XCTAssertEqual(body["at"] as? String, "2027-01-15T08:00:00.000Z")
        XCTAssertEqual(Set(body.keys), ["personCount", "at"])
    }
}

private final class VisionURLProtocol: URLProtocol, @unchecked Sendable {
    static let fixture = VisionHTTPFixture()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data, headers) = try Self.fixture.reply(request)
            guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: headers.merging(["content-type": "application/json"]) { first, _ in first }) else {
                throw ShannonAPIError.invalidResponse
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private final class VisionHTTPFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var handler: (@Sendable (URLRequest) throws -> (Int, Data, [String: String]))?
    private var seen: [URLRequest] = []
    private var sentBodies: [Data] = []
    var requests: [URLRequest] { lock.withLock { seen } }
    var bodies: [Data] { lock.withLock { sentBodies } }

    func reset(_ handler: (@Sendable (URLRequest) throws -> (Int, Data, [String: String]))? = nil) {
        lock.withLock {
            self.handler = handler
            seen = []
            sentBodies = []
        }
    }

    func reply(_ request: URLRequest) throws -> (Int, Data, [String: String]) {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                body.append(contentsOf: buffer.prefix(count))
            }
        }
        let callback = lock.withLock {
            seen.append(request)
            sentBodies.append(body)
            return handler
        }
        guard let callback else { throw ShannonAPIError.invalidResponse }
        return try callback(request)
    }
}
