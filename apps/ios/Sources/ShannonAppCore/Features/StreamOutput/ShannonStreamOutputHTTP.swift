import Foundation

/// The stream output's tiny HTTP (roadmap A18 S5, `desktop.stream-output`): what a request may ask and what it is
/// answered. Pure, so that every rule is tested without a socket. The server (`ShannonStreamOutputServer`) only reads
/// bytes, asks here, and writes what it is told.
///
/// The rules: loopback only (the server also drops a peer that is not), `GET` only, a `Host` that names this Mac's
/// loopback at the stream's port (a page of another site that renamed itself to 127.0.0.1 through DNS is refused), no
/// `Origin` but our own, and only the files the stream page needs plus its event stream. Nothing else is served.
enum ShannonStreamOutputHTTP {
    /// A request head larger than this is refused: nothing the page sends comes near it.
    static let maximumHeadBytes = 8 * 1024
    /// At most this many pages may watch at once (OBS has one or two sources).
    static let maximumViewers = 8

    struct Request: Equatable, Sendable {
        let method: String
        /// The path without its query.
        let path: String
        /// Header names in lower case; the first value of each.
        let headers: [String: String]
    }

    enum Route: Equatable, Sendable {
        case file(ShannonStreamOutputFiles.Entry)
        case events
        case refused(status: Int)
    }

    /// A complete request head (ending in an empty line), or nil while it is incomplete. A malformed head is answered
    /// `.malformed`.
    enum Parsed: Equatable, Sendable {
        case incomplete
        case malformed
        case request(Request)
    }

    static func parse(_ data: Data) -> Parsed {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else {
            return data.count > maximumHeadBytes ? .malformed : .incomplete
        }
        guard end.lowerBound <= maximumHeadBytes,
              let head = String(data: data[data.startIndex..<end.lowerBound], encoding: .utf8) else { return .malformed }
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: false)
        guard requestLine.count == 3, requestLine[2].hasPrefix("HTTP/1."), requestLine[1].hasPrefix("/") else { return .malformed }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { return .malformed }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            guard !name.isEmpty, !name.contains(" ") else { return .malformed }
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if headers[name] == nil { headers[name] = value }
        }
        let target = String(requestLine[1])
        let path = String(target.prefix { $0 != "?" && $0 != "#" })
        return .request(Request(method: String(requestLine[0]), path: path, headers: headers))
    }

    /// The names this Mac's loopback goes by at the stream's port.
    static func allowedHosts(port: UInt16) -> Set<String> {
        ["127.0.0.1:\(port)", "localhost:\(port)"]
    }

    static func route(_ request: Request, port: UInt16, files: ShannonStreamOutputFiles) -> Route {
        // A page of another site that resolved its own name to 127.0.0.1 still says its own name here.
        guard let host = request.headers["host"]?.lowercased(), allowedHosts(port: port).contains(host) else {
            return .refused(status: 403)
        }
        // Our page sends no Origin for its own reads; another page's reads say where they come from.
        if let origin = request.headers["origin"]?.lowercased(), !allowedHosts(port: port).contains(where: { origin == "http://\($0)" }) {
            return .refused(status: 403)
        }
        guard request.method == "GET" else { return .refused(status: 405) }
        if request.path == ShannonStreamOutputFiles.eventsPath { return .events }
        guard let entry = files.entries[request.path] else { return .refused(status: 404) }
        return .file(entry)
    }

    // MARK: Answers

    static let reasons: [Int: String] = [
        200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 503: "Service Unavailable",
    ]

    /// Headers every answer carries: nothing is cached, nothing is sniffed, nothing is sent on as a referrer.
    private static let common = [
        "Cache-Control: no-store",
        "X-Content-Type-Options: nosniff",
        "Referrer-Policy: no-referrer",
    ]

    /// The stream page's own policy: its scripts and styles from here (the Cubism Core needs WebAssembly), its model's
    /// pictures as blobs, and no connection anywhere but here.
    static let contentSecurityPolicy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
        + "img-src 'self' blob: data:; connect-src 'self' blob: data:; worker-src 'self' blob:; base-uri 'none'; form-action 'none'"

    static func head(status: Int, contentType: String?, contentLength: Int?, extra: [String] = []) -> Data {
        var lines = ["HTTP/1.1 \(status) \(reasons[status] ?? "Error")"]
        if let contentType { lines.append("Content-Type: \(contentType)") }
        if let contentLength { lines.append("Content-Length: \(contentLength)") }
        lines += common + extra
        return Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    }

    /// A refusal: a status and nothing else.
    static func refusal(status: Int) -> Data {
        head(status: status, contentType: nil, contentLength: 0, extra: ["Connection: close"])
    }

    static func fileHead(_ entry: ShannonStreamOutputFiles.Entry, length: Int) -> Data {
        var extra = ["Connection: close"]
        if entry.contentType.hasPrefix("text/html") { extra.append("Content-Security-Policy: \(contentSecurityPolicy)") }
        return head(status: 200, contentType: entry.contentType, contentLength: length, extra: extra)
    }

    /// The event stream's head: chunked, so that every event is one chunk and the page sees it at once.
    static func eventsHead() -> Data {
        head(status: 200, contentType: "text/event-stream; charset=utf-8", contentLength: nil,
             extra: ["Transfer-Encoding: chunked", "Connection: keep-alive"])
    }

    /// One chunk of a chunked body.
    static func chunk(_ data: Data) -> Data {
        guard !data.isEmpty else { return Data() }
        return Data((String(data.count, radix: 16) + "\r\n").utf8) + data + Data("\r\n".utf8)
    }

    /// The end of a chunked body.
    static let lastChunk = Data("0\r\n\r\n".utf8)

    // MARK: Server-sent events

    /// How soon the page tries again after the stream ended (the app quit, the output was turned off).
    static let retryMilliseconds = 1000

    static var opening: Data { Data("retry: \(retryMilliseconds)\n\n".utf8) }

    /// A comment line every few seconds, so that a page that went away is noticed by a failed write.
    static var keepAlive: Data { Data(": keep-alive\n\n".utf8) }

    /// One event: one `data:` line of JSON. A payload with a line break (which JSON never needs) is not sent, because it
    /// would end the event early.
    static func event(_ payload: String) -> Data? {
        guard !payload.isEmpty, !payload.contains("\n"), !payload.contains("\r") else { return nil }
        return Data("data: \(payload)\n\n".utf8)
    }
}

/// The only files the stream output serves: its own page and script, and the four files of the bundled body page
/// (`docs/live2d-embed.md`) that page loads. All of them are served from the root, so that the body page finds its
/// model by the same relative paths as in `embed.html`.
struct ShannonStreamOutputFiles: Equatable, Sendable {
    struct Entry: Equatable, Sendable {
        let url: URL
        let contentType: String
    }

    static let pagePath = "/stream.html"
    static let eventsPath = "/events"

    /// Published path → (folder, file, type). `embed.html` itself is not served: the stream page stands in its place.
    static let layout: [(path: String, inEmbed: Bool, file: String, type: String)] = [
        (pagePath, false, "stream.html", "text/html; charset=utf-8"),
        ("/stream.js", false, "stream.js", "text/javascript; charset=utf-8"),
        ("/embed.css", true, "embed.css", "text/css; charset=utf-8"),
        ("/assets.js", true, "assets.js", "text/javascript; charset=utf-8"),
        ("/live2d/live2dcubismcore.min.js", true, "live2d/live2dcubismcore.min.js", "text/javascript; charset=utf-8"),
        ("/live2d/live2d.js", true, "live2d/live2d.js", "text/javascript; charset=utf-8"),
        ("/embed.js", true, "embed.js", "text/javascript; charset=utf-8"),
    ]

    let entries: [String: Entry]

    init(entries: [String: Entry]) {
        self.entries = entries
    }

    /// The files from the bundle's `Live2D/embed` and `Live2D/stream` folders; nil when either is missing.
    init?(embed: URL, stream: URL) {
        var entries: [String: Entry] = [:]
        for item in Self.layout {
            let url = (item.inEmbed ? embed : stream).appendingPathComponent(item.file)
            guard FileManager.default.fileExists(atPath: url.path) else { return nil }
            entries[item.path] = Entry(url: url, contentType: item.type)
        }
        self.entries = entries
    }

    /// The bundled page's folders.
    @MainActor static var bundled: ShannonStreamOutputFiles? {
        guard let embed = ShannonLive2DStage.embedFolder else { return nil }
        return ShannonStreamOutputFiles(embed: embed, stream: embed.deletingLastPathComponent().appendingPathComponent("stream", isDirectory: true))
    }
}
