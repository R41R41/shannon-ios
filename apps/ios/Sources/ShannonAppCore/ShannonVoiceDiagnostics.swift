import Foundation
import OSLog

public struct ShannonVoiceDiagnosticEvent: Codable, Equatable, Sendable {
    public let timestamp: Date
    public let sessionID: String?
    public let step: String
    public let metadata: [String: String]
}

/// A small, privacy-bounded breadcrumb log for crashes that occur inside
/// AVFoundation before Swift can surface an Error. Each event is flushed to
/// disk immediately so the last completed audio setup step survives a crash.
public final class ShannonVoiceDiagnostics: @unchecked Sendable {
    public static let shared = ShannonVoiceDiagnostics()

    private static let sensitiveMetadataTerms = [
        "text", "transcript", "message", "token", "secret", "credential", "url", "content",
    ]

    private let fileURL: URL
    private let maximumBytes: Int
    private let lock = NSLock()
    private let logger = Logger(subsystem: "com.r41r41.shannon", category: "VoiceDiagnostics")
    private let encoder: JSONEncoder
    private let decoder = JSONDecoder()

    public convenience init() {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        self.init(fileURL: root.appendingPathComponent("Shannon/voice-diagnostics.jsonl"))
    }

    init(fileURL: URL, maximumBytes: Int = 128 * 1_024) {
        self.fileURL = fileURL
        self.maximumBytes = max(4_096, maximumBytes)
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
    }

    public func record(
        _ step: String,
        sessionID: String? = nil,
        metadata: [String: String] = [:]
    ) {
        let safeStep = bounded(step, maximumLength: 96)
        let safeSessionID = sessionID.map { bounded($0, maximumLength: 64) }
        let safeMetadata = sanitize(metadata)
        let event = ShannonVoiceDiagnosticEvent(
            timestamp: Date(),
            sessionID: safeSessionID,
            step: safeStep,
            metadata: safeMetadata
        )

        lock.lock()
        defer { lock.unlock() }

        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try rotateIfNeeded()
            var data = try encoder.encode(event)
            data.append(0x0A)
            if !FileManager.default.fileExists(atPath: fileURL.path) {
                FileManager.default.createFile(atPath: fileURL.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: fileURL)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
            try handle.synchronize()
            logger.notice("Voice checkpoint: \(safeStep, privacy: .public)")
        } catch {
            logger.error("Unable to persist voice checkpoint: \(String(describing: error), privacy: .public)")
        }
    }

    public func report() -> String {
        lock.lock()
        defer { lock.unlock() }

        let events = readEvents()
        let bundle = Bundle.main
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        var lines = [
            "Shannon voice diagnostics",
            "app=\(version) build=\(build)",
            "os=\(os)",
            "events=\(events.count)",
            "privacy=no audio, transcript, message, token, or credential is recorded",
            "",
        ]

        let formatter = ISO8601DateFormatter()
        for event in events {
            var line = "\(formatter.string(from: event.timestamp)) \(event.step)"
            if let sessionID = event.sessionID { line += " session=\(sessionID)" }
            if !event.metadata.isEmpty {
                let values = event.metadata.keys.sorted().map { "\($0)=\(event.metadata[$0] ?? "")" }
                line += " " + values.joined(separator: " ")
            }
            lines.append(line)
        }
        return lines.joined(separator: "\n")
    }

    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        try? FileManager.default.removeItem(at: fileURL)
    }

    private func sanitize(_ metadata: [String: String]) -> [String: String] {
        var result: [String: String] = [:]
        for (key, value) in metadata.prefix(16) {
            let safeKey = bounded(key, maximumLength: 48)
            let lowercaseKey = safeKey.lowercased()
            if Self.sensitiveMetadataTerms.contains(where: lowercaseKey.contains) {
                result[safeKey] = "<redacted>"
            } else {
                result[safeKey] = bounded(value, maximumLength: 120)
            }
        }
        return result
    }

    private func bounded(_ value: String, maximumLength: Int) -> String {
        String(value.prefix(maximumLength))
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
    }

    private func readEvents() -> [ShannonVoiceDiagnosticEvent] {
        guard let data = try? Data(contentsOf: fileURL), !data.isEmpty else { return [] }
        return data.split(separator: 0x0A).compactMap { line in
            try? decoder.decode(ShannonVoiceDiagnosticEvent.self, from: Data(line))
        }
    }

    private func rotateIfNeeded() throws {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
              let size = attributes[.size] as? NSNumber,
              size.intValue >= maximumBytes,
              let data = try? Data(contentsOf: fileURL)
        else { return }

        let lines = data.split(separator: 0x0A)
        let retained = lines.suffix(max(20, lines.count / 2))
        var compacted = Data()
        for line in retained {
            compacted.append(contentsOf: line)
            compacted.append(0x0A)
        }
        try compacted.write(to: fileURL, options: .atomic)
    }
}
