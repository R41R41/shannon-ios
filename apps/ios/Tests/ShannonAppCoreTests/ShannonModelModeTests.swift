import Foundation
import Testing
@testable import ShannonAppCore

@Suite @MainActor
struct ShannonModelModeTests {
    @Test func initialStateDoesNotPretendTheDefaultWasRead() {
        let client = ModelModeFixtureClient()
        let model = client.model()
        #expect(model.snapshot == nil)
        #expect(!model.canChange)
        #expect(model.statusText == "現在の設定は未確認です。")
        #expect(ShannonModelMode.haiku.title == "通常（Haiku 5.5）")
        #expect(ShannonModelMode.sonnet.title == "高精度（Sonnet 5.5）")
    }

    @Test func acknowledgedChoiceIsSharedAndUsesTheOriginalRevision() async {
        let client = ModelModeFixtureClient()
        let first = client.model(), second = client.model()
        await first.reload()
        await first.select(.sonnet)
        #expect(first.snapshot?.mode == .sonnet && first.snapshot?.revision == 1)
        #expect(client.writes.map(\.revision) == [0])
        await second.reload()
        #expect(second.snapshot == first.snapshot)
        #expect(first.snapshot?.applicationLabel == "適用先：会話・自律の計画")
        #expect(first.snapshot?.applicationLabel?.contains("Minecraft") == false)
    }

    @Test func previousSelectionRemainsUntilTheWriteAcknowledgesAndDoubleClickIsFenced() async {
        let client = ModelModeFixtureClient()
        let model = client.model()
        await model.reload()
        client.holdWrite = true
        let change = Task { await model.select(.sonnet) }
        await client.waitForWrites(1)
        #expect(model.isSaving && !model.canChange)
        #expect(model.snapshot?.mode == .haiku)
        await model.select(.sonnet)
        #expect(client.writes.count == 1)
        client.releaseWrite(modeFixture(.sonnet, revision: 1))
        await change.value
        #expect(model.snapshot?.mode == .sonnet && !model.isSaving)
    }

    @Test func lostWriteResponseChecksCurrentStateWithoutClaimingItsOwnReceipt() async {
        let client = ModelModeFixtureClient()
        let model = client.model()
        await model.reload()
        client.lostWrite = true
        await model.select(.sonnet)
        #expect(client.writes.count == 1 && client.readCount == 2)
        #expect(model.snapshot?.mode == .sonnet && !model.needsConfirmation)
        #expect(model.notice == "現在の設定を読み直しました。")
        await model.reload()
        #expect(client.writes.count == 1)
    }

    @Test func uncertainWriteAndOfflineReadKeepPreviousValueAndNeverResend() async {
        let client = ModelModeFixtureClient()
        let model = client.model()
        await model.reload()
        client.lostWrite = true; client.failReadAfterWrite = true
        await model.select(.sonnet)
        #expect(model.snapshot?.mode == .haiku)
        #expect(model.needsConfirmation && !model.canChange && !model.isFresh)
        await model.select(.sonnet)
        #expect(client.writes.count == 1)
        client.readError = nil
        await model.reload() // A later activation uses only GET to reconcile.
        #expect(model.snapshot?.mode == .sonnet && !model.needsConfirmation)
        #expect(client.writes.count == 1)
    }

    @Test func conflictReadsTheNewRevisionAndDoesNotAutomaticallyOverwriteOtherDevice() async {
        let client = ModelModeFixtureClient()
        let model = client.model()
        await model.reload()
        client.snapshot = modeFixture(.haiku, revision: 4)
        await model.select(.sonnet)
        #expect(client.writes.map(\.revision) == [0])
        #expect(model.snapshot?.mode == .haiku && model.snapshot?.revision == 4)
        #expect(model.notice?.contains("変更されませんでした") == true)
        await model.select(.sonnet) // Only this new explicit action may write the new revision.
        #expect(client.writes.map(\.revision) == [0, 4])
        #expect(model.snapshot?.revision == 5)
    }

    @Test func unavailableModeAndUnchangedModeNeverSendAWrite() async {
        let client = ModelModeFixtureClient()
        client.snapshot = modeFixture(sonnetAvailable: false)
        let model = client.model()
        await model.reload()
        await model.select(.sonnet)
        await model.select(.haiku)
        #expect(client.writes.isEmpty)
        #expect(model.snapshot?.isAvailable(.sonnet) == false)
    }

    @Test(arguments: ["gpt-5.6-terra", "claude-haiku-4-5", "local-stub"])
    func configuredOverrideIsNeverPresentedOrChosenAsHaiku55(modelID: String) async {
        let client = ModelModeFixtureClient()
        client.snapshot = ShannonModelModeDTO(mode: .haiku, revision: 0,
            available: .init(haiku: true, sonnet: true),
            models: .init(haiku: modelID, sonnet: "claude-sonnet-5-5"), appliesTo: ["conversation"])
        let model = client.model()
        await model.reload()
        #expect(model.snapshot?.isSelected(.haiku) == false)
        #expect(model.snapshot?.configuredModelLabel == "現在：サーバー指定モデル（\(modelID)）")
        #expect(model.snapshot?.isAvailable(.haiku) == false)
        #expect(model.snapshot?.isAvailable(.sonnet) == true)
        await model.select(.haiku)
        #expect(client.writes.isEmpty)
        await model.select(.sonnet)
        #expect(client.writes.map(\.mode) == [.sonnet])
        #expect(model.snapshot?.isSelected(.sonnet) == true)
        #expect(model.snapshot?.configuredModelLabel == nil)
    }

    @Test func unsupportedServerAndFailedReloadPreservePreviousConfirmedValue() async {
        let client = ModelModeFixtureClient()
        let model = client.model()
        await model.reload()
        client.readError = ShannonModelModeAPIError.rejected(status: 404)
        await model.reload()
        #expect(model.isUnsupported && !model.canChange)
        #expect(model.snapshot?.mode == .haiku && !model.isFresh)
        client.readError = URLError(.notConnectedToInternet)
        await model.reload()
        #expect(model.snapshot?.mode == .haiku && model.notice != nil)
    }

    @Test(arguments: ["scope", "token", "server"])
    func changedCredentialFencesLateRead(kind: String) async {
        let client = ModelModeFixtureClient()
        let model = client.model()
        client.holdReads = true
        let read = Task { await model.reload() }
        await client.waitForReads(1)
        client.credential = modeCredential(scope: kind == "scope" ? "other-owner" : "synthetic",
            token: kind == "token" ? "changed-token" : "synthetic-token",
            server: kind == "server" ? "https://other.invalid/companion" : "https://synthetic.invalid/companion")
        client.releaseRead(1, modeFixture(.sonnet, revision: 5))
        await read.value
        #expect(model.snapshot == nil && !model.canChange)
        #expect(client.writes.isEmpty)
    }

    @Test func lateAcceptedWriteCannotChangeTheNewScopeAndIsNeverResent() async {
        let client = ModelModeFixtureClient()
        let model = client.model()
        await model.reload()
        client.holdWrite = true
        let change = Task { await model.select(.sonnet) }
        await client.waitForWrites(1)
        client.credential = modeCredential(scope: "other-owner")
        model.connectionDidChange()
        client.releaseWrite(modeFixture(.sonnet, revision: 1))
        await change.value
        #expect(model.snapshot == nil && !model.isSaving && !model.canChange)
        #expect(client.writes.count == 1 && client.readCount == 1)
    }

    @Test func newerActivationReadWinsOverAnOlderRead() async {
        let client = ModelModeFixtureClient()
        let model = client.model()
        client.holdReads = true
        let old = Task { await model.reload() }
        await client.waitForReads(1)
        let fresh = Task { await model.reload() }
        await client.waitForReads(2)
        client.releaseRead(2, modeFixture(.sonnet, revision: 2))
        await fresh.value
        client.releaseRead(1, modeFixture(.haiku, revision: 0))
        await old.value
        #expect(model.snapshot?.mode == .sonnet && model.snapshot?.revision == 2 && model.isFresh)
    }

    @Test func cancelledReadNeverPublishesItsLateValue() async {
        let client = ModelModeFixtureClient()
        let model = client.model()
        client.holdReads = true
        let read = Task { await model.reload() }
        await client.waitForReads(1)
        read.cancel()
        client.releaseRead(1, modeFixture(.sonnet, revision: 2))
        await read.value
        #expect(model.snapshot == nil && !model.isLoading && !model.isFresh)
    }

    @Test func malformedSuccessIsUnknownAndReconcilesOnlyThroughRead() async {
        let client = ModelModeFixtureClient()
        let model = client.model()
        await model.reload()
        client.writeResponse = modeFixture(.haiku, revision: 9)
        await model.select(.sonnet)
        #expect(client.writes.count == 1 && client.readCount == 2)
        #expect(model.snapshot?.mode == .sonnet && model.notice == "現在の設定を読み直しました。")
    }

    @Test func rejectedCredentialClearsThePreviousScopeValue() async {
        let client = ModelModeFixtureClient()
        let model = client.model()
        await model.reload()
        client.readError = ShannonModelModeAPIError.rejected(status: 403)
        await model.reload()
        #expect(model.snapshot == nil && !model.canChange && model.notice != nil)
    }

    @Test(arguments: [-1, Int.max])
    func invalidServerRevisionNeverBecomesAnEditableDefault(revision: Int) async {
        let client = ModelModeFixtureClient()
        client.snapshot = modeFixture(revision: revision)
        let model = client.model()
        await model.reload()
        await model.select(.sonnet)
        #expect(model.snapshot == nil && !model.canChange && model.notice != nil)
        #expect(client.writes.isEmpty)
    }

#if DEBUG
    @Test func previewFixturesRecoverThroughTheSameReadOnlyAndCASStateMachine() async throws {
        let failure = ShannonModelModePreview(scopeKey: "synthetic", scenario: .saveerror)
        let previewContext = ShannonModelModeSettingsContext(scopeKey: "synthetic", connection: nil)
        let model = previewContext.makeModel(client: failure)
        await model.reload()
        await model.select(.sonnet)
        #expect(model.needsConfirmation && model.snapshot?.mode == .haiku && !model.canChange)
        await model.reload()
        #expect(!model.needsConfirmation && model.snapshot?.mode == .haiku && model.canChange)
        let conflict = ShannonModelModeModel(scopeKey: "synthetic",
            client: ShannonModelModePreview(scopeKey: "synthetic", scenario: .conflict))
        await conflict.reload()
        await conflict.select(.sonnet)
        #expect(conflict.snapshot?.mode == .haiku && conflict.snapshot?.revision == 2)
        await conflict.select(.sonnet)
        #expect(conflict.snapshot?.mode == .sonnet && conflict.snapshot?.revision == 3)
    }

    @Test func previewScenariosOnlyAcceptKnownClosedArguments() async {
        #expect(ShannonModelModePreview.configured(scopeKey: "synthetic", arguments: []) == nil)
        #expect(ShannonModelModePreview.configured(scopeKey: "synthetic", arguments: ["-ShannonPreviewModelMode", "invalid"]) == nil)
        let client = ShannonModelModePreview.configured(scopeKey: "synthetic", arguments: ["-ShannonPreviewModelMode", "unavailable"])
        let model = ShannonModelModeModel(scopeKey: "synthetic", client: client)
        await model.reload()
        #expect(model.snapshot?.available.sonnet == false)
        await model.select(.sonnet)
        #expect(model.snapshot?.revision == 0 && model.snapshot?.mode == .haiku)
    }
#endif
}

@MainActor private final class ModelModeFixtureClient: ShannonModelModeServing {
    var credential: ShannonConnectionCredential? = modeCredential()
    var snapshot = modeFixture()
    var readCount = 0
    var writes: [(mode: ShannonModelMode, revision: Int)] = []
    var readError: (any Error)?
    var lostWrite = false
    var failReadAfterWrite = false
    var holdReads = false
    var holdWrite = false
    var writeResponse: ShannonModelModeDTO?
    private var reads: [Int: CheckedContinuation<ShannonModelModeDTO, any Error>] = [:]
    private var write: CheckedContinuation<ShannonModelModeDTO, any Error>?

    func model() -> ShannonModelModeModel { ShannonModelModeModel(scopeKey: "synthetic", client: self) }
    func modelModeConnection() -> ShannonModelModeConnection? { credential.map(ShannonModelModeConnection.init) }
    func loadModelMode(connection: ShannonModelModeConnection) async throws -> ShannonModelModeDTO {
        readCount += 1
        if let readError { throw readError }
        if holdReads { return try await withCheckedThrowingContinuation { reads[readCount] = $0 } }
        return snapshot
    }
    func setModelMode(_ mode: ShannonModelMode, expectedRevision: Int, connection: ShannonModelModeConnection) async throws -> ShannonModelModeDTO {
        writes.append((mode, expectedRevision))
        guard snapshot.revision == expectedRevision else { throw ShannonModelModeAPIError.rejected(status: 409) }
        if holdWrite { return try await withCheckedThrowingContinuation { write = $0 } }
        snapshot = modeFixture(mode, revision: expectedRevision + 1)
        if failReadAfterWrite { readError = URLError(.notConnectedToInternet) }
        if lostWrite { throw URLError(.networkConnectionLost) }
        return writeResponse ?? snapshot
    }
    func waitForReads(_ count: Int) async { while readCount < count { await Task.yield() } }
    func waitForWrites(_ count: Int) async { while writes.count < count { await Task.yield() } }
    func releaseRead(_ count: Int, _ value: ShannonModelModeDTO) { reads.removeValue(forKey: count)?.resume(returning: value) }
    func releaseWrite(_ value: ShannonModelModeDTO) { write?.resume(returning: value); write = nil }
}

func modeFixture(_ mode: ShannonModelMode = .haiku, revision: Int = 0, sonnetAvailable: Bool = true) -> ShannonModelModeDTO {
    ShannonModelModeDTO(mode: mode, revision: revision, available: .init(haiku: true, sonnet: sonnetAvailable),
        models: .init(haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5"), appliesTo: ["conversation", "autonomy-planning"])
}

func modeCredential(scope: String = "synthetic", token: String = "synthetic-token",
                    server: String = "https://synthetic.invalid/companion") -> ShannonConnectionCredential {
    ShannonConnectionCredential(baseURL: URL(string: server)!, token: token, deviceID: "synthetic-device",
        scopeKey: scope, displayName: "合成端末", expiresAt: Date(timeIntervalSinceNow: 3600))
}
