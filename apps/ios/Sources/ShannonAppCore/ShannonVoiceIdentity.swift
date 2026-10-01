import AVFoundation
import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
public final class ShannonVoiceIdentityModel {
    public private(set) var response = ShannonVoiceIdentityResponseDTO(
        preference: ShannonVoiceIdentityPreferenceDTO(
            mode: .automatic,
            selectedVoice: nil,
            effectiveVoice: "marin",
            updatedAt: nil
        ),
        candidates: [
            ShannonVoiceCandidateDTO(id: "marin", name: "Marin"),
            ShannonVoiceCandidateDTO(id: "cedar", name: "Cedar"),
            ShannonVoiceCandidateDTO(id: "coral", name: "Coral"),
        ]
    )
    public private(set) var isLoading = false
    public private(set) var savingVoiceID: String?
    public private(set) var previewingVoiceID: String?
    public private(set) var errorMessage: String?
    public private(set) var allowance: ShannonRealtimeVoiceAllowanceDTO?
    public private(set) var isAllowanceLoading = false
    public private(set) var isAllowanceExtending = false
    public private(set) var allowanceErrorMessage: String?

    private let scopeKey: String
    private let client: any ShannonVoiceServing
    private var player: AVAudioPlayer?
    private var playbackToken: UUID?
    private var previewAudioByVoiceID: [String: Data] = [:]
    private var stateGeneration = 0
    private var previewAudioSessionActive = false

    public init(
        scopeKey: String = "local-owner",
        client: any ShannonVoiceServing = ShannonAPIClient()
    ) {
        self.scopeKey = scopeKey
        self.client = client
    }

    public var summary: String {
        if response.preference.mode == .automatic { return response.preference.mode.japaneseName }
        return response.candidates.first(where: { $0.id == response.preference.effectiveVoice })?.name
            ?? response.preference.effectiveVoice
    }

    public var allowanceRemainingText: String {
        guard let allowance else { return "確認できません" }
        return "約\(max(0, allowance.remainingSeconds) / 60)分"
    }

    public var allowanceDetailText: String {
        guard let allowance else { return "" }
        let baseMinutes = allowance.baseAllowanceSeconds / 60
        let additionalMinutes = allowance.additionalAllowanceSeconds / 60
        return additionalMinutes > 0
            ? "通常\(baseMinutes)分 + 本日の追加\(additionalMinutes)分"
            : "通常\(baseMinutes)分"
    }

    public var canExtendAllowance: Bool {
        guard let allowance else { return false }
        return allowance.totalAllowanceSeconds + 60 * 60 <= allowance.maximumAllowanceSeconds
    }

    public func reload() async {
        guard !isLoading, savingVoiceID == nil else { return }
        let generation = stateGeneration
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let loaded = try await client.loadVoiceIdentity(scopeKey: scopeKey)
            guard stateGeneration == generation else { return }
            response = loaded
        } catch {
            guard stateGeneration == generation else { return }
            errorMessage = "声の設定を読み込めませんでした。接続を確認してください。"
        }
    }

    public func selectAutomatic() async {
        await save(mode: .automatic, voiceID: nil)
    }

    public func reloadAllowance() async {
        guard !isAllowanceLoading, !isAllowanceExtending else { return }
        isAllowanceLoading = true
        allowanceErrorMessage = nil
        defer { isAllowanceLoading = false }
        do {
            allowance = try await client.loadRealtimeVoiceAllowance(scopeKey: scopeKey)
        } catch {
            allowanceErrorMessage = "本日のライブ音声枠を確認できませんでした。"
        }
    }

    public func extendAllowance() async {
        guard !isAllowanceExtending else { return }
        isAllowanceExtending = true
        allowanceErrorMessage = nil
        defer { isAllowanceExtending = false }
        do {
            allowance = try await client.extendRealtimeVoiceAllowance(scopeKey: scopeKey)
        } catch {
            allowanceErrorMessage = "ライブ音声枠を追加できませんでした。少し待ってもう一度お試しください。"
        }
    }

    public func select(_ candidate: ShannonVoiceCandidateDTO) async {
        await save(mode: .manual, voiceID: candidate.id)
    }

    public func togglePreview(_ candidate: ShannonVoiceCandidateDTO) async {
        if previewingVoiceID == candidate.id {
            stopPreview()
            return
        }
        stopPreview()
        let token = UUID()
        playbackToken = token
        previewingVoiceID = candidate.id
        errorMessage = nil
        do {
            let data: Data
            if let cached = previewAudioByVoiceID[candidate.id] {
                data = cached
            } else {
                data = try await client.loadVoicePreview(scopeKey: scopeKey, voice: candidate.id)
                previewAudioByVoiceID[candidate.id] = data
            }
            guard playbackToken == token, previewingVoiceID == candidate.id else { return }
#if os(iOS)
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
            previewAudioSessionActive = true
#endif
            let nextPlayer = try AVAudioPlayer(data: data)
            nextPlayer.prepareToPlay()
            guard nextPlayer.play() else { throw ShannonAPIError.invalidResponse }
            player = nextPlayer
            let duration = max(nextPlayer.duration, 0.1)
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(duration + 0.1))
                guard self?.playbackToken == token else { return }
                self?.stopPreview()
            }
        } catch {
            guard playbackToken == token else { return }
            stopPreview()
            errorMessage = "声を試聴できませんでした。少し待ってもう一度お試しください。"
        }
    }

    public func stopPreview() {
        player?.stop()
        player = nil
#if os(iOS)
        if previewAudioSessionActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            previewAudioSessionActive = false
        }
#endif
        playbackToken = nil
        previewingVoiceID = nil
    }

    public func dismissError() {
        errorMessage = nil
    }

    private func save(mode: ShannonVoiceIdentityModeDTO, voiceID: String?) async {
        guard savingVoiceID == nil else { return }
        stateGeneration += 1
        let generation = stateGeneration
        savingVoiceID = voiceID ?? "automatic"
        errorMessage = nil
        defer { savingVoiceID = nil }
        do {
            let updated = try await client.updateVoiceIdentity(
                scopeKey: scopeKey,
                mode: mode,
                selectedVoice: voiceID
            )
            guard stateGeneration == generation else { return }
            response = updated
        } catch {
            guard stateGeneration == generation else { return }
            errorMessage = "声の設定を保存できませんでした。接続を確認してください。"
        }
    }
}
