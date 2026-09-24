import Foundation
import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonConnectionTests: XCTestCase {
    override func tearDown() {
        URLProtocolStub.handler = nil
        super.tearDown()
    }

    func testPairingStoresServerBoundCredential() async throws {
        let store = MemoryConnectionStore()
        let session = stubSession { request in
            XCTAssertEqual(request.url?.absoluteString, "https://shannon.example/companion/v1/pair")
            XCTAssertEqual(request.httpMethod, "POST")
            let body = try XCTUnwrap(requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
            XCTAssertEqual(json["code"], "ABCD1234EF90")
            XCTAssertEqual(json["deviceName"], "Test iPhone")
            return try response(
                url: request.url!,
                json: [
                    "token": String(repeating: "a", count: 43),
                    "deviceId": "device-1",
                    "scopeKey": "owner-a",
                    "displayName": "Test iPhone",
                    "expiresAt": "2099-08-31T00:00:00.000Z",
                ]
            )
        }
        let model = ShannonConnectionModel(
            baseURL: URL(string: "https://shannon.example/companion")!,
            store: store,
            session: session,
            deviceName: { "Test iPhone" }
        )
        let connected = await model.connect(using: URL(string: "shannon://connect?code=abcd-1234-ef90")!)

        XCTAssertTrue(connected)
        XCTAssertTrue(model.isConnected)
        XCTAssertEqual(model.statusLabel, "接続済み・Test iPhone")
        XCTAssertEqual(try store.load()?.scopeKey, "owner-a")
        XCTAssertEqual(try store.load()?.baseURL.absoluteString, "https://shannon.example/companion")
    }

    func testAPIClientUsesKeychainTokenAndBoundScope() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: String(repeating: "b", count: 43),
            deviceID: "device-2",
            scopeKey: "owner-from-server",
            displayName: "Test iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        let session = stubSession { request in
            XCTAssertEqual(request.url?.absoluteString, "https://shannon.example/companion/v1/chat")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(String(repeating: "b", count: 43))")
            let body = try XCTUnwrap(requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["scopeKey"] as? String, "owner-from-server")
            return try response(url: request.url!, json: chatResponseJSON())
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        _ = try await client.send(message: "こんにちは", scopeKey: "untrusted-client-scope")
    }

    func testAPIClientLoadsAndUpdatesTheServerBoundVoiceIdentity() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let bearer = String(repeating: "v", count: 43)
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: bearer,
            deviceID: "voice-device",
            scopeKey: "owner-from-server",
            displayName: "Test iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        let session = stubSession { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(bearer)")
            if request.httpMethod == "GET" {
                XCTAssertEqual(
                    request.url?.absoluteString,
                    "https://shannon.example/companion/v1/voice/identity?scopeKey=owner-from-server"
                )
            } else {
                XCTAssertEqual(request.url?.absoluteString, "https://shannon.example/companion/v1/voice/identity")
                let body = try XCTUnwrap(requestBody(request))
                let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                XCTAssertEqual(json["scopeKey"] as? String, "owner-from-server")
                XCTAssertEqual(json["mode"] as? String, "manual")
                XCTAssertEqual(json["selectedVoice"] as? String, "cedar")
            }
            return try response(url: request.url!, json: voiceIdentityResponseJSON())
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        let loaded = try await client.loadVoiceIdentity(scopeKey: "untrusted-client-scope")
        let updated = try await client.updateVoiceIdentity(
            scopeKey: "untrusted-client-scope",
            mode: .manual,
            selectedVoice: "cedar"
        )
        XCTAssertEqual(loaded.preference.effectiveVoice, "cedar")
        XCTAssertEqual(updated.preference.selectedVoice, "cedar")
    }

    func testAPIClientLoadsAndExtendsRealtimeVoiceAllowance() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let bearer = String(repeating: "a", count: 43)
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: bearer,
            deviceID: "allowance-device",
            scopeKey: "owner-from-server",
            displayName: "Test iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        var requestCount = 0
        let session = stubSession { request in
            requestCount += 1
            XCTAssertEqual(request.url?.path, "/companion/v1/voice/realtime/allowance")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(bearer)")
            XCTAssertEqual(request.httpMethod, requestCount == 1 ? "GET" : "POST")
            return try response(url: request.url!, json: [
                "dayKey": "2026-09-19",
                "baseAllowanceSeconds": 3_600,
                "additionalAllowanceSeconds": requestCount == 1 ? 0 : 3_600,
                "totalAllowanceSeconds": requestCount == 1 ? 3_600 : 7_200,
                "reservedSeconds": 3_600,
                "remainingSeconds": requestCount == 1 ? 0 : 3_600,
                "maximumAllowanceSeconds": 86_400,
            ])
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        let initial = try await client.loadRealtimeVoiceAllowance(scopeKey: "untrusted-client-scope")
        let extended = try await client.extendRealtimeVoiceAllowance(scopeKey: "untrusted-client-scope")

        XCTAssertEqual(initial.remainingSeconds, 0)
        XCTAssertEqual(extended.additionalAllowanceSeconds, 3_600)
        XCTAssertEqual(extended.remainingSeconds, 3_600)
    }

    func testAPIClientLoadsAndDecidesWorldSubscriptionWithBoundScope() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let bearer = String(repeating: "s", count: 43)
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: bearer,
            deviceID: "world-device",
            scopeKey: "owner-from-server",
            displayName: "Test iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        let session = stubSession { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(bearer)")
            if request.url?.path == "/companion/v1/world/sources" {
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(
                    request.url?.absoluteString,
                    "https://shannon.example/companion/v1/world/sources?scopeKey=owner-from-server"
                )
                return try response(url: request.url!, json: ["sources": [worldSourceJSON()]])
            }
            if request.httpMethod == "GET" {
                XCTAssertEqual(
                    request.url?.absoluteString,
                    "https://shannon.example/companion/v1/world/subscriptions?scopeKey=owner-from-server"
                )
                return try response(url: request.url!, json: ["subscriptions": [worldSubscriptionJSON()]])
            }
            XCTAssertEqual(
                request.url?.absoluteString,
                "https://shannon.example/companion/v1/world/subscriptions/feed-1/decision"
            )
            let body = try XCTUnwrap(requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["scopeKey"] as? String, "owner-from-server")
            XCTAssertEqual(json["decision"] as? String, "approve")
            XCTAssertEqual(json["expectedUpdatedAt"] as? String, "before")
            var updated = worldSubscriptionJSON()
            updated["approval"] = "approved"
            updated["status"] = "trial"
            updated["updatedAt"] = "after"
            return try response(url: request.url!, json: updated)
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        let sources = try await client.loadWorldSources(scopeKey: "untrusted-client-scope")
        let subscriptions = try await client.loadWorldSubscriptions(scopeKey: "untrusted-client-scope")
        let updated = try await client.decideWorldSubscription(
            scopeKey: "untrusted-client-scope",
            subscriptionID: subscriptions[0].id,
            decision: .approve,
            expectedUpdatedAt: subscriptions[0].updatedAt
        )
        XCTAssertEqual(sources[0].title, "Hacker News")
        XCTAssertEqual(sources[0].fetchedItemCount, 12)
        XCTAssertEqual(subscriptions[0].approval, .pending)
        XCTAssertEqual(updated.status, .trial)
    }

    func testAPIClientLoadsVoicePreviewAsAuthenticatedAudioOnly() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let bearer = String(repeating: "w", count: 43)
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: bearer,
            deviceID: "voice-preview-device",
            scopeKey: "owner-from-server",
            displayName: "Test iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        let expected = Data([0x49, 0x44, 0x33, 0x04])
        let session = stubSession { request in
            XCTAssertEqual(request.url?.absoluteString, "https://shannon.example/companion/v1/voice/identity/preview")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(bearer)")
            let body = try XCTUnwrap(requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
            XCTAssertEqual(json["voice"], "coral")
            let response = try XCTUnwrap(HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["content-type": "audio/mpeg"]
            ))
            return (response, expected)
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        let preview = try await client.loadVoicePreview(scopeKey: "ignored", voice: "coral")
        XCTAssertEqual(preview, expected)
    }

    func testConnectionVerificationUsesStoredCredentialWithoutExposingIt() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let bearer = String(repeating: "k", count: 43)
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: bearer,
            deviceID: "mac-device",
            scopeKey: "owner-from-server",
            displayName: "Test Mac",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        let session = stubSession { request in
            XCTAssertEqual(
                request.url?.absoluteString,
                "https://shannon.example/companion/v1/threads?scopeKey=owner-from-server"
            )
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(bearer)")
            return try response(url: request.url!, json: ["threads": []])
        }
        let model = ShannonConnectionModel(baseURL: baseURL, store: store, session: session)

        let verified = await model.verifyConnection()
        XCTAssertTrue(verified)
        XCTAssertEqual(model.status, .connected(deviceName: "Test Mac"))
        XCTAssertEqual(model.verificationLabel, "通信確認済み")
        guard case .verified = model.verificationStatus else {
            return XCTFail("Successful authenticated request must be visible as verified")
        }
    }

    func testConnectionVerificationRemovesRevokedCredential() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: String(repeating: "r", count: 43),
            deviceID: "revoked-device",
            scopeKey: "owner-from-server",
            displayName: "Revoked Mac",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        let session = stubSession { request in
            let rejected = try XCTUnwrap(HTTPURLResponse(
                url: request.url!,
                statusCode: 401,
                httpVersion: "HTTP/1.1",
                headerFields: ["content-type": "application/json"]
            ))
            return (rejected, Data("{}".utf8))
        }
        let model = ShannonConnectionModel(baseURL: baseURL, store: store, session: session)

        let verified = await model.verifyConnection()
        XCTAssertFalse(verified)
        XCTAssertNil(try store.load())
        guard case .failed(let message) = model.verificationStatus else {
            return XCTFail("Revoked credential must be shown as a verification failure")
        }
        XCTAssertTrue(message.contains("無効"))
    }

    func testAPIClientSendsWebSearchOnlyWhenExplicitlyEnabled() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let session = stubSession { request in
            let body = try XCTUnwrap(requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["message"] as? String, "今日の情報を調べて")
            XCTAssertEqual(json["webSearch"] as? Bool, true)
            return try response(url: request.url!, json: chatResponseJSON())
        }
        let client = ShannonAPIClient(baseURL: baseURL, session: session)

        _ = try await client.send(
            message: "今日の情報を調べて",
            scopeKey: "local-owner",
            threadId: nil,
            attachments: [],
            webSearch: true
        )
    }

    func testAPIClientUploadsVoiceFileWithPairedDeviceCredential() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let bearer = String(repeating: "v", count: 43)
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: bearer,
            deviceID: "device-voice",
            scopeKey: "owner-from-server",
            displayName: "Test iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("ShannonVoiceUploadTests-\(UUID().uuidString).m4a")
        try Data([1, 2, 3, 4]).write(to: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL) }
        let session = stubSession { request in
            XCTAssertEqual(request.url?.absoluteString, "https://shannon.example/companion/v1/voice/transcriptions")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(bearer)")
            XCTAssertEqual(request.value(forHTTPHeaderField: "content-type"), "audio/mp4")
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-shannon-audio-duration-ms"), "1250")
            return try response(url: request.url!, json: [
                "transcript": "今日は散歩に行きたい",
                "model": "gpt-transcribe",
                "durationSeconds": 1.25,
                "estimatedCostUsd": 0.00009375,
            ])
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        let result = try await client.transcribeVoice(
            scopeKey: "untrusted-client-scope",
            recording: ShannonVoiceRecording(fileURL: fileURL, durationMilliseconds: 1_250)
        )

        XCTAssertEqual(result.transcript, "今日は散歩に行きたい")
        XCTAssertEqual(result.model, "gpt-transcribe")
    }

    func testAPIClientRequestsGeminiSpeechWithoutSendingAProviderKey() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let bearer = String(repeating: "g", count: 43)
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: bearer,
            deviceID: "device-gemini",
            scopeKey: "owner-from-server",
            displayName: "Test iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        let wav = Data("RIFF0000WAVEfmt data".utf8)
        let session = stubSession { request in
            XCTAssertEqual(request.url?.absoluteString, "https://shannon.example/companion/v1/voice/gemini/speech")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(bearer)")
            XCTAssertNil(request.value(forHTTPHeaderField: "x-goog-api-key"))
            let body = try XCTUnwrap(requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
            XCTAssertEqual(json["text"], "おかえりなさい。")
            guard let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: [
                    "content-type": "audio/wav",
                    "x-shannon-gemini-model": "gemini-3.8-flash-lite-tts",
                    "x-shannon-gemini-voice": "Leda",
                    "x-shannon-audio-duration-seconds": "1.250",
                    "x-shannon-estimated-cost-usd": "0.00018750",
                ]
            ) else { throw ShannonAPIError.invalidResponse }
            return (response, wav)
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        let speech = try await client.synthesizeGeminiSpeech(
            scopeKey: "untrusted-client-scope",
            text: "おかえりなさい。"
        )

        XCTAssertEqual(speech.audio, wav)
        XCTAssertEqual(speech.model, "gemini-3.8-flash-lite-tts")
        XCTAssertEqual(speech.voice, "Leda")
        XCTAssertEqual(speech.durationSeconds, 1.25)
        XCTAssertEqual(speech.estimatedCostUsd, 0.0001875)
    }

    func testAPIClientCreatesRealtimeCallAndCommitsTheVisibleTranscript() async throws {
        let previousBrightness = UserDefaults.standard.object(
            forKey: ShannonRemoteVoicePitchPolicy.enabledDefaultsKey
        )
        UserDefaults.standard.set(true, forKey: ShannonRemoteVoicePitchPolicy.enabledDefaultsKey)
        defer {
            if let previousBrightness {
                UserDefaults.standard.set(
                    previousBrightness,
                    forKey: ShannonRemoteVoicePitchPolicy.enabledDefaultsKey
                )
            } else {
                UserDefaults.standard.removeObject(
                    forKey: ShannonRemoteVoicePitchPolicy.enabledDefaultsKey
                )
            }
        }
        let baseURL = URL(string: "https://shannon.example/companion")!
        let bearer = String(repeating: "r", count: 43)
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: bearer,
            deviceID: "device-realtime",
            scopeKey: "owner-from-server",
            displayName: "Test iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        var requestCount = 0
        let session = stubSession { request in
            requestCount += 1
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(bearer)")
            if request.url?.path.hasSuffix("/v1/voice/realtime/calls") == true {
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.value(forHTTPHeaderField: "content-type"), "application/sdp")
                XCTAssertEqual(request.value(forHTTPHeaderField: "x-shannon-thread-id"), "thread-voice")
                XCTAssertEqual(request.value(forHTTPHeaderField: "x-shannon-voice-participant-mode"), "owner")
                XCTAssertEqual(request.value(forHTTPHeaderField: "x-shannon-voice-brightness"), "enabled")
                XCTAssertTrue(String(data: try XCTUnwrap(requestBody(request)), encoding: .utf8)?.hasPrefix("v=0") == true)
                let response = try XCTUnwrap(HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                    headerFields: [
                        "content-type": "application/sdp",
                        "x-shannon-thread-id": "thread-voice",
                        "x-shannon-voice-engine": "live",
                        "x-shannon-realtime-model": "gpt-live-1",
                        "x-shannon-realtime-daily-remaining-seconds": "3000",
                    ]
                ))
                return (response, Data("v=0\r\ns=answer\r\n".utf8))
            }
            XCTAssertTrue(request.url?.path.hasSuffix("/v1/voice/realtime/turns") == true)
            let body = try XCTUnwrap(requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["scopeKey"] as? String, "owner-from-server")
            XCTAssertEqual(json["threadId"] as? String, "thread-voice")
            XCTAssertEqual(json["userTranscript"] as? String, "散歩したい")
            XCTAssertEqual(json["shannonTranscript"] as? String, "朝がよさそう。")
            return try response(url: request.url!, json: realtimeTurnResponseJSON())
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        let call = try await client.createRealtimeVoiceCall(
            scopeKey: "untrusted-client-scope", threadId: "thread-voice",
            offerSDP: "v=0\r\ns=offer with enough bytes\r\n",
            participantMode: .owner
        )
        XCTAssertEqual(call.threadID, "thread-voice")
        XCTAssertEqual(call.engine, .live)
        XCTAssertEqual(call.model, "gpt-live-1")
        XCTAssertEqual(call.dailyRemainingSeconds, 3_000)

        let turn = try await client.commitRealtimeVoiceTurn(
            scopeKey: "untrusted-client-scope", threadId: call.threadID,
            userTranscript: "散歩したい", shannonTranscript: "朝がよさそう。"
        )
        XCTAssertEqual(turn.threadId, "thread-voice")
        XCTAssertEqual(requestCount, 2)
    }

    func testAPIClientReturnsLiveDelegationResultToTheCurrentVoiceThread() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let bearer = String(repeating: "l", count: 43)
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: bearer,
            deviceID: "device-live",
            scopeKey: "owner-from-server",
            displayName: "Travel iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        let session = stubSession { request in
            XCTAssertTrue(request.url?.path.hasSuffix("/v1/voice/live/delegations") == true)
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(bearer)")
            let body = try XCTUnwrap(requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["scopeKey"] as? String, "owner-from-server")
            XCTAssertEqual(json["threadId"] as? String, "thread-travel")
            XCTAssertEqual(json["transcript"] as? String, "浜松の天気を調べて")
            XCTAssertEqual(json["participantMode"] as? String, "guest")
            let context = try XCTUnwrap(json["deviceContext"] as? [String: Any])
            XCTAssertEqual(context["timeZoneIdentifier"] as? String, "Asia/Tokyo")
            XCTAssertEqual(context["requestedLocation"] as? Bool, true)
            let location = try XCTUnwrap(context["location"] as? [String: Any])
            XCTAssertEqual(location["latitude"] as? Double, 34.7038)
            return try response(url: request.url!, json: [
                "threadId": "thread-travel",
                "model": "gpt-5.6-luna",
                "reply": "午後は雨の可能性があります。",
                "webSources": [],
            ])
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        let result = try await client.performLiveVoiceDelegation(
            scopeKey: "untrusted-client-scope",
            threadId: "thread-travel",
            transcript: "浜松の天気を調べて",
            participantMode: .guest,
            deviceContext: ShannonVoiceDeviceContextDTO(
                timeZoneIdentifier: "Asia/Tokyo",
                requestedLocation: true,
                location: ShannonVoiceDeviceLocationDTO(
                    latitude: 34.7038,
                    longitude: 137.7346,
                    accuracyMeters: 24,
                    observedAt: "2026-09-22T01:37:55Z"
                )
            )
        )

        XCTAssertEqual(result.threadId, "thread-travel")
        XCTAssertEqual(result.reply, "午後は雨の可能性があります。")
    }

    func testAPIClientSharesOneCameraSnapshotWithTheCurrentLiveVoiceThread() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let bearer = String(repeating: "v", count: 43)
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: bearer,
            deviceID: "device-camera",
            scopeKey: "owner-from-server",
            displayName: "Travel iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        let jpegData = Data(repeating: 0x7A, count: 256)
        let session = stubSession { request in
            XCTAssertTrue(request.url?.path.hasSuffix("/v1/voice/vision/snapshots") == true)
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(bearer)")
            XCTAssertEqual(request.value(forHTTPHeaderField: "content-type"), "image/jpeg")
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-shannon-thread-id"), "thread-travel")
            XCTAssertEqual(requestBody(request), jpegData)
            return try response(url: request.url!, json: [
                "threadId": "thread-travel",
                "model": "gpt-5.6-luna",
                "description": "青い案内板と歩道が見えます。",
            ])
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        let result = try await client.analyzeVoiceCameraSnapshot(
            scopeKey: "untrusted-client-scope",
            threadId: "thread-travel",
            jpegData: jpegData
        )

        XCTAssertEqual(result.threadId, "thread-travel")
        XCTAssertEqual(result.description, "青い案内板と歩道が見えます。")
    }

    func testAPIClientPreservesRealtimeAllowanceRejectionCode() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let bearer = String(repeating: "r", count: 43)
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: bearer,
            deviceID: "device-voice-budget",
            scopeKey: "owner-from-server",
            displayName: "Test iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        let session = stubSession { request in
            let response = try XCTUnwrap(HTTPURLResponse(
                url: request.url!, statusCode: 429, httpVersion: "HTTP/1.1",
                headerFields: ["content-type": "application/json"]
            ))
            return (
                response,
                Data(#"{"error":"VOICE_REALTIME_DAILY_ALLOWANCE_EXHAUSTED","message":"ignored"}"#.utf8)
            )
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        do {
            _ = try await client.createRealtimeVoiceCall(
                scopeKey: "untrusted-client-scope",
                threadId: nil,
                offerSDP: "v=0\r\ns=offer with enough bytes\r\n",
                participantMode: .owner
            )
            XCTFail("Expected the daily allowance rejection")
        } catch {
            XCTAssertEqual(
                error as? ShannonAPIError,
                .realtimeVoiceRejected(
                    status: 429,
                    code: "VOICE_REALTIME_DAILY_ALLOWANCE_EXHAUSTED"
                )
            )
        }
    }

    func testAPIClientRegistersAPNsTokenWithPairedDeviceCredential() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let bearer = String(repeating: "p", count: 43)
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: bearer,
            deviceID: "device-push",
            scopeKey: "owner-from-server",
            displayName: "Test iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        let session = stubSession { request in
            XCTAssertEqual(request.url?.absoluteString, "https://shannon.example/companion/v1/push/register")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(bearer)")
            let body = try XCTUnwrap(requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
            XCTAssertEqual(json["deviceToken"], String(repeating: "ab", count: 32))
            XCTAssertEqual(json["environment"], "sandbox")
            return try response(url: request.url!, json: ["registered": true])
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        try await client.registerPushToken(
            scopeKey: "untrusted-client-scope",
            deviceToken: String(repeating: "ab", count: 32),
            environment: .sandbox
        )
    }

    func testAPIClientLoadsTestFlightDeliveryHistoryWithPairedDeviceCredential() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let bearer = String(repeating: "u", count: 43)
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: bearer,
            deviceID: "device-update",
            scopeKey: "owner-from-server",
            displayName: "Test iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        let session = stubSession { request in
            XCTAssertEqual(
                request.url?.absoluteString,
                "https://shannon.example/companion/v1/testflight/delivery?scopeKey=owner-from-server"
            )
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(bearer)")
            return try response(url: request.url!, json: [
                "condition": "healthy",
                "latestBuildVersion": "17",
                "lastCheckedAt": "2026-09-05T04:00:00.000Z",
                "activeFailureCode": NSNull(),
                "history": [[
                    "id": "run-1",
                    "status": "distributed",
                    "buildVersion": "17",
                    "checkedAt": "2026-09-05T04:00:00.000Z",
                    "failureCode": NSNull(),
                    "notificationStatus": "not-needed",
                ]],
            ])
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        let dashboard = try await client.loadTestFlightDelivery(scopeKey: "untrusted-client-scope")

        XCTAssertEqual(dashboard.condition, .healthy)
        XCTAssertEqual(dashboard.latestBuildVersion, "17")
        XCTAssertEqual(dashboard.history.first?.status, .distributed)
    }

    func testAPIClientCreatesAgentTaskAndMapsTheServerProjection() async throws {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let bearer = String(repeating: "t", count: 43)
        let store = MemoryConnectionStore(credential: ShannonConnectionCredential(
            baseURL: baseURL,
            token: bearer,
            deviceID: "device-task",
            scopeKey: "owner-from-server",
            displayName: "Test iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        ))
        var localTask = ShannonAgentTaskFixtures.proposed(threadID: "thread-a")
        localTask.hostHint = "shannon-cloud"
        localTask.projectHint = "shannon-ios"
        localTask.model = "gpt-5.6-sol"
        localTask.reasoningEffort = .high
        let session = stubSession { request in
            XCTAssertEqual(request.url?.absoluteString, "https://shannon.example/companion/v1/agent/tasks")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(bearer)")
            let body = try XCTUnwrap(requestBody(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["scopeKey"] as? String, "owner-from-server")
            XCTAssertEqual(json["taskId"] as? String, localTask.id.uuidString)
            XCTAssertEqual(json["idempotencyKey"] as? String, "stable-start-key")
            XCTAssertEqual(json["hostHint"] as? String, "shannon-cloud")
            XCTAssertEqual(json["projectHint"] as? String, "shannon-ios")
            XCTAssertEqual(json["model"] as? String, "gpt-5.6-sol")
            XCTAssertEqual(json["reasoningEffort"] as? String, "high")
            return try response(url: request.url!, json: agentTaskEnvelopeJSON(id: localTask.id))
        }
        let client = ShannonAPIClient(baseURL: baseURL, connectionStore: store, session: session)

        let task = try await client.createAgentTask(
            scopeKey: "untrusted-client-scope",
            task: localTask,
            idempotencyKey: "stable-start-key"
        )

        XCTAssertEqual(task.id, localTask.id)
        XCTAssertEqual(task.status, .queued)
        XCTAssertEqual(task.timeline.first?.sequence, 1)
        XCTAssertEqual(task.timeline.first?.title, "作業を受け付けた")
    }

    func testExpiredOrDifferentServerCredentialIsNotConnected() throws {
        let stored = ShannonConnectionCredential(
            baseURL: URL(string: "https://old.example")!,
            token: String(repeating: "c", count: 43),
            deviceID: "device-3",
            scopeKey: "owner",
            displayName: "Old iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        )
        let model = ShannonConnectionModel(
            baseURL: URL(string: "https://new.example")!,
            store: MemoryConnectionStore(credential: stored)
        )
        XCTAssertFalse(model.isConnected)
        XCTAssertEqual(model.status, .disconnected)
    }

    func testInvalidCodeNeverStartsNetworkPairing() async {
        let model = ShannonConnectionModel(
            baseURL: URL(string: "https://shannon.example")!,
            store: MemoryConnectionStore()
        )
        let connected = await model.pair(code: "short")
        XCTAssertFalse(connected)
        guard case .failed(let message) = model.status else {
            return XCTFail("Invalid code must fail locally")
        }
        XCTAssertTrue(message.contains("正しく"))
    }

    func testConnectionLinkAcceptsOnlyShannonConnectURLs() async {
        XCTAssertEqual(
            ShannonConnectionModel.pairingCode(from: URL(string: "shannon://connect?code=abcd-EF12-3456")!),
            "ABCDEF123456"
        )
        XCTAssertNil(ShannonConnectionModel.pairingCode(from: URL(string: "https://example.com/connect?code=ABCDEF123456")!))
        XCTAssertNil(ShannonConnectionModel.pairingCode(from: URL(string: "shannon://other?code=ABCDEF123456")!))
        XCTAssertNil(ShannonConnectionModel.pairingCode(from: URL(string: "shannon://connect?code=short")!))
    }

    func testProvisioningDoesNotReplaceAnExistingConnection() async {
        let baseURL = URL(string: "https://shannon.example/companion")!
        let original = ShannonConnectionCredential(
            baseURL: baseURL,
            token: String(repeating: "d", count: 43),
            deviceID: "existing-device",
            scopeKey: "owner",
            displayName: "Existing iPhone",
            expiresAt: Date(timeIntervalSinceNow: 3_600)
        )
        let store = MemoryConnectionStore(credential: original)
        let session = stubSession { _ in
            XCTFail("An existing Keychain connection must not be paired again")
            throw ShannonConnectionError.invalidResponse
        }
        let model = ShannonConnectionModel(baseURL: baseURL, store: store, session: session)

        let connected = await model.pair(code: "ABCD-EF12-3456")
        XCTAssertTrue(connected)
        XCTAssertEqual(try? store.load(), original)
    }
}

private final class MemoryConnectionStore: ShannonConnectionStoreProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var credential: ShannonConnectionCredential?

    init(credential: ShannonConnectionCredential? = nil) {
        self.credential = credential
    }

    func load() throws -> ShannonConnectionCredential? {
        lock.withLock { credential }
    }

    func save(_ credential: ShannonConnectionCredential) throws {
        lock.withLock { self.credential = credential }
    }

    func delete() throws {
        lock.withLock { credential = nil }
    }
}

private final class URLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: ShannonConnectionError.invalidResponse)
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@MainActor
private func stubSession(
    handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
) -> URLSession {
    URLProtocolStub.handler = handler
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolStub.self]
    return URLSession(configuration: configuration)
}

private func response(url: URL, json: [String: Any]) throws -> (HTTPURLResponse, Data) {
    let response = try XCTUnwrap(HTTPURLResponse(
        url: url,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["content-type": "application/json"]
    ))
    return (response, try JSONSerialization.data(withJSONObject: json))
}

private func requestBody(_ request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 1_024)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        result.append(buffer, count: count)
    }
    return result
}

private func chatResponseJSON() -> [String: Any] {
        [
        "mode": "local-stub",
        "reply": "こんにちは",
        "threadId": "test-thread-id",
        "snapshotVersion": 0,
        "messageEmotion": [
            "valence": 0,
            "arousal": 0.3,
            "openness": 0.35,
            "expression": "calm",
        ],
        "systemPrompt": "prompt",
        "state": [
            "scopeKey": "owner-from-server",
            "version": 0,
            "updatedAt": "2026-08-31T00:00:00.000Z",
            "temperament": [
                "curiosity": 0.65,
                "initiative": 0.25,
                "closeness": 0.15,
                "calmness": 0.60,
                "needForContinuity": 0.70,
                "confidenceAboutUser": 0.05,
            ],
            "emotion": ["valence": 0, "arousal": 0.3, "openness": 0.35],
            "interests": [],
            "userFacts": [],
            "activeMemories": [],
        ],
    ]
}

private func voiceIdentityResponseJSON() -> [String: Any] {
    [
        "preference": [
            "mode": "manual",
            "selectedVoice": "cedar",
            "effectiveVoice": "cedar",
            "updatedAt": "2026-09-11T01:10:00.000Z",
        ],
        "candidates": [
            ["id": "marin", "name": "Marin"],
            ["id": "cedar", "name": "Cedar"],
            ["id": "coral", "name": "Coral"],
        ],
    ]
}

private func worldSubscriptionJSON() -> [String: Any] {
    [
        "id": "feed-1",
        "feedURL": "https://example.com/feed.xml",
        "title": "Example",
        "status": "paused",
        "approval": "pending",
        "reason": "Hacker Newsから見つけた",
        "discoveredAt": "2026-09-11T00:00:00.000Z",
        "trialExpiresAt": "2026-09-18T00:00:00.000Z",
        "fetchedItemCount": 0,
        "updatedAt": "before",
    ]
}

private func worldSourceJSON() -> [String: Any] {
    [
        "id": "hn:top",
        "kind": "hacker-news",
        "title": "Hacker News",
        "url": "https://news.ycombinator.com/",
        "enabled": true,
        "intervalMinutes": 360,
        "lastRunAt": "2026-09-11T00:00:00.000Z",
        "nextRunAt": "2026-09-11T06:00:00.000Z",
        "hasError": false,
        "fetchedItemCount": 12,
        "origin": "built-in",
    ]
}

private func agentTaskEnvelopeJSON(id: UUID) -> [String: Any] {
    [
        "created": true,
        "task": [
            "id": id.uuidString,
            "conversationThreadID": "thread-a",
            "title": "ログイン障害を調査・修正",
            "goal": "会話履歴を保持したまま接続失敗を解消する",
            "status": "queued",
            "summary": "作業をお願いしているところ。",
            "plan": [],
            "timeline": [[
                "id": UUID().uuidString,
                "sequence": 1,
                "title": "作業を受け付けた",
                "occurredAt": "2026-09-04T00:00:00.000Z",
                "tone": "neutral",
            ]],
            "changes": [],
            "tests": [],
            "createdAt": "2026-09-04T00:00:00.000Z",
            "updatedAt": "2026-09-04T00:00:00.000Z",
            "latestSequence": 1,
        ],
    ]
}

private func realtimeTurnResponseJSON() -> [String: Any] {
    [
        "threadId": "thread-voice",
        "messageEmotion": [
            "valence": 0.2,
            "arousal": 0.3,
            "openness": 0.4,
            "expression": "curious",
        ],
        "state": chatResponseJSON()["state"] as Any,
    ]
}
