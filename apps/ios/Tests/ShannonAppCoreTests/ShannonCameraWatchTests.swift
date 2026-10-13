import CoreGraphics
import Foundation
import ImageIO
import XCTest
@testable import ShannonAppCore

/// Watching while the app is open (Syzygy ADR-0011 §4.4): the rule, the edge gate and its limits, the frame sent,
/// and what the coordinator does with each answer. No camera, system or network is used.
@MainActor
final class ShannonCameraWatchTests: XCTestCase {
    // MARK: The rule: every condition alone closes the camera

    func testEveryConditionHoldsTheCameraOnItsOwn() {
        let allowed = ShannonCameraWatchConditions()
        XCTAssertEqual(ShannonCameraWatchPolicy.verdict(allowed), .watch)
        let cases: [(String, (inout ShannonCameraWatchConditions) -> Void, ShannonCameraWatchHold)] = [
            ("not connected or a preview", { $0.canSend = false }, .notConnected),
            ("no surface shows the sign", { $0.hasSign = false }, .noSign),
            ("background / window hidden", { $0.appInFront = false }, .background),
            ("locked", { $0.unlocked = false }, .locked),
            ("setting off", { $0.settingOn = false }, .switchedOff),
            ("stopped from the sign", { $0.stoppedByOwner = true }, .stoppedByOwner),
            ("no camera", { $0.hasCamera = false }, .noCamera),
            ("permission not given yet", { $0.permission = .undetermined }, .noPermission),
            ("permission denied", { $0.permission = .denied }, .noPermission),
            ("Low Power Mode", { $0.lowPowerMode = true }, .lowPower),
            ("thermal", { $0.thermalHeavy = true }, .hot),
            ("others may be listening", { $0.othersPresent = true }, .othersPresent),
            ("two people seen", { $0.othersSeen = true }, .othersSeen),
            ("a one-shot look holds the camera", { $0.lookInProgress = true }, .lookInProgress),
            ("camera taken away", { $0.cameraBusy = true }, .cameraBusy),
            ("server: audience", { $0.server = .refused(.audience) }, .server(.audience)),
            ("server: budget", { $0.server = .refused(.budget) }, .server(.budget)),
            ("server: degraded", { $0.server = .refused(.degraded) }, .server(.degraded)),
            ("server: disabled", { $0.server = .refused(.disabled) }, .server(.disabled)),
            ("worker down", { $0.server = .unreachable }, .serverUnreachable),
            ("no vision route", { $0.server = .unsupported }, .unsupported),
        ]
        for (label, change, hold) in cases {
            var facts = allowed
            change(&facts)
            XCTAssertEqual(ShannonCameraWatchPolicy.verdict(facts), .hold(hold), label)
        }
        // The server is asked only once everything on the device allows it.
        var unknown = allowed
        unknown.server = .unknown
        XCTAssertEqual(ShannonCameraWatchPolicy.verdict(unknown), .askServer)
        unknown.appInFront = false
        XCTAssertEqual(ShannonCameraWatchPolicy.verdict(unknown), .hold(.background))
    }

    func testTheServerAllowsOnlyWithoutStopAndBelowDegradeTwo() {
        let limits = ShannonVisionStatus.Limits(judgeFramesPerSecond: 2, sendIntervalMs: 2000, longSide: 512, frameBytes: 160_000, ttlMs: 4000)
        XCTAssertEqual(ShannonCameraWatchPolicy.serverVerdict(.init(watchAllowed: true, reason: nil, degrade: 0, limits: limits)), .allowed)
        XCTAssertEqual(ShannonCameraWatchPolicy.serverVerdict(.init(watchAllowed: true, reason: nil, degrade: 1, limits: limits)), .allowed)
        XCTAssertEqual(ShannonCameraWatchPolicy.serverVerdict(.init(watchAllowed: true, reason: nil, degrade: 2, limits: limits)), .refused(.degraded))
        XCTAssertEqual(ShannonCameraWatchPolicy.serverVerdict(.init(watchAllowed: false, reason: .audience, degrade: 0, limits: limits)),
            .refused(.audience))
        XCTAssertEqual(ShannonCameraWatchPolicy.serverVerdict(.init(watchAllowed: false, reason: nil, degrade: 0, limits: limits)), .refused(.disabled))
    }

    func testTheSwitchIsOnUntilTheOwnerTurnsItOff() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "camera-watch-\(UUID().uuidString)"))
        XCTAssertTrue(ShannonCameraWatchPreference.isEnabled(defaults: defaults))
        defaults.set(false, forKey: ShannonCameraWatchPreference.enabledDefaultsKey)
        XCTAssertFalse(ShannonCameraWatchPreference.isEnabled(defaults: defaults))
        XCTAssertEqual(ShannonCameraWatchPreference.enabledDefaultsKey, "shannon.camera-watch.enabled")
        XCTAssertEqual(ShannonCameraWatchCopy.toggleTitle, "アプリを開いている間は見る")
    }

    // MARK: The edge gate

    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private func at(_ seconds: Double) -> Date { start.addingTimeInterval(seconds) }
    private func grid(_ value: UInt8) -> [UInt8] { [UInt8](repeating: value, count: 32 * 32) }

    func testAtMostTwoFramesASecondAreJudgedAndNoneWhileTheCameraWarmsUp() {
        var gate = ShannonCameraWatchGate()
        gate.restart(at: start)
        XCTAssertFalse(gate.shouldJudge(at: at(0.2)), "warm-up")
        var judged = 0
        // Thirty frames a second for three seconds after the warm-up.
        for frame in 0..<90 where gate.shouldJudge(at: at(1 + Double(frame) / 30)) { judged += 1 }
        XCTAssertEqual(judged, 6)
    }

    func testTheFirstFrameIsSentThenOnlyAChangeAtMostEveryTwoSecondsOneInFlight() {
        var gate = ShannonCameraWatchGate()
        gate.restart(at: start)
        XCTAssertEqual(gate.decide(luma: grid(100), personCount: 1, at: at(1)), .send(reason: .firstFrame, difference: nil))
        XCTAssertTrue(gate.inFlight)
        // A big change while the first is in flight is not sent.
        XCTAssertEqual(gate.decide(luma: grid(200), personCount: 1, at: at(3.5)), .skip)
        gate.settle(notBefore: nil)
        // No change: nothing.
        XCTAssertEqual(gate.decide(luma: grid(200), personCount: 1, at: at(4)), .skip)
        // A change below the threshold: nothing.
        XCTAssertEqual(gate.decide(luma: grid(220), personCount: 1, at: at(4.5)), .skip)
        // A change at the threshold or more: sent, with the difference.
        guard case let .send(reason, difference) = gate.decide(luma: grid(80), personCount: 0, at: at(5)) else {
            return XCTFail("a big change is sent")
        }
        XCTAssertEqual(reason, .difference)
        XCTAssertEqual(difference ?? 0, 140.0 / 255, accuracy: 0.0001)
        gate.settle(notBefore: nil)
        // Answered at once, but two seconds have not passed since the last frame was sent.
        XCTAssertEqual(gate.decide(luma: grid(250), personCount: 0, at: at(6)), .skip)
        guard case .send = gate.decide(luma: grid(10), personCount: 0, at: at(7)) else { return XCTFail("after two seconds") }
    }

    func testTheServersNotBeforeIsKept() {
        var gate = ShannonCameraWatchGate()
        gate.restart(at: start)
        _ = gate.decide(luma: grid(0), personCount: 1, at: at(1))
        gate.settle(notBefore: at(10))
        XCTAssertEqual(gate.decide(luma: grid(255), personCount: 1, at: at(5)), .skip)
        guard case .send = gate.decide(luma: grid(0), personCount: 1, at: at(10)) else { return XCTFail("after notBefore") }
    }

    func testTwoOrMorePeopleStopWatching() {
        var gate = ShannonCameraWatchGate()
        gate.restart(at: start)
        XCTAssertEqual(gate.decide(luma: grid(0), personCount: 2, at: at(1)), .stopForOthers(personCount: 2))
        XCTAssertEqual(gate.decide(luma: grid(0), personCount: 3, at: at(2)), .stopForOthers(personCount: 3))
        // One person, or none, is the owner alone.
        guard case .send = gate.decide(luma: grid(0), personCount: 1, at: at(3)) else { return XCTFail("one person") }
    }

    func testAFrameWhosePeopleCouldNotBeCountedIsNeverSentAndRepeatedFailuresStop() {
        var gate = ShannonCameraWatchGate()
        gate.restart(at: start)
        // Fail closed: an uncounted first frame is not sent, nor is a changed one.
        XCTAssertEqual(gate.decide(luma: grid(0), personCount: nil, at: at(1)), .skip)
        XCTAssertEqual(gate.decide(luma: grid(255), personCount: nil, at: at(1.5)), .skip)
        XCTAssertEqual(gate.decide(luma: grid(0), personCount: nil, at: at(2)), .stopUncounted)
        // A counted frame in between resets the run.
        var other = ShannonCameraWatchGate()
        other.restart(at: start)
        XCTAssertEqual(other.decide(luma: grid(0), personCount: nil, at: at(1)), .skip)
        XCTAssertEqual(other.decide(luma: grid(0), personCount: nil, at: at(1.5)), .skip)
        guard case .send = other.decide(luma: grid(0), personCount: 1, at: at(2)) else { return XCTFail("counted frame") }
        other.settle(notBefore: nil)
        XCTAssertEqual(other.decide(luma: grid(0), personCount: nil, at: at(2.5)), .skip)
        XCTAssertEqual(other.decide(luma: grid(0), personCount: nil, at: at(3)), .skip)
    }

    func testARestartMakesTheNextFrameAFirstFrameAgain() {
        var gate = ShannonCameraWatchGate()
        gate.restart(at: start)
        _ = gate.decide(luma: grid(0), personCount: 1, at: at(1))
        gate.settle(notBefore: nil)
        gate.restart(at: at(5))
        XCTAssertEqual(gate.decide(luma: grid(0), personCount: 1, at: at(6.5)), .send(reason: .firstFrame, difference: nil))
    }

    func testTheServerCanOnlyTightenTheLimits() {
        let looser = ShannonVisionStatus.Limits(judgeFramesPerSecond: 10, sendIntervalMs: 500, longSide: 1024, frameBytes: 900_000, ttlMs: 60_000)
        XCTAssertEqual(ShannonCameraWatchLimits().tightened(by: looser), ShannonCameraWatchLimits())
        let stricter = ShannonVisionStatus.Limits(judgeFramesPerSecond: 1, sendIntervalMs: 5000, longSide: 384, frameBytes: 50_000, ttlMs: 2000)
        let limits = ShannonCameraWatchLimits().tightened(by: stricter)
        XCTAssertEqual(limits.judgeInterval, 1)
        XCTAssertEqual(limits.sendInterval, 5)
        XCTAssertEqual(limits.longSide, 384)
        XCTAssertEqual(limits.frameBytes, 50_000)
        XCTAssertEqual(limits.ttlMs, 2000)
    }

    func testBrightnessIsAveragedOnAThirtyTwoGridAndCompared() {
        let width = 640, height = 480, bytesPerRow = width * 4
        var bytes = [UInt8](repeating: 0, count: bytesPerRow * height)
        // The right half white.
        for y in 0..<height { for x in (width / 2)..<width { for channel in 0..<3 { bytes[y * bytesPerRow + x * 4 + channel] = 255 } } }
        let luma = bytes.withUnsafeBytes {
            ShannonCameraWatchFrameMath.luma(bgra: $0, width: width, height: height, bytesPerRow: bytesPerRow)
        }
        XCTAssertEqual(luma.count, 32 * 32)
        XCTAssertEqual(luma[0], 0)
        XCTAssertEqual(luma[31], 255)
        XCTAssertEqual(ShannonCameraWatchFrameMath.meanAbsoluteDifference(luma, luma), 0)
        XCTAssertEqual(ShannonCameraWatchFrameMath.meanAbsoluteDifference(grid(0), grid(255)), 1)
        XCTAssertEqual(ShannonCameraWatchFrameMath.meanAbsoluteDifference(luma, grid(0)), 0.5, accuracy: 0.01)
        XCTAssertEqual(ShannonCameraWatchFrameMath.meanAbsoluteDifference([1, 2], grid(0)), 1, "sizes differ")
    }

    // MARK: The frame sent

    func testASentFrameHasALongSideOfAtMost512AndNoMetadata() throws {
        for (width, height) in [(1280, 720), (480, 640), (4000, 3000), (300, 200)] {
            let image = try XCTUnwrap(Self.image(width: width, height: height))
            let frame = try XCTUnwrap(ShannonAppLookEncoder.frame(from: image, maximumSide: 512, maximumBytes: 160_000))
            XCTAssertLessThanOrEqual(max(frame.width, frame.height), 512)
            XCTAssertLessThanOrEqual(frame.jpeg.count, 160_000)
            XCTAssertEqual(Array(frame.jpeg.prefix(3)), [0xFF, 0xD8, 0xFF], "a JPEG")
            let source = try XCTUnwrap(CGImageSourceCreateWithData(frame.jpeg as CFData, nil))
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
            XCTAssertEqual(properties[kCGImagePropertyPixelWidth] as? Int, frame.width)
            XCTAssertNil(properties[kCGImagePropertyGPSDictionary])
        }
        // The one-shot look keeps its own bound.
        let large = try XCTUnwrap(Self.image(width: 1280, height: 720))
        XCTAssertEqual(ShannonAppLookEncoder.frame(from: large)?.width, 960)
    }

    func testTheFrameRecordDescribesTheShotForTheOwnerAlone() {
        let shot = ShannonCameraWatchShot(frame: .init(jpeg: Data([0xFF, 0xD8, 0xFF, 0x00]), width: 512, height: 384), capturedAt: start,
            reason: .difference, difference: 0.123456, personCount: 1)
        let frame = ShannonCameraWatchCoordinator.frame(shot, sessionId: "watch-a", generation: 3, deviceId: "device-1", ttlMs: 4000)
        XCTAssertEqual(frame.source, ShannonVisionSource(kind: .appCamera, bodyId: nil, deviceId: "device-1"))
        XCTAssertEqual(frame.privacy, .ownerPrivate)
        XCTAssertEqual(frame.audienceAtCapture, .ownerAlone)
        XCTAssertEqual(frame.ttlMs, 4000)
        XCTAssertEqual(frame.sessionId, "watch-a")
        XCTAssertEqual(frame.generation, 3)
        XCTAssertNil(frame.receivedAt)
        XCTAssertEqual(frame.encoding, ShannonVisionEncoding(width: 512, height: 384, format: .jpeg, byteLength: 4))
        XCTAssertEqual(frame.gate, ShannonVisionGate(reason: .difference, difference: 0.123, personCount: 1))
        XCTAssertEqual(ShannonVisionWire.date(frame.capturedAt), start)
        XCTAssertNil(ShannonCameraWatchCoordinator.frame(shot, sessionId: "s", generation: 1, deviceId: "bad id/", ttlMs: 4000).source.deviceId)
    }

    static func image(width: Int, height: Int) -> CGImage? {
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(CGColor(red: 0.9, green: 0.3, blue: 0.1, alpha: 1))
        context.fill(CGRect(x: width / 4, y: height / 4, width: width / 2, height: height / 2))
        return context.makeImage()
    }
}
