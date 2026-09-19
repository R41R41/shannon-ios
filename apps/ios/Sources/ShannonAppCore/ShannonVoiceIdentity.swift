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

public struct ShannonVoiceIdentityView: View {
    @Bindable private var model: ShannonVoiceIdentityModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var confirmsAllowanceExtension = false
#if os(iOS)
    @AppStorage(ShannonRemoteVoicePitchPolicy.enabledDefaultsKey)
    private var remotePitchEnabled = true
#endif

    public init(model: ShannonVoiceIdentityModel) {
        self.model = model
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
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
                        let isPreviewing = model.previewingVoiceID == candidate.id
                        HStack(spacing: ShannonSpacing.medium) {
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
                                Image(systemName: isPreviewing ? "stop.fill" : "play.fill")
                                    .font(.system(size: 15, weight: .semibold))
                                    .frame(width: 42, height: 42)
                                    .background(palette.elevatedSurface, in: Circle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(
                                isPreviewing ? "\(candidate.name)の試聴を停止" : "\(candidate.name)を試聴"
                            )
                        }
                    }
                }

#if os(iOS)
                Section {
                    Toggle(isOn: $remotePitchEnabled) {
                        VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                            Text("明るい声に調整")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(palette.textPrimary)
                            Text("声の種類は変えず、2半音高くします")
                                .font(.caption)
                                .foregroundStyle(palette.textSecondary)
                        }
                    }
                    .accessibilityHint("次に始める音声会話から反映されます")
                } header: {
                    Text("リアルタイム音声の仕上げ")
                } footer: {
                    Text("次の音声会話から、選択中の声を+200 centsで再生します。マイク入力は加工しません。")
                }

                Section {
                    if model.isAllowanceLoading && model.allowance == nil {
                        HStack {
                            Text("本日の残り")
                            Spacer()
                            ProgressView()
                        }
                    } else {
                        LabeledContent("本日の残り", value: model.allowanceRemainingText)
                        if !model.allowanceDetailText.isEmpty {
                            Text(model.allowanceDetailText)
                                .font(.caption)
                                .foregroundStyle(palette.textSecondary)
                        }
                    }
                    Button("今日の枠を60分追加") {
                        confirmsAllowanceExtension = true
                    }
                    .disabled(!model.canExtendAllowance || model.isAllowanceExtending)
                    if model.isAllowanceExtending {
                        ProgressView("追加しています…")
                    }
                    if let allowanceErrorMessage = model.allowanceErrorMessage {
                        Text(allowanceErrorMessage)
                            .font(.footnote)
                            .foregroundStyle(Color.shannonDanger)
                    }
                } header: {
                    Text("ライブ音声の利用枠")
                } footer: {
                    Text("利用済みの記録は消さず、本日だけ60分追加します。追加するとAPI利用量が増える可能性があります。")
                }
#endif

                Section {
                    Text("声の変更は、接続中の会話を急に変えず、次に始める音声会話から反映されます。選択はiPhoneとMacで共有されます。")
                        .font(.footnote)
                        .foregroundStyle(palette.textSecondary)
                }

                if let errorMessage = model.errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(Color.shannonDanger)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.canvas)
            .navigationTitle("シャノンの声")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完了") { dismiss() }
                }
            }
            .task {
                await model.reload()
#if os(iOS)
                await model.reloadAllowance()
#endif
            }
            .onDisappear { model.stopPreview() }
            .alert("今日のライブ音声枠を追加しますか？", isPresented: $confirmsAllowanceExtension) {
                Button("キャンセル", role: .cancel) {}
                Button("60分追加") { Task { await model.extendAllowance() } }
            } message: {
                Text("本日だけ利用できる時間を60分増やします。利用済みの記録は残ります。")
            }
        }
    }

    private func choiceLabel(
        title: String,
        detail: String,
        selected: Bool,
        palette: ShannonPalette
    ) -> some View {
        HStack(spacing: ShannonSpacing.medium) {
            VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
            }
            Spacer(minLength: ShannonSpacing.small)
            if selected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(palette.action)
            }
        }
        .contentShape(Rectangle())
    }
}
