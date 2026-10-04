import CoreGraphics
import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonAppLookTests: XCTestCase {
    // MARK: What a turn says about the camera

    func testAvailabilityIsDecidedBySwitchThenScreenThenHardwareThenPermission() {
        let both: [ShannonAppLookCamera] = [.back, .front]
        typealias State = ShannonAppLookClientStateDTO.State
        func state(_ enabled: Bool, _ foreground: Bool, _ permission: ShannonMediaPermission, _ cameras: [ShannonAppLookCamera]) -> State {
            ShannonAppLookAvailability.state(enabled: enabled, foreground: foreground, permission: permission, cameras: cameras)
        }
        XCTAssertEqual(state(true, true, .granted, both), .ready)
        XCTAssertEqual(state(true, true, .undetermined, both), .undetermined)
        XCTAssertEqual(state(true, true, .denied, both), .denied)
        XCTAssertEqual(state(true, true, .granted, []), .noCamera)
        XCTAssertEqual(state(true, false, .granted, both), .background)
        // The owner's switch is said first, whatever else is true.
        XCTAssertEqual(state(false, false, .denied, []), .switchedOff)
        XCTAssertEqual(state(false, true, .granted, both), .switchedOff)

        XCTAssertNil(ShannonAppLookAvailability.refusal(.ready))
        XCTAssertNil(ShannonAppLookAvailability.refusal(.undetermined))
        XCTAssertEqual(ShannonAppLookAvailability.refusal(.background), .background)
        XCTAssertEqual(ShannonAppLookAvailability.refusal(.denied), .denied)
        XCTAssertEqual(ShannonAppLookAvailability.refusal(.noCamera), .noCamera)
        XCTAssertEqual(ShannonAppLookAvailability.refusal(.switchedOff), .switchedOff)
    }

    func testTheSwitchIsOnUntilTheOwnerTurnsItOff() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "app-look-\(UUID().uuidString)"))
        XCTAssertTrue(ShannonAppLookPreference.isEnabled(defaults: defaults))
        defaults.set(false, forKey: ShannonAppLookPreference.enabledDefaultsKey)
        XCTAssertFalse(ShannonAppLookPreference.isEnabled(defaults: defaults))
        XCTAssertEqual(ShannonAppLookPreference.enabledDefaultsKey, "shannon.app-look.enabled")
    }

    func testRequestsCarryTheCameraStateAndNothingElseNew() throws {
        let state = ShannonAppLookClientStateDTO(state: .noCamera, cameras: [], platform: "ios")
        var chat = ChatRequestDTO(scopeKey: "owner", message: "これ見れる？")
        XCTAssertNil(try json(chat)["appLook"])
        chat.appLook = ShannonAppLookClientStateDTO(state: .ready, cameras: [.back, .front], platform: "ios")
        let look = try XCTUnwrap(try json(chat)["appLook"] as? [String: Any])
        XCTAssertEqual(look["state"] as? String, "ready")
        XCTAssertEqual(look["cameras"] as? [String], ["back", "front"])
        XCTAssertEqual(look["platform"] as? String, "ios")
        XCTAssertEqual(Set(look.keys), ["state", "cameras", "platform"])
        XCTAssertEqual(try json(state)["state"] as? String, "no_camera")
        XCTAssertEqual(try json(ShannonAppLookClientStateDTO(state: .switchedOff, cameras: [.front], platform: "macos"))["state"] as? String, "switched_off")

        let context = ShannonVoiceDeviceContextDTO(timeZoneIdentifier: "Asia/Tokyo", requestedLocation: false, location: nil)
        XCTAssertNil(try json(context)["appLook"])
        XCTAssertNil(try json(context.withAppLook(nil))["appLook"])
        XCTAssertEqual((try json(context.withAppLook(state))["appLook"] as? [String: Any])?["state"] as? String, "no_camera")
    }

    func testResponsesCarryTheAskAndOlderResponsesHaveNone() throws {
        let ask = #"{"id":"0b6c1f0e-5a47","camera":"front","expiresAt":"2026-10-02T09:00:30.000Z"}"#
        let voice = try JSONDecoder().decode(ShannonLiveVoiceDelegationResponseDTO.self,
            from: Data(#"{"threadId":"t","model":"m","reply":"見てみますね。","appLook":\#(ask)}"#.utf8))
        XCTAssertEqual(voice.appLook, ShannonAppLookAskDTO(id: "0b6c1f0e-5a47", camera: .front, expiresAt: "2026-10-02T09:00:30.000Z"))
        let plain = try JSONDecoder().decode(ShannonLiveVoiceDelegationResponseDTO.self,
            from: Data(#"{"threadId":"t","model":"m","reply":"はい。"}"#.utf8))
        XCTAssertNil(plain.appLook)

        var chat = Fixtures.chatResponse()
        XCTAssertNil(try JSONDecoder().decode(ChatResponseDTO.self, from: JSONEncoder().encode(chat)).appLook)
        chat.appLook = ShannonAppLookAskDTO(id: "a", camera: .back, expiresAt: "2026-10-02T09:00:30Z")
        XCTAssertEqual(try JSONDecoder().decode(ChatResponseDTO.self, from: JSONEncoder().encode(chat)).appLook?.camera, .back)

        let answered = try JSONDecoder().decode(ShannonAppLookAnswerResponseDTO.self, from: Data(
            #"{"schemaVersion":1,"id":"a","status":"seen","message":{"id":"m1","threadId":"t","text":"ラーメンですね。"}}"#.utf8))
        XCTAssertEqual(answered.message?.text, "ラーメンですね。")
        let silent = try JSONDecoder().decode(ShannonAppLookAnswerResponseDTO.self, from: Data(
            #"{"schemaVersion":1,"id":"a","status":"refused","message":null}"#.utf8))
        XCTAssertNil(silent.message)
    }

    func testAnAskIsOpenUntilItsExpiry() {
        let ask = ShannonAppLookAskDTO(id: "a", camera: .back, expiresAt: "2026-10-02T09:00:30.000Z")
        let expiry = ISO8601DateFormatter().date(from: "2026-10-02T09:00:30Z")!
        XCTAssertTrue(ask.isOpen(at: expiry.addingTimeInterval(-0.1)))
        XCTAssertFalse(ask.isOpen(at: expiry))
        XCTAssertTrue(ShannonAppLookAskDTO(id: "a", camera: .back, expiresAt: "2026-10-02T09:00:30Z").isOpen(at: expiry.addingTimeInterval(-1)))
        // An ask whose time cannot be read is never answered with a frame.
        XCTAssertFalse(ShannonAppLookAskDTO(id: "a", camera: .back, expiresAt: "soon").isOpen(at: expiry.addingTimeInterval(-60)))
    }

    func testTheDeadlineIsCountedFromArrivalWhenTheServerSendsALifetime() throws {
        let arrived = Date(timeIntervalSince1970: 1_000)
        var ask = ShannonAppLookAskDTO(id: "a", camera: .back, expiresAt: "2026-10-02T09:00:30.000Z")
        // An older server: the absolute time is all there is.
        XCTAssertEqual(ask.deadline(receivedAt: arrived), ISO8601DateFormatter().date(from: "2026-10-02T09:00:30Z"))
        ask.lifetimeSeconds = 30
        // Two seconds are left for the upload, whatever this device's clock says.
        XCTAssertEqual(ask.deadline(receivedAt: arrived), arrived.addingTimeInterval(28))
        let decoded = try JSONDecoder().decode(ShannonAppLookAskDTO.self, from: Data(
            #"{"id":"a","camera":"back","expiresAt":"2026-10-02T09:01:30.000Z","lifetimeSeconds":90}"#.utf8))
        XCTAssertEqual(decoded.lifetimeSeconds, 90)
        XCTAssertNil(ShannonAppLookAskDTO(id: "a", camera: .back, expiresAt: "soon").deadline(receivedAt: arrived))
    }

    func testASpokenReplyDoesNotWaitForASlowLook() async {
        let slow = Task<String?, Never> { @MainActor in
            try? await Task.sleep(for: .seconds(5))
            return "遅れて見えました。"
        }
        let started = Date()
        let spoken = await ShannonAppLookSpeech.spoken(slow, within: 0.1)
        XCTAssertNil(spoken)
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
        slow.cancel()
        let quick = Task<String?, Never> { @MainActor in "見えました。" }
        let heard = await ShannonAppLookSpeech.spoken(quick, within: 5)
        XCTAssertEqual(heard, "見えました。")
        let none = await ShannonAppLookSpeech.spoken(nil)
        XCTAssertNil(none)
    }

    func testTheAnswerCarriesOneFrameOrOneCodeAndNoOtherField() throws {
        let frame = ShannonAppLookFrame(jpeg: Data([0xFF, 0xD8, 0xFF, 0xD9]), width: 720, height: 960)
        let seen = try json(ShannonAppLookAnswerDTO.seen(scopeKey: "owner", camera: .back, frame: frame))
        XCTAssertEqual(Set(seen.keys), ["scopeKey", "outcome", "camera", "image"])
        XCTAssertEqual(seen["outcome"] as? String, "seen")
        XCTAssertEqual(seen["camera"] as? String, "back")
        let image = try XCTUnwrap(seen["image"] as? [String: Any])
        XCTAssertEqual(Set(image.keys), ["mediaType", "base64", "width", "height"])
        XCTAssertEqual(image["mediaType"] as? String, "image/jpeg")
        XCTAssertEqual(image["base64"] as? String, "/9j/2Q==")
        XCTAssertEqual(image["width"] as? Int, 720)
        XCTAssertEqual(image["height"] as? Int, 960)

        let refused = try json(ShannonAppLookAnswerDTO.refused(scopeKey: "owner", code: .switchedOff))
        XCTAssertEqual(Set(refused.keys), ["scopeKey", "outcome", "code"])
        XCTAssertEqual(refused["code"] as? String, "switched_off")
        XCTAssertEqual(try json(ShannonAppLookAnswerDTO.refused(scopeKey: "o", code: .noCamera))["code"] as? String, "no_camera")
        XCTAssertEqual(try json(ShannonAppLookAnswerDTO.refused(scopeKey: "o", code: .declined).scoped(to: "paired"))["scopeKey"] as? String, "paired")
    }

    // MARK: The frame

    func testAFrameIsDownsizedToWhatTheServerAccepts() throws {
        let photo = try XCTUnwrap(Fixtures.image(width: 3_024, height: 4_032))
        let frame = try XCTUnwrap(ShannonAppLookEncoder.frame(from: photo))
        XCTAssertEqual(frame.height, 960)
        XCTAssertEqual(frame.width, 720)
        XCTAssertLessThanOrEqual(frame.jpeg.count, ShannonAppLookEncoder.maximumBytes)
        XCTAssertEqual(Array(frame.jpeg.prefix(3)), [0xFF, 0xD8, 0xFF])
        XCTAssertEqual(Array(frame.jpeg.suffix(2)), [0xFF, 0xD9])

        let landscape = try XCTUnwrap(ShannonAppLookEncoder.frame(from: try XCTUnwrap(Fixtures.image(width: 1_280, height: 720))))
        XCTAssertEqual([landscape.width, landscape.height], [960, 540])
        // A small frame is not enlarged.
        let small = try XCTUnwrap(ShannonAppLookEncoder.frame(from: try XCTUnwrap(Fixtures.image(width: 320, height: 240))))
        XCTAssertEqual([small.width, small.height], [320, 240])

        let thumbnail = try XCTUnwrap(ShannonAppLookEncoder.thumbnail(from: photo))
        XCTAssertEqual(max(thumbnail.width, thumbnail.height), ShannonAppLookEncoder.thumbnailSide)
    }

    // MARK: Taking the look

    func testTakesOneFrameWithTheAskedCameraAndShowsTheSign() async throws {
        let camera = StubCamera()
        let coordinator = Fixtures.coordinator(Fixtures.environment(camera: camera))
        XCTAssertEqual(coordinator.clientState(), ShannonAppLookClientStateDTO(state: .ready, cameras: [.back, .front], platform: ShannonAppLookAvailability.platform))
        let outcome = await coordinator.look(Fixtures.ask(camera: .front))
        guard case let .seen(used, frame) = outcome else { return XCTFail("expected a frame, got \(String(describing: outcome))") }
        XCTAssertEqual(used, .front)
        XCTAssertEqual(camera.captures, [.front])
        XCTAssertLessThanOrEqual(max(frame.width, frame.height), 960)
        // The sign is on screen with the frame, and is gone again when dismissed: nothing else holds the picture.
        let cue = try XCTUnwrap(coordinator.cue)
        XCTAssertLessThanOrEqual(max(cue.thumbnail.width, cue.thumbnail.height), ShannonAppLookEncoder.thumbnailSide)
        coordinator.dismissCue(UUID())
        XCTAssertNotNil(coordinator.cue)
        coordinator.dismissCue(cue.id)
        XCTAssertNil(coordinator.cue)
    }

    func testUsesTheCameraTheDeviceHasWhenItLacksTheAskedOne() async {
        let camera = StubCamera(available: [.front])
        let coordinator = Fixtures.coordinator(Fixtures.environment(camera: camera))
        guard case let .seen(used, _) = await coordinator.look(Fixtures.ask(camera: .back)) else { return XCTFail("expected a frame") }
        XCTAssertEqual(used, .front)
        XCTAssertEqual(camera.captures, [.front])
    }

    func testNeverOpensTheCameraWhenSwitchedOffInTheBackgroundDeniedOrWithoutOne() async {
        let cases: [(ShannonAppLookRefusal, (inout Facts) -> Void)] = [
            (.switchedOff, { $0.enabled = false }),
            (.background, { $0.foreground = false }),
            (.denied, { $0.permission = .denied }),
            (.noCamera, { $0.cameras = [] }),
        ]
        for (refusal, change) in cases {
            var facts = Facts()
            change(&facts)
            let camera = StubCamera(available: facts.cameras)
            let coordinator = Fixtures.coordinator(Fixtures.environment(camera: camera, facts: Box(facts)))
            let outcome = await coordinator.look(Fixtures.ask())
            XCTAssertEqual(outcome, .refused(refusal), "\(refusal)")
            XCTAssertEqual(camera.captures, [], "\(refusal)")
            XCTAssertNil(coordinator.cue, "\(refusal)")
        }
    }

    func testAnAskThatAlreadyClosedIsNotAnsweredAndNothingIsCaptured() async {
        let camera = StubCamera()
        let coordinator = Fixtures.coordinator(Fixtures.environment(camera: camera))
        let outcome = await coordinator.look(ShannonAppLookAskDTO(id: "old", camera: .back, expiresAt: "2020-01-01T00:00:00.000Z"))
        XCTAssertNil(outcome)
        XCTAssertEqual(camera.captures, [])
    }

    func testDropsTheFrameWhenTheAppLeftTheScreenOrTheSwitchWentOffDuringCapture() async {
        for (refusal, leave) in [(ShannonAppLookRefusal.background, { (facts: Box<Facts>) in facts.value.foreground = false }),
                                 (.switchedOff, { (facts: Box<Facts>) in facts.value.enabled = false })] {
            let facts = Box(Facts())
            let camera = StubCamera()
            camera.duringCapture = { leave(facts) }
            let coordinator = Fixtures.coordinator(Fixtures.environment(camera: camera, facts: facts))
            let outcome = await coordinator.look(Fixtures.ask())
            XCTAssertEqual(outcome, .refused(refusal))
            XCTAssertNil(coordinator.cue)
        }
    }

    func testAsksTheSystemOnTheFirstLookAndSaysDeniedWhenRefused() async {
        let allowed = Box(Facts(permission: .undetermined))
        let camera = StubCamera()
        var environment = Fixtures.environment(camera: camera, facts: allowed)
        environment.requestPermission = { allowed.value.permission = .granted; return true }
        let coordinator = Fixtures.coordinator(environment)
        XCTAssertEqual(coordinator.clientState().state, .undetermined)
        guard case .seen = await coordinator.look(Fixtures.ask()) else { return XCTFail("expected a frame") }

        let refused = Box(Facts(permission: .undetermined))
        let unused = StubCamera()
        var second = Fixtures.environment(camera: unused, facts: refused)
        second.requestPermission = { refused.value.permission = .denied; return false }
        let outcome = await Fixtures.coordinator(second).look(Fixtures.ask())
        XCTAssertEqual(outcome, .refused(.denied))
        XCTAssertEqual(unused.captures, [])
    }

    func testAnInterruptedLookIsNotCapturedAndStillTellsTheServer() async throws {
        let client = LookClient(ask: Fixtures.ask())
        let camera = StubCamera()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        model.appLook = Fixtures.coordinator(Fixtures.environment(camera: camera))
        // He speaks over her before the camera opens: the look's task is cancelled.
        let look = Task { @MainActor in await model.performAppLook(Fixtures.ask()) }
        look.cancel()
        let spoken = await look.value
        XCTAssertNil(spoken)
        XCTAssertEqual(camera.captures, [])
        XCTAssertNil(model.appLook.cue)
        let answers = await client.answers
        XCTAssertEqual(answers.first?.body.code, .interrupted)
        XCTAssertEqual(answers.first?.body.outcome, "refused")

        // A reply that is cancelled while it waits for the look cancels a look that has not captured yet.
        let pending = Task<String?, Never> { @MainActor in
            while !Task.isCancelled { try? await Task.sleep(for: .milliseconds(5)) }
            return nil
        }
        let reply = Task { @MainActor in await ShannonAppLookSpeech.spoken(pending, within: 30) }
        try await Task.sleep(for: .milliseconds(50))
        reply.cancel()
        _ = await reply.value
        XCTAssertTrue(pending.isCancelled)
    }

    func testSaysWhyWhenTheCameraIsBusyOrFails() async {
        for (error, refusal) in [(ShannonAppLookCaptureError.busy, ShannonAppLookRefusal.busy), (.failed, .failed), (.noCamera, .noCamera)] {
            let camera = StubCamera()
            camera.error = error
            let outcome = await Fixtures.coordinator(Fixtures.environment(camera: camera)).look(Fixtures.ask())
            XCTAssertEqual(outcome, .refused(refusal))
        }
    }

    func testNothingIsCapturedWithoutASurfaceToShowTheSignOn() async {
        let camera = StubCamera()
        let coordinator = Fixtures.coordinator(Fixtures.environment(camera: camera), presented: false)
        let outcome = await coordinator.look(Fixtures.ask())
        XCTAssertEqual(outcome, .refused(.background))
        XCTAssertEqual(camera.captures, [])
    }

    func testOnlyTheFrontmostSurfaceShowsTheSign() {
        let coordinator = Fixtures.coordinator(Fixtures.environment(camera: StubCamera()), presented: false)
        let talk = UUID(), call = UUID()
        coordinator.register(presenter: talk)
        XCTAssertTrue(coordinator.isFrontmost(presenter: talk))
        coordinator.register(presenter: call)
        XCTAssertFalse(coordinator.isFrontmost(presenter: talk))
        XCTAssertTrue(coordinator.isFrontmost(presenter: call))
        coordinator.unregister(presenter: call)
        XCTAssertTrue(coordinator.isFrontmost(presenter: talk))
    }

    // MARK: A text turn

    func testATextTurnReportsTheCameraTakesTheLookAndAppendsWhatSheSaw() async throws {
        let client = LookClient(ask: ShannonAppLookAskDTO(id: "look-1", camera: .back, expiresAt: Fixtures.future))
        let camera = StubCamera()
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        model.appLook = Fixtures.coordinator(Fixtures.environment(camera: camera))
        model.draft = "これ見れる？"
        await model.sendDraft()
        try await Fixtures.wait { await client.answers.count == 1 && model.messages.count == 3 }

        let sent = await client.sentLooks
        XCTAssertEqual(sent, [ShannonAppLookClientStateDTO(state: .ready, cameras: [.back, .front], platform: ShannonAppLookAvailability.platform)])
        let answers = await client.answers
        let answer = try XCTUnwrap(answers.first)
        XCTAssertEqual(answer.id, "look-1")
        XCTAssertEqual(answer.body.outcome, "seen")
        XCTAssertEqual(answer.body.camera, .back)
        XCTAssertEqual(answer.body.image?.mediaType, "image/jpeg")
        XCTAssertEqual(camera.captures, [.back])
        XCTAssertEqual(model.messages.map(\.text), ["これ見れる？", "見てみますね。", "ラーメンですね。"])
        XCTAssertEqual(model.messages.last?.role, .shannon)
        XCTAssertEqual(model.messages.last?.id, UUID(uuidString: LookClient.messageID))
    }

    func testARefusedLookStillAnswersTheServerAndShowsHerLineWhenSheHasOne() async throws {
        let client = LookClient(ask: ShannonAppLookAskDTO(id: "look-2", camera: .back, expiresAt: Fixtures.future))
        let model = ShannonConversationModel(client: client, usesDisplayCache: false)
        let camera = StubCamera()
        model.appLook = Fixtures.coordinator(Fixtures.environment(camera: camera, facts: Box(Facts(foreground: false))))
        let said = await model.performAppLook(ShannonAppLookAskDTO(id: "look-2", camera: .back, expiresAt: Fixtures.future))
        XCTAssertEqual(said, "ラーメンですね。")
        let answers = await client.answers
        let answer = try XCTUnwrap(answers.first)
        XCTAssertEqual(answer.body.outcome, "refused")
        XCTAssertEqual(answer.body.code, .background)
        XCTAssertNil(answer.body.image)
        XCTAssertEqual(camera.captures, [])
    }

    func testAClientThatCannotAnswerALookSendsTheTurnAsBeforeAndNeverLooks() async {
        let plain = PlainClient(response: Fixtures.chatResponse(reply: "はい。", ask: ShannonAppLookAskDTO(id: "x", camera: .back, expiresAt: Fixtures.future)))
        let camera = StubCamera()
        let model = ShannonConversationModel(client: plain, usesDisplayCache: false)
        model.appLook = Fixtures.coordinator(Fixtures.environment(camera: camera))
        XCTAssertNil(model.appLookClientState())
        model.draft = "これ見れる？"
        await model.sendDraft()
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(model.messages.map(\.text), ["これ見れる？", "はい。"])
        XCTAssertEqual(camera.captures, [])
    }

    // MARK: A voice turn

    func testAVoiceLookRunsBesideTheReplyAndYieldsHerNextUtterance() async {
        XCTAssertNil(ShannonAppLookSpeech.begin(nil, with: { _ in "見えました。" }))
        XCTAssertNil(ShannonAppLookSpeech.begin(Fixtures.ask(), with: nil))
        let spoken = await ShannonAppLookSpeech.begin(Fixtures.ask(), with: { _ in "  ラーメンですね。\n" })?.value
        XCTAssertEqual(spoken, "ラーメンですね。")
        let silent = await ShannonAppLookSpeech.begin(Fixtures.ask(), with: { _ in nil })?.value
        XCTAssertNil(silent)
        let empty = await ShannonAppLookSpeech.begin(Fixtures.ask(), with: { _ in "  " })?.value
        XCTAssertNil(empty)
    }

    // MARK: Words

    func testCopySaysWhatHappensAndWhatIsKept() {
        XCTAssertEqual(ShannonAppLookCopy.toggleTitle, "会話中にシャノンがカメラで見る")
        XCTAssertEqual(ShannonAppLookCopy.cueTitle, "いま見ました")
        XCTAssertTrue(ShannonAppLookCopy.explanation.contains("保存しません"))
        XCTAssertTrue(ShannonAppLookCopy.explanation.contains("アプリが画面に出ていない間は見ません"))
        XCTAssertEqual(ShannonAppLookCopy.statusText(enabled: true, permission: .granted, hasCamera: true), "見てと言われた時と、気になった時に見ます")
        XCTAssertEqual(ShannonAppLookCopy.statusText(enabled: true, permission: .undetermined, hasCamera: true), "最初に見る時に、カメラの許可を確認します")
        XCTAssertEqual(ShannonAppLookCopy.statusText(enabled: true, permission: .denied, hasCamera: true), "カメラの権限がありません")
        XCTAssertEqual(ShannonAppLookCopy.statusText(enabled: false, permission: .granted, hasCamera: true), "見ません")
        XCTAssertEqual(ShannonAppLookCopy.statusText(enabled: true, permission: .granted, hasCamera: false), "この端末にはカメラがありません")
        let primer = ShannonPermissionPrimerContent.appLook
        XCTAssertTrue(primer.benefits.contains { $0.text.contains("保存しません") })
        XCTAssertTrue(primer.benefits.contains { $0.text.contains("いま見ました") })
        XCTAssertTrue(primer.benefits.contains { $0.text.contains("会話中にシャノンがカメラで見る") })
    }

    // MARK: The state that is always on screen (A7)

    func testTheVisibleStateIsOffUnlessSheReallyMayLookAndLookingWhileTheCameraIsOpen() {
        typealias State = ShannonAppLookVisibleState
        XCTAssertEqual(State.make(enabled: true, hasCamera: true, permission: .granted, isCapturing: false), .allowed)
        // An unanswered permission is asked on the first look: she may still look.
        XCTAssertEqual(State.make(enabled: true, hasCamera: true, permission: .undetermined, isCapturing: false), .allowed)
        XCTAssertEqual(State.make(enabled: false, hasCamera: true, permission: .granted, isCapturing: false), .off)
        XCTAssertEqual(State.make(enabled: true, hasCamera: false, permission: .granted, isCapturing: false), .off)
        XCTAssertEqual(State.make(enabled: true, hasCamera: true, permission: .denied, isCapturing: false), .off)
        // 「友人も一緒」: the call does not offer her the camera.
        XCTAssertEqual(State.make(enabled: true, hasCamera: true, permission: .granted, othersPresent: true, isCapturing: false), .off)
        XCTAssertEqual(State.make(enabled: true, hasCamera: true, permission: .granted, isCapturing: true), .looking)
        XCTAssertEqual(State.off.line, "カメラ：切")
        XCTAssertEqual(State.allowed.line, "カメラ：見てよい")
        XCTAssertEqual(State.looking.line, "カメラ：いま見ています")
    }

    func testTheCameraIsShownAsLookingOnlyWhileTheFrameIsTaken() async throws {
        let camera = HeldCamera()
        let coordinator = Fixtures.coordinator(ShannonAppLookEnvironment(
            isEnabled: { true }, isForeground: { true }, permission: { .granted }, requestPermission: { true }, camera: camera))
        XCTAssertFalse(coordinator.isCapturing)
        let look = Task { await coordinator.look(Fixtures.ask()) }
        try await Fixtures.wait { camera.isHeld }
        XCTAssertTrue(coordinator.isCapturing)
        camera.release(failing: false)
        _ = await look.value
        XCTAssertFalse(coordinator.isCapturing)
        // A capture that fails ends the state too.
        let failing = Task { await coordinator.look(Fixtures.ask()) }
        try await Fixtures.wait { camera.isHeld }
        camera.release(failing: true)
        _ = await failing.value
        XCTAssertFalse(coordinator.isCapturing)
    }

    private func json<T: Encodable>(_ value: T) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }
}

// MARK: - Stubs

private struct Facts {
    var enabled = true
    var foreground = true
    var permission = ShannonMediaPermission.granted
    var cameras: [ShannonAppLookCamera] = [.back, .front]
}

private final class Box<Value>: @unchecked Sendable {
    var value: Value
    init(_ value: Value) { self.value = value }
}

private final class StubCamera: ShannonAppLookCapturing, @unchecked Sendable {
    let available: [ShannonAppLookCamera]
    private(set) var captures: [ShannonAppLookCamera] = []
    var error: ShannonAppLookCaptureError?
    var duringCapture: (() -> Void)?

    init(available: [ShannonAppLookCamera] = [.back, .front]) { self.available = available }

    func cameras() -> [ShannonAppLookCamera] { available }

    func capture(_ camera: ShannonAppLookCamera) async throws -> CGImage {
        captures.append(camera)
        duringCapture?()
        if let error { throw error }
        guard let image = Fixtures.image(width: 1_280, height: 720) else { throw ShannonAppLookCaptureError.failed }
        return image
    }
}

/// A camera that holds its frame until the test lets it go.
private final class HeldCamera: ShannonAppLookCapturing, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<CGImage, Error>?

    var isHeld: Bool { lock.withLock { continuation != nil } }

    func cameras() -> [ShannonAppLookCamera] { [.back] }

    func capture(_ camera: ShannonAppLookCamera) async throws -> CGImage {
        try await withCheckedThrowingContinuation { continuation in
            lock.withLock { self.continuation = continuation }
        }
    }

    func release(failing: Bool) {
        let held = lock.withLock { () -> CheckedContinuation<CGImage, Error>? in
            defer { continuation = nil }
            return continuation
        }
        if failing { held?.resume(throwing: ShannonAppLookCaptureError.failed) }
        else if let image = Fixtures.image(width: 640, height: 480) { held?.resume(returning: image) }
    }
}

private struct PlainClient: ShannonAPIClientProtocol {
    let response: ChatResponseDTO
    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO { response }
}

private actor LookClient: ShannonAPIClientProtocol, ShannonAppLookServing {
    static let messageID = "00000000-0000-4000-8000-0000000000aa"
    let ask: ShannonAppLookAskDTO
    private(set) var sentLooks: [ShannonAppLookClientStateDTO?] = []
    private(set) var answers: [(id: String, body: ShannonAppLookAnswerDTO)] = []

    init(ask: ShannonAppLookAskDTO) { self.ask = ask }

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        Fixtures.chatResponse(reply: "はい。")
    }

    func send(
        message: String, scopeKey: String, threadId: String?, attachments: [ShannonChatAttachmentDTO],
        webSearch: Bool, placeLocation: ShannonVoiceDeviceLocationDTO?, appLook: ShannonAppLookClientStateDTO?
    ) async throws -> ChatResponseDTO {
        sentLooks.append(appLook)
        return Fixtures.chatResponse(reply: "見てみますね。", ask: ask)
    }

    func answerAppLook(id: String, answer: ShannonAppLookAnswerDTO) async throws -> ShannonAppLookAnswerResponseDTO {
        answers.append((id, answer))
        return try JSONDecoder().decode(ShannonAppLookAnswerResponseDTO.self, from: Data(
            #"{"schemaVersion":1,"id":"\#(id)","status":"seen","message":{"id":"\#(Self.messageID)","threadId":"test-thread","text":"ラーメンですね。"}}"#.utf8))
    }
}

@MainActor
private enum Fixtures {
    nonisolated static let future = "2099-01-01T00:00:00.000Z"

    /// A coordinator with one surface on screen to show the sign on.
    static func coordinator(_ environment: ShannonAppLookEnvironment, presented: Bool = true) -> ShannonAppLookCoordinator {
        let coordinator = ShannonAppLookCoordinator(environment: environment)
        if presented { coordinator.register(presenter: UUID()) }
        return coordinator
    }

    static func ask(camera: ShannonAppLookCamera = .back) -> ShannonAppLookAskDTO {
        ShannonAppLookAskDTO(id: "look", camera: camera, expiresAt: future)
    }

    static func environment(camera: StubCamera, facts: Box<Facts> = Box(Facts())) -> ShannonAppLookEnvironment {
        ShannonAppLookEnvironment(
            isEnabled: { facts.value.enabled },
            isForeground: { facts.value.foreground },
            permission: { facts.value.permission },
            requestPermission: { facts.value.permission == .granted },
            camera: camera
        )
    }

    /// A noisy picture, so that JPEG size is not flattered by flat colour.
    nonisolated static func image(width: Int, height: Int) -> CGImage? {
        var generator = SystemRandomNumberGenerator()
        var pixels = [UInt8](repeating: 255, count: width * height * 4)
        for index in stride(from: 0, to: pixels.count, by: 4) {
            pixels[index] = UInt8.random(in: 0...255, using: &generator)
            pixels[index + 1] = UInt8(index % 251)
            pixels[index + 2] = UInt8.random(in: 0...255, using: &generator)
        }
        guard let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
        return CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }

    static func wait(_ condition: @MainActor () async -> Bool) async throws {
        // Generous: the machine that runs these may be busy with several builds.
        for _ in 0..<3_000 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("condition was not met in time")
    }

    nonisolated static func chatResponse(reply: String = "ok", ask: ShannonAppLookAskDTO? = nil) -> ChatResponseDTO {
        var response = ChatResponseDTO(
            mode: "local-stub", reply: reply, threadId: "test-thread", snapshotVersion: 0,
            messageEmotion: ShannonMessageEmotionDTO(valence: 0, arousal: 0.3, openness: 0.35, expression: .calm),
            systemPrompt: "prompt",
            state: CompanionStateDTO(
                scopeKey: "local-owner", version: 0, updatedAt: "2026-08-31T00:00:00.000Z",
                temperament: ShannonTemperamentDTO(
                    curiosity: 0.65, initiative: 0.25, closeness: 0.15, calmness: 0.60,
                    needForContinuity: 0.70, confidenceAboutUser: 0.05),
                emotion: ShannonEmotionDTO(valence: 0, arousal: 0.3, openness: 0.35),
                interests: [], userFacts: [], activeMemories: [])
        )
        response.appLook = ask
        return response
    }
}
