import Foundation

enum ShannonObserverValue: Encodable, Sendable, Equatable {
    case text(String), count(Int), flag(Bool)
    func encode(to encoder: any Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case let .text(text): try value.encode(text)
        case let .count(count): try value.encode(count)
        case let .flag(flag): try value.encode(flag)
        }
    }
}

struct ShannonClientObserverEvent: Encodable, Sendable {
    let runId: UUID
    let spanId: UUID
    var parentSpanId: UUID? = nil
    let node: String
    let kind: String
    var at: String = Date().formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    var input: [String: ShannonObserverValue]? = nil
    var output: [String: ShannonObserverValue]? = nil
    var fromNode: String? = nil
    var toNode: String? = nil
    var sourceSpanId: UUID? = nil
}

enum ShannonObserverCorrelation {
    @TaskLocal static var runID: UUID?
}

extension ShannonAPIClient {
    /// One attempt through the paired device connection; telemetry never throws into the call.
    func sendObserverEvents(_ events: [ShannonClientObserverEvent], droppedEvents: Int) async -> Bool {
        guard !events.isEmpty || droppedEvents > 0, events.count <= 16, let connection = currentConnection() else { return false }
        struct Body: Encodable { let events: [ShannonClientObserverEvent]; let droppedEvents: Int }
        guard let body = try? JSONEncoder().encode(Body(events: events, droppedEvents: min(4_096, max(0, droppedEvents)))), body.count <= 32 * 1_024 else { return false }
        var request = URLRequest(url: baseURL.appending(path: "/v1/observer/client-events"))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        authorize(&request, connection: connection)
        request.httpBody = body
        guard let (_, response) = try? await session.data(for: request) else { return false }
        // The route's held response is 200; only 202 acknowledges accepting the observation.
        return (response as? HTTPURLResponse)?.statusCode == 202
    }
}
