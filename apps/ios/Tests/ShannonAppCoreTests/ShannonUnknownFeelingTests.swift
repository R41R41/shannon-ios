import XCTest
@testable import ShannonAppCore

/// A feeling kind a newer server adds (`uncomfortable`, 気持ち悪い・いや, body stage 1b; or any other) never fails what
/// carries it: the voice plan still decodes and is spoken, and a reply, a message, a mood or her presence still shows.
final class ShannonUnknownFeelingTests: XCTestCase {
    private static func delegation(affect: String, delivery: String = "conversational", expression: String = "annoyed", kind: String? = nil) -> Data {
        let kindField = kind.map { #","kind":"\#($0)""# } ?? ""
        return Data(#"""
        {"threadId":"t1","model":"test","reply":"もう、そこはだめです。","voicePlan":{"shouldRespond":true,"conversationClass":"direct","affect":"\#(affect)","affectIntensity":0.6,"delivery":"\#(delivery)","selectedSkills":[],"expression":"\#(expression)"\#(kindField)}}
        """#.utf8)
    }

    func testAVoicePlanWithANewAffectStillDecodesAndIsSpoken() throws {
        for (affect, expected) in [("uncomfortable", ShannonVoiceAffectDTO.annoyed), ("someFeelingOfTomorrow", .neutral), ("annoyed", .annoyed)] {
            let response = try JSONDecoder().decode(ShannonLiveVoiceDelegationResponseDTO.self, from: Self.delegation(affect: affect))
            let plan = try XCTUnwrap(response.voicePlan, affect)
            XCTAssertEqual(plan.affect, expected, affect)
            XCTAssertTrue(plan.shouldRespond)
            // It is spoken with a style, as any known affect is.
            XCTAssertFalse(ShannonElevenCascadeSpeech.style(for: response.reply, plan: plan).isEmpty, affect)
            XCTAssertEqual(plan.turnEmotion.primary, expected.rawValue)
        }
        // An unknown delivery is an ordinary turn, not a failed plan.
        let delivery = try JSONDecoder().decode(ShannonLiveVoiceDelegationResponseDTO.self, from: Self.delegation(affect: "happy", delivery: "whisper"))
        XCTAssertEqual(delivery.voicePlan?.delivery, .conversational)
    }

    func testTheNewKindShowsTheAnnoyedFaceAndIcon() throws {
        // The plan's face, from the kind beside it or from a face name this build does not have.
        let byKind = try JSONDecoder().decode(
            ShannonLiveVoiceDelegationResponseDTO.self, from: Self.delegation(affect: "uncomfortable", expression: "neutral", kind: "uncomfortable"))
        XCTAssertEqual(byKind.voicePlan?.face?.expression, .annoyed)
        XCTAssertNil(byKind.voicePlan?.face?.kind)
        let byName = try JSONDecoder().decode(
            ShannonLiveVoiceDelegationResponseDTO.self, from: Self.delegation(affect: "uncomfortable", expression: "uncomfortable"))
        XCTAssertEqual(byName.voicePlan?.face?.expression, .annoyed)
        XCTAssertEqual(ShannonFace(expression: .neutral, feelingName: nil, kindName: "uncomfortable").japaneseName, ShannonExpressionDTO.annoyed.japaneseName)
        XCTAssertEqual(ShannonExpressionDTO.known("uncomfortable"), .annoyed)
        XCTAssertNil(ShannonExpressionDTO.known("someFaceOfTomorrow"))
    }

    func testEveryOtherCarrierOfAFeelingSurvivesAnUnknownKind() throws {
        // A reply's emotion: an unknown face is the usual one, `uncomfortable` the annoyed one, and the kind stays text.
        let message = try JSONDecoder().decode(ShannonMessageEmotionDTO.self, from: Data(
            #"{"valence":-0.3,"arousal":0.5,"openness":0.3,"expression":"uncomfortable","kind":"uncomfortable"}"#.utf8))
        XCTAssertEqual(message.expression, .annoyed)
        XCTAssertEqual(message.face.expression, .annoyed)
        let unknown = try JSONDecoder().decode(ShannonMessageEmotionDTO.self, from: Data(
            #"{"valence":0,"arousal":0.3,"openness":0.3,"expression":"someFaceOfTomorrow","kind":"someKindOfTomorrow"}"#.utf8))
        XCTAssertEqual(unknown.expression, .neutral)
        XCTAssertNil(unknown.face.kind)
        // The kept message keeps the kind and shows the annoyed face again when read back.
        let snapshot = ConversationMessage.EmotionSnapshot(message, stateVersion: 1)
        XCTAssertEqual(snapshot.face.expression, .annoyed)
        // 「いま」: her presented mood.
        let mood = try JSONDecoder().decode(CompanionPresenceDTO.Mood.self, from: Data(
            #"{"expression":"uncomfortable","cause":"体","fromConversation":false}"#.utf8))
        XCTAssertEqual(mood.face.expression, .annoyed)
        // ようす: the faces of now and the mood history are text, and name the new kind with the annoyed face.
        XCTAssertEqual(ShannonNowFaceDTO(expression: "uncomfortable").face?.expression, .annoyed)
        XCTAssertNil(ShannonNowFaceDTO(expression: "someFaceOfTomorrow").face)
        let history = try JSONDecoder().decode(ShannonMoodHistoryDTO.self, from: Data(#"""
        {"points":[{"at":"2026-10-06T02:00:00.000Z","valence":-0.2,"arousal":0.4,"openness":0.3,"mood":{"expression":"uncomfortable"},"present":{"kind":"uncomfortable","intensity":0.5}}]}
        """#.utf8))
        XCTAssertEqual(history.points.first?.present?.kind, "uncomfortable")
        // An icon is shown only for a kind this build has a picture for.
        XCTAssertNil(ShannonEmotionKindIcon.displayed("uncomfortable"))
    }
}
