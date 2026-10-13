import Foundation

/// The limits the device keeps while it watches (Syzygy ADR-0011 §4.4, initial values). The server's own limits
/// (`vision.status.v1`) can only make them stricter.
public struct ShannonCameraWatchLimits: Equatable, Sendable {
    /// At most this many frames a second are judged on the device; the rest are dropped unread.
    public var judgeInterval: TimeInterval = 0.5
    /// At most one frame to the worker per this interval.
    public var sendInterval: TimeInterval = 2
    /// The long side of a frame sent.
    public var longSide = 512
    public var frameBytes = 160_000
    public var ttlMs = 4_000

    public init() {}

    /// These limits, made no looser by what the server says.
    public func tightened(by server: ShannonVisionStatus.Limits) -> ShannonCameraWatchLimits {
        var limits = self
        if server.judgeFramesPerSecond > 0 { limits.judgeInterval = max(judgeInterval, 1 / server.judgeFramesPerSecond) }
        limits.sendInterval = max(sendInterval, Double(server.sendIntervalMs) / 1_000)
        if server.longSide > 0 { limits.longSide = min(longSide, server.longSide) }
        if server.frameBytes > 0 { limits.frameBytes = min(frameBytes, server.frameBytes) }
        if server.ttlMs > 0 { limits.ttlMs = min(ttlMs, server.ttlMs) }
        return limits
    }
}

/// The edge gate on the device, in memory only: which camera frames are judged, and which judged frame is sent.
/// It holds the 32 × 32 brightness of the last judged frame and the times it needs; never a picture.
public struct ShannonCameraWatchGate: Sendable {
    /// The mean brightness change (0–1) a judged frame must reach to be sent. Conservative to start with (§11 item 8).
    public static let differenceThreshold = 0.12
    /// The first frames after the camera opens are dark or unfocused: none is judged before this.
    public static let warmUpSeconds: TimeInterval = 1
    /// From this many people on, the camera stops (§4.4: watching is for the owner alone).
    public static let othersFromPersonCount = 2
    /// A frame whose people could not be counted is never sent; this many such frames in a row close the camera.
    public static let detectionFailuresToStop = 3

    public enum Decision: Equatable, Sendable {
        /// Nothing changed enough, or a frame may not be sent now.
        case skip
        case send(reason: ShannonVisionGateReason, difference: Double?)
        /// Two or more people: the camera stops and presence is reported.
        case stopForOthers(personCount: Int)
        /// The people could not be counted several times in a row: the camera stops (unsure is not alone).
        case stopUncounted
    }

    public var limits: ShannonCameraWatchLimits
    private var startedAt: Date?
    private var lastJudgedAt: Date?
    private var lastSentAt: Date?
    private var notBefore: Date?
    private var reference: [UInt8]?
    private var firstFramePending = true
    private var uncounted = 0
    public private(set) var inFlight = false

    public init(limits: ShannonCameraWatchLimits = ShannonCameraWatchLimits()) {
        self.limits = limits
    }

    /// The camera (re)opened: the next judged frame is a first frame again.
    public mutating func restart(at now: Date) {
        startedAt = now
        lastJudgedAt = nil
        reference = nil
        firstFramePending = true
        uncounted = 0
        inFlight = false
    }

    /// Whether this camera frame is judged at all (at most `1 / judgeInterval` a second). A frame that is not is dropped unread.
    public mutating func shouldJudge(at now: Date) -> Bool {
        if let startedAt, now.timeIntervalSince(startedAt) < Self.warmUpSeconds { return false }
        if let lastJudgedAt, now.timeIntervalSince(lastJudgedAt) < limits.judgeInterval { return false }
        lastJudgedAt = now
        return true
    }

    /// Decides about one judged frame from its 32 × 32 brightness and the number of people Apple Vision found in it.
    /// A frame whose people could not be counted (`personCount == nil`) fails closed: it is never sent.
    public mutating func decide(luma: [UInt8], personCount: Int?, at now: Date) -> Decision {
        guard let personCount else {
            uncounted += 1
            return uncounted >= Self.detectionFailuresToStop ? .stopUncounted : .skip
        }
        uncounted = 0
        if personCount >= Self.othersFromPersonCount {
            reference = nil
            return .stopForOthers(personCount: personCount)
        }
        let difference = reference.map { ShannonCameraWatchFrameMath.meanAbsoluteDifference($0, luma) }
        reference = luma
        if firstFramePending {
            guard maySend(at: now) else { return .skip }
            firstFramePending = false
            markSent(at: now)
            return .send(reason: .firstFrame, difference: nil)
        }
        guard let difference, difference >= Self.differenceThreshold, maySend(at: now) else { return .skip }
        markSent(at: now)
        return .send(reason: .difference, difference: difference)
    }

    /// A sent frame was answered (or failed, or was never sent): the next may go, but not before `notBefore`.
    public mutating func settle(notBefore: Date?) {
        inFlight = false
        if let notBefore { self.notBefore = max(self.notBefore ?? notBefore, notBefore) }
    }

    private func maySend(at now: Date) -> Bool {
        if inFlight { return false }
        if let lastSentAt, now.timeIntervalSince(lastSentAt) < limits.sendInterval { return false }
        if let notBefore, now < notBefore { return false }
        return true
    }

    private mutating func markSent(at now: Date) {
        inFlight = true
        lastSentAt = now
    }
}

/// The cheap arithmetic of the gate. Works on bytes in memory and keeps nothing.
public enum ShannonCameraWatchFrameMath {
    /// The side of the brightness grid a frame is reduced to.
    public static let side = 32

    /// Mean absolute difference of two brightness grids, in [0, 1]. Grids of different sizes count as fully different.
    public static func meanAbsoluteDifference(_ a: [UInt8], _ b: [UInt8]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 1 }
        var total = 0
        for index in a.indices { total += abs(Int(a[index]) - Int(b[index])) }
        return Double(total) / Double(a.count * 255)
    }

    /// The brightness of a BGRA frame on a `side × side` grid: each cell is the mean of a few samples inside it
    /// (Rec. 601 weights). Reads the bytes in place; allocates only the grid.
    public static func luma(bgra: UnsafeRawBufferPointer, width: Int, height: Int, bytesPerRow: Int, side: Int = side) -> [UInt8] {
        guard width > 0, height > 0, side > 0, bytesPerRow >= width * 4, bgra.count >= bytesPerRow * height else {
            return [UInt8](repeating: 0, count: side * side)
        }
        let samples = 3
        var grid = [UInt8](repeating: 0, count: side * side)
        for row in 0..<side {
            for column in 0..<side {
                var sum = 0
                for sy in 0..<samples {
                    let y = min(height - 1, (row * samples + sy) * height / (side * samples) + height / (side * samples * 2))
                    for sx in 0..<samples {
                        let x = min(width - 1, (column * samples + sx) * width / (side * samples) + width / (side * samples * 2))
                        let offset = y * bytesPerRow + x * 4
                        let blue = Int(bgra[offset]), green = Int(bgra[offset + 1]), red = Int(bgra[offset + 2])
                        sum += (299 * red + 587 * green + 114 * blue) / 1_000
                    }
                }
                grid[row * side + column] = UInt8(clamping: sum / (samples * samples))
            }
        }
        return grid
    }
}
