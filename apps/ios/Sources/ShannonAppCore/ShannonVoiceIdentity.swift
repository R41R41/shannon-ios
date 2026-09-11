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

    private let scopeKey: String
    private let client: any ShannonAPIClientProtocol
    private var player: AVAudioPlayer?
    private var playbackToken: UUID?
    private var previewAudioByVoiceID: [String: Data] = [:]
    private var stateGeneration = 0
    private var previewAudioSessionActive = false

    public init(
        scopeKey: String = "local-owner",
        client: any ShannonAPIClientProtocol = ShannonAPIClient()
    ) {
        self.scopeKey = scopeKey
        self.client = client
    }

    public var summary: String {
        if response.preference.mode == .automatic { return response.preference.mode.japaneseName }
        return response.candidates.first(where: { $0.id == response.preference.effectiveVoice })?.name
            ?? response.preference.effectiveVoice
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

public struct ShannonVoiceIdentityView: View {
    @Bindable private var model: ShannonVoiceIdentityModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    public init(model: ShannonVoiceIdentityModel) {
        self.model = model
    }

    public var body: some View {
        let palette = M3Palette.resolve(colorScheme)
        NavigationStack {
            List {
                Section {
                    Button {
                        Task { await model.selectAutomatic() }
                    } label: {
                        choiceLabel(
                            title: "シャノンに任せる",
                            detail: "おすすめの声を使います",
                            selected: model.response.preference.mode == .automatic,
                            palette: palette
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(model.savingVoiceID != nil)
                }

                Section("声を選ぶ") {
                    ForEach(model.response.candidates) { candidate in
                        HStack(spacing: M3Spacing.medium) {
                            Button {
                                Task { await model.select(candidate) }
                            } label: {
                                choiceLabel(
                                    title: candidate.name,
                                    detail: "次の音声会話から使う",
                                    selected: model.response.preference.mode == .manual
                                        && model.response.preference.selectedVoice == candidate.id,
                                    palette: palette
                                )
                            }
                            .buttonStyle(.plain)
                            .disabled(model.savingVoiceID != nil)

                            Button {
                                Task { await model.togglePreview(candidate) }
                            } label: {
                                Image(systemName: model.previewingVoiceID == candidate.id
                                      ? "stop.fill" : "play.fill")
                                    .font(.system(size: 15, weight: .semibold))
                                    .frame(width: 42, height: 42)
                                    .background(palette.surfaceContainerHigh, in: Circle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(model.previewingVoiceID == candidate.id
                                                ? "\(candidate.name)の試聴を停止"
                                                : "\(candidate.name)を試聴")
                        }
                    }
                }

                Section {
                    Text("声の変更は、接続中の会話を急に変えず、次に始める音声会話から反映されます。選択はiPhoneとMacで共有されます。")
                        .font(.footnote)
                        .foregroundStyle(palette.onSurfaceVariant)
                }

                if let errorMessage = model.errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.surface)
            .navigationTitle("シャノンの声")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完了") { dismiss() }
                }
            }
            .task { await model.reload() }
            .onDisappear { model.stopPreview() }
        }
    }

    private func choiceLabel(
        title: String,
        detail: String,
        selected: Bool,
        palette: M3Palette
    ) -> some View {
        HStack(spacing: M3Spacing.medium) {
            VStack(alignment: .leading, spacing: M3Spacing.extraSmall) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.onSurface)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(palette.onSurfaceVariant)
            }
            Spacer(minLength: M3Spacing.small)
            if selected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(palette.primary)
            }
        }
        .contentShape(Rectangle())
    }
}
