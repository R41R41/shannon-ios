import Foundation
import XCTest
@testable import ShannonAppCore

/// The Swift mirror of `vision.*.v1` reads the same fixture as the server (`services/api/tests/fixtures/vision-contract-v1.json`,
/// embedded here unchanged) and writes it back key for key, nulls included.
final class ShannonVisionContractTests: XCTestCase {
    static let fixture = #"""
{
  "frame": {
    "schema": "vision.frame.v1",
    "frameId": "frame-7d2c1f0a",
    "capturedAt": "2026-10-14T09:00:00.000Z",
    "receivedAt": "2026-10-14T09:00:00.180Z",
    "source": { "kind": "app_camera", "bodyId": null, "deviceId": "device-owner-iphone" },
    "sessionId": "watch-3b9e",
    "generation": 1,
    "privacy": "owner_private",
    "audienceAtCapture": "owner_alone",
    "ttlMs": 4000,
    "encoding": { "width": 512, "height": 384, "format": "jpeg", "byteLength": 38211 },
    "gate": { "reason": "difference", "difference": 0.31, "personCount": 1 },
    "state": null
  },
  "session": {
    "schema": "vision.session.v1",
    "sessionId": "watch-3b9e",
    "generation": 1,
    "source": { "kind": "app_camera", "bodyId": null, "deviceId": "device-owner-iphone" },
    "goal": "notice",
    "parentTaskId": null,
    "startedAt": "2026-10-14T08:59:00.000Z",
    "deadlineAt": "2026-10-14T09:29:00.000Z",
    "budget": { "maxDecisions": 900, "maxDurationMs": 1800000 },
    "state": "ended",
    "endReason": "audience_changed",
    "endedAt": "2026-10-14T09:03:00.000Z"
  },
  "decision": {
    "schema": "vision.decision.v1",
    "decisionId": "decision-51aa",
    "frameId": "frame-7d2c1f0a",
    "sessionId": "watch-3b9e",
    "generation": 1,
    "source": { "kind": "app_camera", "bodyId": null, "deviceId": "device-owner-iphone" },
    "candidates": ["quiet", "react:smile", "notice:owner_returned", "escalate", "other"],
    "gate": { "probability": 0.81, "threshold": 0.7 },
    "choice": {
      "candidateId": "notice:owner_returned",
      "confidence": 0.77,
      "probabilities": [
        { "id": "quiet", "probability": 0.12 },
        { "id": "notice:owner_returned", "probability": 0.8 },
        { "id": "react:smile", "probability": 0.08 }
      ]
    },
    "outcome": "chosen",
    "discardReason": null,
    "timings": { "queuedMs": 2, "decisionMs": 640, "totalMs": 655 },
    "cost": { "reservedUsd": 0.002, "estimatedUsd": 0.00009, "inputTokens": 880, "usageComplete": true },
    "degrade": 0,
    "decidedAt": "2026-10-14T09:00:00.840Z"
  },
  "reply": {
    "schema": "vision.frame.reply.v1",
    "frameId": "frame-7d2c1f0a",
    "watch": "continue",
    "stopReason": null,
    "outcome": "chosen",
    "candidateId": "react:smile",
    "reaction": "smile",
    "degrade": 0,
    "nextFrameNotBefore": "2026-10-14T09:00:02.000Z"
  },
  "status": {
    "schema": "vision.status.v1",
    "watchAllowed": false,
    "reason": "audience",
    "degrade": 0,
    "limits": { "judgeFramesPerSecond": 2, "sendIntervalMs": 2000, "longSide": 512, "frameBytes": 160000, "ttlMs": 4000 }
  }
}
"""#

    private func fixtureObject() throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(Self.fixture.utf8)) as? [String: Any])
    }

    private func section(_ name: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: try XCTUnwrap(try fixtureObject()[name]))
    }

    /// Decodes a section, encodes it again, and checks that the JSON is the fixture's (same keys, same values, same nulls).
    private func roundTrip<Record: Codable & Equatable>(_ type: Record.Type, _ name: String) throws -> Record {
        let decoded = try JSONDecoder().decode(Record.self, from: try section(name))
        let encoded = try JSONEncoder().encode(decoded)
        let again = try JSONDecoder().decode(Record.self, from: encoded)
        XCTAssertEqual(again, decoded, name)
        let written = try XCTUnwrap(try JSONSerialization.jsonObject(with: encoded) as? NSDictionary)
        let original = try XCTUnwrap(try fixtureObject()[name] as? NSDictionary)
        XCTAssertEqual(written, original, "\(name) is not written back as the fixture has it")
        return decoded
    }

    func testTheFixtureDecodesAndRoundTrips() throws {
        let frame = try roundTrip(ShannonVisionFrame.self, "frame")
        XCTAssertEqual(frame.schema, "vision.frame.v1")
        XCTAssertEqual(frame.source, ShannonVisionSource(kind: .appCamera, bodyId: nil, deviceId: "device-owner-iphone"))
        XCTAssertEqual(frame.privacy, .ownerPrivate)
        XCTAssertEqual(frame.audienceAtCapture, .ownerAlone)
        XCTAssertEqual(frame.gate, ShannonVisionGate(reason: .difference, difference: 0.31, personCount: 1))
        XCTAssertEqual(frame.encoding, ShannonVisionEncoding(width: 512, height: 384, format: .jpeg, byteLength: 38211))
        XCTAssertNil(frame.state)

        let session = try roundTrip(ShannonVisionSession.self, "session")
        XCTAssertEqual(session.state, .ended)
        XCTAssertEqual(session.endReason, .audienceChanged)
        XCTAssertEqual(session.goal, .notice)

        let decision = try roundTrip(ShannonVisionDecision.self, "decision")
        XCTAssertEqual(decision.outcome, .chosen)
        XCTAssertEqual(decision.choice.candidateId, "notice:owner_returned")
        XCTAssertTrue(decision.candidates.allSatisfy { ShannonVisionCandidate(id: $0) != nil })

        let reply = try roundTrip(ShannonVisionFrameReply.self, "reply")
        XCTAssertEqual(reply.watch, .continue)
        XCTAssertEqual(reply.reaction, .smile)
        XCTAssertEqual(reply.reactionToShow?.expression, .joyful)
        XCTAssertNotNil(ShannonVisionWire.date(reply.nextFrameNotBefore))

        let status = try roundTrip(ShannonVisionStatus.self, "status")
        XCTAssertFalse(status.watchAllowed)
        XCTAssertEqual(status.reason, .audience)
        XCTAssertEqual(status.limits, .init(judgeFramesPerSecond: 2, sendIntervalMs: 2000, longSide: 512, frameBytes: 160000, ttlMs: 4000))
    }

    /// The closed vocabularies are the server's (`visionContract.ts`), word for word.
    func testTheClosedVocabulariesMatchTheServer() {
        XCTAssertEqual(ShannonVisionSourceKind.allCases.map(\.rawValue),
            ["app_camera", "app_look", "body_look", "photo", "minecraft", "screen", "stream"])
        XCTAssertEqual(ShannonVisionPrivacy.allCases.map(\.rawValue), ["owner_private", "shared_room", "world_shared", "stream_public"])
        XCTAssertEqual(ShannonVisionAudience.allCases.map(\.rawValue), ["owner_alone", "others", "stream"])
        XCTAssertEqual(ShannonVisionGateReason.allCases.map(\.rawValue), ["difference", "owner_asked", "first_frame"])
        XCTAssertEqual(ShannonVisionReaction.allCases.map(\.rawValue), ["smile", "surprised", "curious", "tender", "concerned"])
        XCTAssertEqual(ShannonVisionNoticeCategory.allCases.map(\.rawValue),
            ["owner_returned", "owner_waved", "showing_something", "new_object", "owner_looks_tired"])
        XCTAssertEqual(ShannonVisionCandidateKind.allCases.map(\.rawValue), ["quiet", "react", "notice", "escalate", "other"])
        XCTAssertEqual(ShannonVisionDecisionOutcome.allCases.map(\.rawValue), ["chosen", "quiet", "discarded", "refused", "failed", "skipped"])
        XCTAssertEqual(ShannonVisionDiscardReason.allCases.map(\.rawValue), [
            "stale_generation", "expired", "audience_changed", "below_gate", "low_confidence", "budget", "degraded", "busy", "disabled",
            "repeated", "timeout", "http_error", "usage_unknown", "invalid_answer", "capped",
        ])
        XCTAssertEqual(ShannonVisionEndReason.allCases.map(\.rawValue), [
            "completed", "hazard_cleared", "target_lost", "no_progress", "no_candidates", "observation_unavailable", "cancelled", "deadline",
            "decision_limit", "action_limit", "stale_generation", "audience_changed", "budget", "degraded", "returned", "unknown",
        ])
        XCTAssertEqual(ShannonVisionStopReason.allCases.map(\.rawValue), ["audience", "degraded", "disabled", "budget"])
        // Each reaction is a face the app draws.
        XCTAssertEqual(ShannonVisionReaction.allCases.map(\.expression), [.joyful, .surprised, .curious, .tender, .concerned])
    }

    func testCandidateIdsParseOnlyTheClosedVocabulary() {
        XCTAssertEqual(ShannonVisionCandidate(id: "quiet")?.kind, .quiet)
        XCTAssertEqual(ShannonVisionCandidate(id: "escalate")?.kind, .escalate)
        XCTAssertEqual(ShannonVisionCandidate(id: "react:tender")?.reaction, .tender)
        XCTAssertEqual(ShannonVisionCandidate(id: "notice:new_object")?.category, .newObject)
        XCTAssertEqual(ShannonVisionCandidate(id: "react:tender")?.id, "react:tender")
        for unknown in ["react", "notice", "react:wink", "notice:secret", "look", ""] {
            XCTAssertNil(ShannonVisionCandidate(id: unknown), unknown)
        }
    }

    /// What this app writes about a frame: every key the server's closed record needs, nulls written out, and no key that
    /// could carry a picture or a way to keep one (`VISION_FORBIDDEN_KEYS`).
    func testAFrameRecordCarriesNoPictureAndWritesItsNulls() throws {
        let frame = ShannonVisionFrame(
            frameId: "frame-1", capturedAt: "2026-10-14T09:00:00.000Z", source: .init(kind: .appCamera, bodyId: nil, deviceId: nil),
            sessionId: "watch-1", generation: 1, privacy: .ownerPrivate, audienceAtCapture: .ownerAlone, ttlMs: 4000,
            encoding: .init(width: 512, height: 384, format: .jpeg, byteLength: 1000), gate: .init(reason: .firstFrame, difference: nil, personCount: nil))
        let header = try ShannonVisionWire.headerValue(frame)
        XCTAssertFalse(header.contains("\n"))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(header.utf8)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["schema", "frameId", "capturedAt", "receivedAt", "source", "sessionId", "generation", "privacy",
            "audienceAtCapture", "ttlMs", "encoding", "gate", "state"])
        XCTAssertTrue(object["receivedAt"] is NSNull)
        XCTAssertTrue(object["state"] is NSNull)
        let gate = try XCTUnwrap(object["gate"] as? [String: Any])
        XCTAssertTrue(gate["difference"] is NSNull && gate["personCount"] is NSNull)
        let source = try XCTUnwrap(object["source"] as? [String: Any])
        XCTAssertTrue(source["bodyId"] is NSNull && source["deviceId"] is NSNull)
        let forbidden: Set<String> = ["persist", "image", "images", "bytes", "base64", "data", "jpeg", "png", "url", "imageUrl", "pixels"]
        func keys(_ value: Any) -> [String] {
            if let row = value as? [String: Any] { return row.keys + row.values.flatMap(keys) }
            if let list = value as? [Any] { return list.flatMap(keys) }
            return []
        }
        XCTAssertTrue(forbidden.isDisjoint(with: keys(object)))
        for record in ["frame", "session", "decision", "reply", "status"] {
            XCTAssertTrue(forbidden.isDisjoint(with: keys(try XCTUnwrap(try fixtureObject()[record]))), record)
        }
    }
}
