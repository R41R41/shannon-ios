import XCTest
@testable import ShannonAppCore

@MainActor
final class ShannonVoiceIdentityModelTests: XCTestCase {
    func testLoadsAndSavesTheSharedVoiceChoice() async {
        let initial = response(mode: .automatic, selectedVoice: nil, effectiveVoice: "marin")
        let selected = response(mode: .manual, selectedVoice: "cedar", effectiveVoice: "cedar")
        let client = VoiceIdentityClient(loadResponse: initial, updateResponse: selected)
        let model = ShannonVoiceIdentityModel(scopeKey: "owner-a", client: client)

        await model.reload()
        XCTAssertEqual(model.summary, "シャノンに任せる")

        await model.select(ShannonVoiceCandidateDTO(id: "cedar", name: "Cedar"))
        XCTAssertEqual(model.response.preference.selectedVoice, "cedar")
        XCTAssertEqual(model.summary, "Cedar")
        let update = await client.lastUpdate
        XCTAssertEqual(update?.scopeKey, "owner-a")
        XCTAssertEqual(update?.mode, .manual)
        XCTAssertEqual(update?.selectedVoice, "cedar")
    }

    func testKeepsTheLastKnownChoiceWhenSavingFails() async {
        let initial = response(mode: .manual, selectedVoice: "coral", effectiveVoice: "coral")
        let client = VoiceIdentityClient(
            loadResponse: initial,
            updateResponse: initial,
            updateError: VoiceIdentityTestError.failed
        )
        let model = ShannonVoiceIdentityModel(client: client)
        await model.reload()

        await model.selectAutomatic()

        XCTAssertEqual(model.response.preference.selectedVoice, "coral")
        XCTAssertEqual(model.summary, "Coral")
        XCTAssertEqual(model.errorMessage, "声の設定を保存できませんでした。接続を確認してください。")
    }

    func testASelectionWinsWhenAnEarlierReloadFinishesLate() async {
        let stale = response(mode: .automatic, selectedVoice: nil, effectiveVoice: "marin")
        let selected = response(mode: .manual, selectedVoice: "cedar", effectiveVoice: "cedar")
        let client = DelayedVoiceIdentityClient(loadResponse: stale, updateResponse: selected)
        let model = ShannonVoiceIdentityModel(client: client)

        let reload = Task { await model.reload() }
        while !(await client.hasPendingLoad()) { await Task.yield() }
        await model.select(ShannonVoiceCandidateDTO(id: "cedar", name: "Cedar"))
        await client.finishLoad()
        await reload.value

        XCTAssertEqual(model.response.preference.selectedVoice, "cedar")
        XCTAssertEqual(model.summary, "Cedar")
        XCTAssertNil(model.errorMessage)
    }
}

private func response(
    mode: ShannonVoiceIdentityModeDTO,
    selectedVoice: String?,
    effectiveVoice: String
) -> ShannonVoiceIdentityResponseDTO {
    ShannonVoiceIdentityResponseDTO(
        preference: ShannonVoiceIdentityPreferenceDTO(
            mode: mode,
            selectedVoice: selectedVoice,
            effectiveVoice: effectiveVoice,
            updatedAt: "2026-09-11T01:10:00.000Z"
        ),
        candidates: [
            ShannonVoiceCandidateDTO(id: "marin", name: "Marin"),
            ShannonVoiceCandidateDTO(id: "cedar", name: "Cedar"),
            ShannonVoiceCandidateDTO(id: "coral", name: "Coral"),
        ]
    )
}

private actor VoiceIdentityClient: ShannonAPIClientProtocol {
    let loadResponse: ShannonVoiceIdentityResponseDTO
    let updateResponse: ShannonVoiceIdentityResponseDTO
    let updateError: (any Error)?
    private(set) var lastUpdate: ShannonVoiceIdentityUpdateRequestDTO?

    init(
        loadResponse: ShannonVoiceIdentityResponseDTO,
        updateResponse: ShannonVoiceIdentityResponseDTO,
        updateError: (any Error)? = nil
    ) {
        self.loadResponse = loadResponse
        self.updateResponse = updateResponse
        self.updateError = updateError
    }

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        throw VoiceIdentityTestError.failed
    }

    func loadVoiceIdentity(scopeKey: String) async throws -> ShannonVoiceIdentityResponseDTO {
        loadResponse
    }

    func updateVoiceIdentity(
        scopeKey: String,
        mode: ShannonVoiceIdentityModeDTO,
        selectedVoice: String?
    ) async throws -> ShannonVoiceIdentityResponseDTO {
        if let updateError { throw updateError }
        lastUpdate = ShannonVoiceIdentityUpdateRequestDTO(
            scopeKey: scopeKey,
            mode: mode,
            selectedVoice: selectedVoice
        )
        return updateResponse
    }
}

private actor DelayedVoiceIdentityClient: ShannonAPIClientProtocol {
    let loadResponse: ShannonVoiceIdentityResponseDTO
    let updateResponse: ShannonVoiceIdentityResponseDTO
    private var loadContinuation: CheckedContinuation<ShannonVoiceIdentityResponseDTO, any Error>?

    init(loadResponse: ShannonVoiceIdentityResponseDTO, updateResponse: ShannonVoiceIdentityResponseDTO) {
        self.loadResponse = loadResponse
        self.updateResponse = updateResponse
    }

    func send(message: String, scopeKey: String, threadId: String?) async throws -> ChatResponseDTO {
        throw VoiceIdentityTestError.failed
    }

    func loadVoiceIdentity(scopeKey: String) async throws -> ShannonVoiceIdentityResponseDTO {
        try await withCheckedThrowingContinuation { continuation in
            loadContinuation = continuation
        }
    }

    func updateVoiceIdentity(
        scopeKey: String,
        mode: ShannonVoiceIdentityModeDTO,
        selectedVoice: String?
    ) async throws -> ShannonVoiceIdentityResponseDTO {
        updateResponse
    }

    func hasPendingLoad() -> Bool {
        loadContinuation != nil
    }

    func finishLoad() {
        loadContinuation?.resume(returning: loadResponse)
        loadContinuation = nil
    }
}

private enum VoiceIdentityTestError: Error { case failed }
