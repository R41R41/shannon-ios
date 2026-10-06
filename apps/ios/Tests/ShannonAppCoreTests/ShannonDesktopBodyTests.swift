#if os(macOS)
import AppKit
import CoreGraphics
import XCTest
@testable import ShannonAppCore

/// Roadmap A17: her desktop body on the Mac. The rules that need no window or camera.
final class ShannonDesktopBodyTests: XCTestCase {
    private let visible = CGRect(x: 0, y: 25, width: 1_440, height: 875)

    // MARK: Her window's size and place

    func testHerWindowIsTheWindowsBodysSizeAndNeverLargerThanTheDisplay() {
        XCTAssertEqual(ShannonDesktopBodyGeometry.windowSize(scale: 1, visible: visible), CGSize(width: 400, height: 680))
        XCTAssertEqual(ShannonDesktopBodyGeometry.windowSize(scale: 0.5, visible: visible), CGSize(width: 300, height: 340))
        XCTAssertEqual(ShannonDesktopBodyGeometry.windowSize(scale: 3, visible: visible).height, 875)
        XCTAssertEqual(ShannonDesktopBodyGeometry.clampScale(9), 3)
        XCTAssertEqual(ShannonDesktopBodyGeometry.clampScale(.nan), 1)
        XCTAssertEqual(ShannonDesktopBodyGeometry.stageRect(in: CGSize(width: 400, height: 680), scale: 1), CGRect(x: 0, y: 0, width: 400, height: 520))
    }

    func testFirstPlaceIsTheLowerRightAndAStoredPlaceComesBackOnItsDisplay() {
        let first = ShannonDesktopBodyGeometry.frame(for: nil, visible: visible)
        XCTAssertEqual(first, CGRect(x: 1_016, y: 25, width: 400, height: 680))
        let moved = CGRect(x: 200, y: 125, width: 600, height: 875)
        let place = ShannonDesktopBodyGeometry.place(of: moved, scale: 1.5, visible: visible)
        XCTAssertEqual(place, ShannonDesktopBodyPlace(x: 200, y: 100, scale: 1.5))
        // The same display rearranged to the left of the main one keeps her place on it.
        let rearranged = visible.offsetBy(dx: -1_440, dy: 0)
        XCTAssertEqual(ShannonDesktopBodyGeometry.frame(for: place, visible: rearranged).origin, CGPoint(x: -1_240, y: 25))
        var places = ShannonDesktopBodyPlaces()
        places.byDisplay["A"] = place
        let defaults = UserDefaults(suiteName: "desktop-body-\(UUID().uuidString)")!
        places.save(defaults)
        XCTAssertEqual(ShannonDesktopBodyPlaces.load(defaults), places)
    }

    func testCarriedSheMayHangOverAnEdgeButSomeOfHerStaysOnADisplay() {
        let size = CGSize(width: 400, height: 680)
        XCTAssertEqual(ShannonDesktopBodyGeometry.carried(origin: CGPoint(x: 1_300, y: 25), size: size, displays: [visible]), CGPoint(x: 1_300, y: 25))
        let pulled = ShannonDesktopBodyGeometry.carried(origin: CGPoint(x: 3_000, y: 25), size: size, displays: [visible])
        XCTAssertEqual(pulled.x, 1_440 - 80)
        XCTAssertEqual(ShannonDesktopBodyGeometry.stepped(1, notches: 1), 1.06)
        XCTAssertEqual(ShannonDesktopBodyGeometry.stepped(1, notches: -100), ShannonDesktopBodyGeometry.clampScale(pow(1.06, -5)))
        XCTAssertEqual(ShannonDesktopBodyGeometry.nearestPreset(0.75), 0.75)
        XCTAssertNil(ShannonDesktopBodyGeometry.nearestPreset(0.8))
    }

    func testHerDesktopWindowShowsTheFigureAboveEveryPlaceInTheAppsWindows() {
        // A place that appears while she stands on the desktop goes below her: the last host shows the figure.
        XCTAssertEqual(ShannonLive2DStagePolicy.insertionIndex(for: .dialogue, among: [.desktop]), 0)
        XCTAssertEqual(ShannonLive2DStagePolicy.insertionIndex(for: .bodyScreen, among: [.voice, .desktop]), 1)
        XCTAssertEqual(ShannonLive2DStagePolicy.insertionIndex(for: .desktop, among: [.hero, .bodyScreen]), 2)
    }

    func testThePageDrawsOnlyWhileHerWindowCanBeSeen() {
        XCTAssertTrue(ShannonDesktopBody.windowSeen(shown: true, visible: true, locked: false, away: false))
        XCTAssertFalse(ShannonDesktopBody.windowSeen(shown: true, visible: false, locked: false, away: false))
        XCTAssertFalse(ShannonDesktopBody.windowSeen(shown: true, visible: true, locked: true, away: false))
        XCTAssertFalse(ShannonDesktopBody.windowSeen(shown: true, visible: true, locked: false, away: true))
        XCTAssertFalse(ShannonDesktopBody.windowSeen(shown: false, visible: true, locked: false, away: false))
        // While her window shows the figure, its being seen stands for the app being active.
        XCTAssertTrue(ShannonLive2DStagePolicy.paused(hasHost: true, appActive: false, resting: false))
    }

    // MARK: Carrying her

    func testAPressWhereSheIsNotPickedUpIsThePagesAtOnce() {
        var carry = ShannonDesktopBodyCarry()
        XCTAssertEqual(carry.down(at: .zero, mayCarry: false, origin: .zero, time: 0), [.deliverDown])
        XCTAssertEqual(carry.drag(to: CGPoint(x: 50, y: 0), time: 0.1), [.deliverDrag])
        XCTAssertEqual(carry.up(time: 1), [.deliverUp])
        XCTAssertFalse(carry.isPressed)
    }

    func testAClickElsewhereReachesThePageAsAClick() {
        var carry = ShannonDesktopBodyCarry()
        XCTAssertEqual(carry.down(at: .zero, mayCarry: true, origin: .zero, time: 0), [])
        XCTAssertEqual(carry.drag(to: CGPoint(x: 2, y: 1), time: 0.05), [])
        XCTAssertEqual(carry.up(time: 0.1), [.deliverDown, .deliverUp])
    }

    func testPullingHerByHerFaceOrFeetCarriesHerAndThePageNeverHearsOfIt() {
        var carry = ShannonDesktopBodyCarry()
        _ = carry.down(at: CGPoint(x: 100, y: 100), mayCarry: true, origin: CGPoint(x: 10, y: 20), time: 5)
        XCTAssertEqual(carry.drag(to: CGPoint(x: 110, y: 90), time: 5.1), [.beginCarry, .moveWindow(CGPoint(x: 20, y: 10))])
        XCTAssertTrue(carry.isCarrying)
        XCTAssertEqual(carry.drag(to: CGPoint(x: 300, y: 100), time: 6), [.moveWindow(CGPoint(x: 210, y: 20))])
        XCTAssertEqual(carry.up(time: 7.5), [.endCarry(durationMs: 2_500)])
    }

    func testAPressHeldStillIsThePagesForAHeldHand() {
        var carry = ShannonDesktopBodyCarry()
        _ = carry.down(at: .zero, mayCarry: true, origin: .zero, time: 0)
        XCTAssertEqual(carry.tick(time: 0.1), [])
        XCTAssertEqual(carry.tick(time: 0.3), [.deliverDown])
        XCTAssertEqual(carry.drag(to: CGPoint(x: 40, y: 0), time: 0.5), [.deliverDrag])
        XCTAssertEqual(carry.up(time: 2), [.deliverUp])
        // Moved only after the hold: still the page's.
        _ = carry.down(at: .zero, mayCarry: true, origin: .zero, time: 10)
        XCTAssertEqual(carry.drag(to: CGPoint(x: 1, y: 0), time: 10.4), [.deliverDown, .deliverDrag])
        XCTAssertEqual(carry.cancel(time: 11), [.deliverUp])
    }

    /// Owner decision 2026-10-06, the Windows rule: only her face or what has no named part (her boots) picks her up.
    func testOnlyHerFaceAndWhatHasNoNamedPartPickHerUp() {
        let carrying: Set<ShannonLive2DTouch.Part> = [.forehead, .cheek, .face, .other]
        for part in ShannonLive2DTouch.Part.allCases {
            XCTAssertEqual(ShannonDesktopBodyGrip.carries(part: part, region: nil), carrying.contains(part), part.rawValue)
            // A part decides, whatever region stands beside it.
            XCTAssertEqual(ShannonDesktopBodyGrip.carries(part: part, region: .face), carrying.contains(part), part.rawValue)
        }
        // Without a part: only the region `face`; with neither, she is not picked up.
        for region in ShannonLive2DTouch.Region.allCases {
            XCTAssertEqual(ShannonDesktopBodyGrip.carries(part: nil, region: region), region == .face, region.rawValue)
        }
        XCTAssertFalse(ShannonDesktopBodyGrip.carries(part: nil, region: nil))
    }

    /// Points where the bundled page names each part (measured with the page in headless Chrome, `full` fitted to the
    /// stage), in drawing heights: across from the middle, down from the top of the drawing.
    private static let measured: [(ShannonLive2DTouch.Part?, Double, Double)] = [
        (.head, 0, 0.10), (.head, 0, 0.15), (.hair, -0.05, 0.20), (.hair, 0.15, 0.30), (.neck, 0.005, 0.21),
        (.shoulder, -0.05, 0.25), (.chest, 0, 0.25), (.chest, 0, 0.30), (.arm, 0.10, 0.30), (.side, -0.05, 0.30),
        (.belly, 0, 0.35), (.skirt, 0, 0.40), (.skirt, 0.05, 0.45), (.hand, -0.15, 0.45), (.leg, -0.05, 0.50),
        (.leg, 0.05, 0.60), (nil, 0.40, 0.50),
    ]

    func testAPressPicksHerUpOnlyWhereThePageNamesHerFaceOrHerBoots() {
        for scale in [0.5, 1, 2] {
            let size = ShannonDesktopBodyGeometry.windowSize(scale: scale, visible: CGRect(x: 0, y: 0, width: 4000, height: 4000))
            let stage = ShannonDesktopBodyGeometry.stageRect(in: size, scale: scale)
            func point(_ u: Double, _ v: Double) -> CGPoint {
                let canvas = ShannonDesktopBodyGrip.canvas(stage.size)
                return CGPoint(x: stage.midX + u * canvas.height, y: stage.maxY - canvas.top - v * canvas.height)
            }
            // Every other part, and empty space beside her, is a touch.
            for (part, u, v) in Self.measured {
                XCTAssertFalse(ShannonDesktopBodyGrip.mayCarry(at: point(u, v), stage: stage, body: .human), "\(part?.rawValue ?? "nothing") at \(scale)")
            }
            // Her forehead and her boots pick her up.
            for (part, u, v) in [(ShannonLive2DTouch.Part.face, -0.004, 0.129), (.other, -0.04, 0.86), (.other, 0.06, 0.86), (.other, -0.02, 0.90)] {
                XCTAssertEqual(ShannonDesktopBodyGrip.part(at: point(u, v), stage: stage, body: .human), part, "\(part.rawValue) at \(scale)")
                XCTAssertTrue(ShannonDesktopBodyGrip.mayCarry(at: point(u, v), stage: stage, body: .human))
            }
            // Her eyes alone are her face wherever she is drawn; outside her stage nothing is.
            XCTAssertTrue(ShannonDesktopBodyGrip.mayCarry(at: CGPoint(x: stage.midX, y: stage.midY), stage: stage, body: .eyes))
            XCTAssertFalse(ShannonDesktopBodyGrip.mayCarry(at: CGPoint(x: stage.midX, y: stage.maxY + 10), stage: stage, body: .eyes))
            XCTAssertFalse(ShannonDesktopBodyGrip.mayCarry(at: CGPoint(x: stage.midX, y: stage.maxY + 10), stage: stage, body: .human))
        }
        // Every zone is a part that carries, inside her drawing.
        for zone in ShannonDesktopBodyGrip.zones {
            XCTAssertTrue(ShannonDesktopBodyGrip.carries(part: zone.part, region: nil))
            XCTAssertTrue(zone.box.minY >= 0 && zone.box.maxY <= 1 && abs(zone.box.midX) < 0.3)
        }
    }

    func testThePageDrawsHerAsTheGripReadsIt() {
        // `embed.js`, `wa` for `full` with `fit: contain`: in a 400 x 680 page the drawing is 664 high from 14 down.
        let canvas = ShannonDesktopBodyGrip.canvas(CGSize(width: 400, height: 680))
        XCTAssertEqual(canvas.height, 664)
        XCTAssertEqual(canvas.top, 14)
    }

    // MARK: Where she is drawn

    func testThePointerIsHersOnlyOverHerFigure() throws {
        let stage = CGRect(x: 0, y: 0, width: 40, height: 40)
        // A 4 × 4 picture with her in the second column, top row first.
        let alpha: [UInt8] = [0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0]
        let mask = try XCTUnwrap(ShannonDesktopBodyMask.read(alpha: alpha, columns: 4, rows: 4, stage: stage))
        XCTAssertTrue(mask.contains(CGPoint(x: 15, y: 35)))
        // One cell beside her still counts; two cells away does not.
        XCTAssertTrue(mask.contains(CGPoint(x: 25, y: 5)))
        XCTAssertFalse(mask.contains(CGPoint(x: 35, y: 5)))
        XCTAssertFalse(mask.contains(CGPoint(x: 15, y: 45)))
        XCTAssertEqual(mask.figureBox, CGRect(x: 10, y: 0, width: 10, height: 40))
    }

    func testAPictureThatDoesNotShowHerIsNotTrusted() {
        let stage = CGRect(x: 0, y: 0, width: 40, height: 40)
        XCTAssertNil(ShannonDesktopBodyMask.read(alpha: Array(repeating: 0, count: 16), columns: 4, rows: 4, stage: stage))
        XCTAssertNil(ShannonDesktopBodyMask.read(alpha: Array(repeating: 255, count: 16), columns: 4, rows: 4, stage: stage))
        XCTAssertNil(ShannonDesktopBodyMask.read(alpha: [255], columns: 4, rows: 4, stage: stage))
        let estimated = ShannonDesktopBodyMask.estimated(stage: CGRect(x: 0, y: 0, width: 400, height: 520))
        XCTAssertFalse(estimated.isRead)
        XCTAssertTrue(estimated.contains(CGPoint(x: 200, y: 260)))
        XCTAssertFalse(estimated.contains(CGPoint(x: 10, y: 260)))
    }

    // MARK: Who is at the Mac

    func testTenMinutesWithoutInputIsAwayAndInputAfterThatIsBack() {
        var away = ShannonDesktopBodyAway()
        let start = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertNil(away.observe(idleSeconds: 30, locked: false, now: start))
        XCTAssertTrue(away.isPresent)
        XCTAssertEqual(away.observe(idleSeconds: 600, locked: false, now: start.addingTimeInterval(570)), .away(minutes: 10))
        XCTAssertFalse(away.isPresent)
        XCTAssertNil(away.observe(idleSeconds: 2_400, locked: false, now: start.addingTimeInterval(2_370)))
        // He touched the Mac five seconds ago, 42 minutes after he last did.
        XCTAssertEqual(away.observe(idleSeconds: 5, locked: false, now: start.addingTimeInterval(2_515)), .returned(minutes: 42))
        XCTAssertTrue(away.isPresent)
    }

    func testALockedScreenIsAwayAtOnceAndBackOnlyOnceUnlocked() {
        var away = ShannonDesktopBodyAway()
        let now = Date(timeIntervalSince1970: 2_000_000)
        XCTAssertEqual(away.observe(idleSeconds: 3, locked: true, now: now), .away(minutes: 0))
        XCTAssertNil(away.observe(idleSeconds: 1, locked: true, now: now.addingTimeInterval(600)))
        XCTAssertEqual(away.observe(idleSeconds: 1, locked: false, now: now.addingTimeInterval(1_200)), .returned(minutes: 20))
    }

    // MARK: The lines of a moment

    func testLinesOfAMomentKeepTheirLimits() {
        var clock = ShannonDesktopBodyNudgeClock()
        let now = Date(timeIntervalSince1970: 3_000_000)
        XCTAssertTrue(clock.allows(now: now))
        clock.noteShown(scene: "longQuiet", at: now)
        clock.noteShown(scene: "awaitingReaction", at: now.addingTimeInterval(60))
        XCTAssertFalse(clock.allows(now: now.addingTimeInterval(120)))
        XCTAssertTrue(clock.allows(now: now.addingTimeInterval(3_601)))
        clock.noteConversation(at: now.addingTimeInterval(4_000))
        XCTAssertFalse(clock.allows(now: now.addingTimeInterval(4_000 + 14 * 60)))
        XCTAssertTrue(clock.allows(now: now.addingTimeInterval(4_000 + 15 * 60)))
    }

    func testTheMorningLineOnceADayAndTheLongQuietAfterTwoHoursBesideHer() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "Asia/Tokyo"))
        let morning = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 6, hour: 7)))
        var clock = ShannonDesktopBodyNudgeClock()
        XCTAssertNil(clock.dueScene(now: morning, present: false, calendar: calendar))
        XCTAssertEqual(clock.dueScene(now: morning, present: true, calendar: calendar), "morning")
        // Not said (she was speaking): tried again after ten minutes.
        XCTAssertNil(clock.dueScene(now: morning.addingTimeInterval(300), present: true, calendar: calendar))
        XCTAssertEqual(clock.dueScene(now: morning.addingTimeInterval(600), present: true, calendar: calendar), "morning")
        clock.noteShown(scene: "morning", at: morning.addingTimeInterval(600), calendar: calendar)
        XCTAssertNil(clock.dueScene(now: morning.addingTimeInterval(1_800), present: true, calendar: calendar))
        let noon = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 6, hour: 13)))
        var quiet = ShannonDesktopBodyNudgeClock()
        XCTAssertNil(quiet.dueScene(now: noon, present: true, calendar: calendar))
        XCTAssertNil(quiet.dueScene(now: noon.addingTimeInterval(7_000), present: true, calendar: calendar))
        XCTAssertEqual(quiet.dueScene(now: noon.addingTimeInterval(7_200), present: true, calendar: calendar), "longQuiet")
        XCTAssertNil(quiet.dueScene(now: noon.addingTimeInterval(7_260), present: true, calendar: calendar))
    }

    // MARK: Her own messages

    func testWhatTheBodyDoesWithHerMessage() {
        let now = Date(timeIntervalSince1970: 4_000_000)
        func plan(speaks: Bool = true, shown: Bool = true, away: Bool = false, age: TimeInterval = 10, taken: Bool = false) -> ShannonDesktopBodyReachOut.Plan {
            ShannonDesktopBodyReachOut.plan(speaks: speaks, windowShown: shown, ownerAway: away, createdAt: now.addingTimeInterval(-age), now: now, soundTaken: taken)
        }
        XCTAssertEqual(plan(), .speak)
        XCTAssertEqual(plan(speaks: false), .notShown("muted"))
        XCTAssertEqual(plan(shown: false), .notShown("hidden"))
        XCTAssertEqual(plan(away: true), .notShown("away"))
        XCTAssertEqual(plan(taken: true), .showSilently)
        XCTAssertEqual(plan(age: 6 * 60), .showSilently)
        XCTAssertEqual(plan(age: 2 * 60 * 60), .skip)
        XCTAssertEqual(ShannonDesktopBodyReachOut.outcome(heard: true), "shown_spoken")
        XCTAssertEqual(ShannonDesktopBodyReachOut.outcome(heard: false), "shown")
    }

    func testHerTouchLineIsNeverSpokenNorAnsweredWhileTheOwnerIsInACallElsewhere() {
        func answers(shown: Bool = true, mode: ShannonBodyReplyMode = .voice, reports: Bool = true,
                     audience: ShannonBodyAudience = .owner, elsewhere: Bool = false) -> Bool {
            ShannonDesktopBody.answersTouchInVoice(shown: shown, replyMode: mode, reportsTouch: reports, audience: audience, ownerInCallElsewhere: elsewhere)
        }
        XCTAssertTrue(answers())
        XCTAssertFalse(answers(elsewhere: true))
        XCTAssertFalse(answers(shown: false))
        XCTAssertFalse(answers(mode: .text))
        XCTAssertFalse(answers(reports: false))
        XCTAssertFalse(answers(audience: .others))
    }

    // MARK: One look at the room

    func testTheCameraOpensOnlyWithEveryConditionAndSaysWhyNotInTheContractsWords() {
        func refusal(allowed: Bool = true, shown: Bool = true, others: Bool = false, camera: Bool = true,
                     permission: ShannonMediaPermission = .granted, taken: Int = 0) -> String? {
            ShannonDesktopBodyLookRules.refusal(cameraAllowed: allowed, windowShown: shown, othersPresent: others, hasCamera: camera,
                                                permission: permission, takenInLastHour: taken)
        }
        XCTAssertNil(refusal())
        XCTAssertEqual(refusal(allowed: false, shown: false, others: true), "camera_off")
        XCTAssertEqual(refusal(shown: false, others: true), "window_hidden")
        XCTAssertEqual(refusal(others: true), "others_present")
        XCTAssertEqual(refusal(camera: false), "no_camera")
        XCTAssertEqual(refusal(permission: .undetermined), "denied")
        XCTAssertEqual(refusal(taken: 6), "rate_limited")
        XCTAssertTrue(ShannonDesktopBodyLookRules.registersCamera(cameraAllowed: true, permission: .granted, hasCamera: true))
        XCTAssertFalse(ShannonDesktopBodyLookRules.registersCamera(cameraAllowed: true, permission: .denied, hasCamera: true))
        XCTAssertFalse(ShannonDesktopBodyLookRules.registersCamera(cameraAllowed: false, permission: .granted, hasCamera: true))
    }

    func testTheCameraStateAtHerFeet() {
        XCTAssertEqual(ShannonDesktopBodyCameraState.make(cameraAllowed: false, permission: .granted, hasCamera: true, othersPresent: false, isCapturing: false), .off)
        XCTAssertEqual(ShannonDesktopBodyCameraState.make(cameraAllowed: true, permission: .granted, hasCamera: true, othersPresent: false, isCapturing: false), .allowed)
        XCTAssertEqual(ShannonDesktopBodyCameraState.make(cameraAllowed: true, permission: .undetermined, hasCamera: true, othersPresent: false, isCapturing: false), .off)
        XCTAssertEqual(ShannonDesktopBodyCameraState.make(cameraAllowed: true, permission: .granted, hasCamera: true, othersPresent: true, isCapturing: false), .off)
        XCTAssertEqual(ShannonDesktopBodyCameraState.make(cameraAllowed: true, permission: .granted, hasCamera: true, othersPresent: false, isCapturing: true), .looking)
    }

    // MARK: The wire

    func testPresenceDecodesTheSnapshotAndTheShortAnswer() throws {
        let full = try JSONDecoder().decode(ShannonDesktopBodyPresenceDTO.self, from: Data("""
        {"schemaVersion":1,"etag":"3f9a1c0b7d2e4a68","changedAt":"2026-10-06T03:00:00.000Z","pollAfterSeconds":5,
         "mood":{"expression":"joyful","primary":"happy","intensity":0.6,"fromConversation":true,"valence":0.42,"arousal":0.5,"openness":0.61},
         "doing":"drafting","autonomy":{"state":"active"},"study":{"awaitingReaction":1},"capabilities":null,
         "look":{"id":"0b6c","requestedAt":"2026-10-06T03:00:00.000Z","expiresAt":"2026-10-06T03:00:30.000Z"},
         "reachOut":{"pending":1,"latestId":"0b6f"},"ownerCallElsewhere":{"active":true,"since":"2026-10-06T02:59:00.000Z","surface":"mac"}}
        """.utf8))
        XCTAssertEqual(full.look?.id, "0b6c")
        XCTAssertEqual(full.reachOut?.latestId, "0b6f")
        XCTAssertEqual(full.ownerCallElsewhere?.surface, "mac")
        XCTAssertEqual(full.mood?.valence, 0.42)
        let short = try JSONDecoder().decode(ShannonDesktopBodyPresenceDTO.self, from: Data("""
        {"schemaVersion":1,"etag":"3f9a1c0b7d2e4a68","changedAt":"2026-10-06T03:00:00.000Z","pollAfterSeconds":10,"unchanged":true}
        """.utf8))
        XCTAssertEqual(short.unchanged, true)
        XCTAssertNil(short.look)
    }

    func testEventsAndLookAnswersCarryOnlyTheirOwnFields() throws {
        let away = ShannonDesktopBodyEventDTO(id: "ownerAway-1", type: "ownerAway", audience: .owner, occurredAt: "2026-10-06T03:00:00.000Z", minutesAway: 10)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(away)) as? [String: Any]
        XCTAssertEqual(Set(encoded?.keys ?? [:].keys), ["id", "type", "audience", "occurredAt", "minutesAway"])
        let refused = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ShannonBodyLookAnswerDTO.refused(scopeKey: "owner", code: "camera_off"))) as? [String: Any]
        XCTAssertEqual(Set(refused?.keys ?? [:].keys), ["scopeKey", "outcome", "code"])
        let frame = ShannonAppLookFrame(jpeg: Data([0xFF, 0xD8]), width: 960, height: 540)
        let seen = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ShannonBodyLookAnswerDTO.seen(scopeKey: "owner", frame: frame))) as? [String: Any]
        XCTAssertEqual(Set(seen?.keys ?? [:].keys), ["scopeKey", "outcome", "audience", "image"])
        XCTAssertEqual(seen?["audience"] as? String, "owner")
    }

    func testEveryRequestOfTheBodySpeaksForItsOwnDevice() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DesktopBodyURLProtocol.self]
        DesktopBodyURLProtocol.reset()
        defer { DesktopBodyURLProtocol.reset() }
        let api = ShannonAPIClient(baseURL: URL(string: "https://example.test")!, apiToken: "token-for-tests", session: URLSession(configuration: configuration))
        let client = ShannonDesktopBodyClient(api: api, camera: { true })
        let (_, heard) = try await client.bodyPresence(scopeKey: "owner", etag: nil, audience: nil)
        XCTAssertTrue(heard)
        DesktopBodyURLProtocol.echoes = false
        let (_, unheard) = try await client.bodyPresence(scopeKey: "owner", etag: "3f9a1c0b7d2e4a68", audience: .others)
        XCTAssertFalse(unheard)
        try await client.registerTouchBody(scopeKey: "owner", expressions: ["joyful"], gestures: ["wave"])
        XCTAssertEqual(DesktopBodyURLProtocol.headers, Array(repeating: "desktop", count: 3))
        XCTAssertEqual(DesktopBodyURLProtocol.seen, [
            "GET /v1/body/presence?scopeKey=owner",
            "GET /v1/body/presence?scopeKey=owner&etag=3f9a1c0b7d2e4a68&audience=others",
            "PUT /v1/body/capabilities",
        ])
        // The touch coordinator's registration is her full body with the camera as the owner set it, not touch-only.
        let flags = DesktopBodyURLProtocol.bodies.last?["flags"] as? [String: Bool]
        XCTAssertEqual(flags, ["camera": true])
        XCTAssertEqual(DesktopBodyURLProtocol.bodies.last?["surface"] as? String, "mac")
    }
}

private final class DesktopBodyURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var seen: [String] = []
    nonisolated(unsafe) static var headers: [String] = []
    nonisolated(unsafe) static var bodies: [[String: Any]] = []
    nonisolated(unsafe) static var echoes = true

    static func reset() {
        seen = []
        headers = []
        bodies = []
        echoes = true
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        Self.seen.append("\(request.httpMethod ?? "") \(url.path)\(url.query.map { "?\($0)" } ?? "")")
        Self.headers.append(request.value(forHTTPHeaderField: "X-Shannon-Body") ?? "")
        if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4_096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { Self.bodies.append(json) }
        }
        let body = url.path == "/v1/body/presence"
            ? #"{"schemaVersion":1,"etag":"3f9a1c0b7d2e4a68","changedAt":"2026-10-06T03:00:00.000Z","pollAfterSeconds":10}"#
            : #"{"schemaVersion":1,"updatedAt":"2026-10-06T03:00:00.000Z"}"#
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: Self.echoes ? ["X-Shannon-Body": "desktop"] : [:])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
#endif
