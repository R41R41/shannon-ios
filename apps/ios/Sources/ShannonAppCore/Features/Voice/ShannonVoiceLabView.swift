#if os(iOS)
import SwiftUI
import UniformTypeIdentifiers

public struct ShannonVoiceLabView: View {
    @State private var controller = ShannonVoiceLabAudioController()
    @State private var showsImporter = false

    public init() {}

    public var body: some View {
        ShannonEnvironmentPaletteReader { palette in
            NavigationStack {
                Form {
                    sourceSection
                    customTuningSection
                    presetSection
                    rvcSection
                    actionSection(palette)
                    measurementSection
                }
                .scrollContentBackground(.hidden)
                .background(palette.canvas)
                .navigationTitle("Shannon Voice Lab")
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        if controller.isBusy { ProgressView() }
                    }
                }
            }
            .foregroundStyle(palette.textPrimary)
            .tint(palette.action)
        }
        .fileImporter(
            isPresented: $showsImporter,
            allowedContentTypes: [.wav, .audio],
            allowsMultipleSelection: false
        ) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            Task { await controller.importWAV(from: url) }
        }
        .onDisappear { controller.stopPlayback() }
        .onChange(of: controller.selectedPreset) { _, preset in
            #if DEBUG
            ShannonVoiceLabLiveSettings.save(preset)
            #endif
        }
    }

    private var customTuningSection: some View {
        Section("Custom tuning") {
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent(
                    "Pitch",
                    value: ShannonVoiceLabTuning.pitchLabel(controller.customPitchCents)
                )
                Slider(
                    value: customPitchBinding,
                    in: Double(ShannonVoiceLabTuning.pitchRange.lowerBound)...Double(ShannonVoiceLabTuning.pitchRange.upperBound),
                    step: Double(ShannonVoiceLabTuning.pitchStep)
                ) {
                    Text("Pitch")
                } minimumValueLabel: {
                    Text("−3")
                        .accessibilityHidden(true)
                } maximumValueLabel: {
                    Text("+4")
                        .accessibilityHidden(true)
                } onEditingChanged: {
                    customEditingChanged($0)
                }
                .accessibilityLabel("ピッチ")
                .accessibilityValue(ShannonVoiceLabTuning.pitchLabel(controller.customPitchCents))
                .accessibilityHint("10 cents刻み。指を離すと同じ音源を先頭から再生します")
                .disabled(controller.isBusy)
            }

            VStack(alignment: .leading, spacing: 8) {
                LabeledContent(
                    "Formant",
                    value: ShannonVoiceLabTuning.formantLabel(controller.customFormantSemitones)
                )
                Slider(
                    value: customFormantBinding,
                    in: Double(ShannonVoiceLabTuning.formantRange.lowerBound)...Double(ShannonVoiceLabTuning.formantRange.upperBound),
                    step: Double(ShannonVoiceLabTuning.formantStep)
                ) {
                    Text("Formant")
                } minimumValueLabel: {
                    Text("−3")
                        .accessibilityHidden(true)
                } maximumValueLabel: {
                    Text("+3")
                        .accessibilityHidden(true)
                } onEditingChanged: {
                    customEditingChanged($0)
                }
                .accessibilityLabel("フォルマント")
                .accessibilityValue(ShannonVoiceLabTuning.formantLabel(controller.customFormantSemitones))
                .accessibilityHint("0.1半音刻み。指を離すと同じ音源を先頭から再生します")
                .disabled(controller.isBusy)
            }

            HStack {
                Button("候補値へ戻す") { controller.resetCustomTuning() }
                    .disabled(controller.isBusy)
                Spacer()
                Button {
                    Task { await controller.previewCustomPreset() }
                } label: {
                    Label("この値を聴く", systemImage: "play.fill")
                }
                .disabled(controller.isBusy || controller.selectedSource == .realtime)
            }
            .frame(minHeight: ShannonTouchTarget.minimum)

            Text("指を離すと同じPCMを先頭から再生します。Pitchのみは次回の実通話にも反映可能です。Formantを使う比較は端末内で高速処理しますが、DSPは約100 msのバッファ遅延を持ち、実通話にはまだ未接続です。")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var customPitchBinding: Binding<Double> {
        Binding(
            get: { Double(controller.customPitchCents) },
            set: {
                controller.customPitchCents = Float($0)
                controller.selectCustomPreset()
            }
        )
    }

    private var customFormantBinding: Binding<Double> {
        Binding(
            get: { Double(controller.customFormantSemitones) },
            set: {
                controller.customFormantSemitones = Float($0)
                controller.selectCustomPreset()
            }
        )
    }

    private func customEditingChanged(_ isEditing: Bool) {
        if isEditing {
            controller.beginCustomAdjustment()
        } else {
            Task { await controller.previewCustomPreset() }
        }
    }

    private var sourceSection: some View {
        Section("同一音源") {
            Picker("入力", selection: $controller.selectedSource) {
                ForEach(ShannonVoiceLabSource.allCases) { source in
                    Text(source.japaneseName).tag(source)
                }
            }

            LabeledContent("現在", value: controller.sourceLabel)
            Text(ShannonVoiceLabEvaluationScript.japanese)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)

            HStack {
                Button("固定文を生成") {
                    Task { await controller.prepareFixedJapanese() }
                }
                .disabled(controller.isBusy)

                Button("WAVを選ぶ") { showsImporter = true }
                    .disabled(controller.isBusy)
            }

            if controller.selectedSource == .realtime {
                Text(livePresetMessage)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var presetSection: some View {
        Section("比較preset") {
            ForEach(ShannonVoiceLabPreset.comparisonSet) { preset in
                Button {
                    controller.selectedPreset = preset
                } label: {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(preset.title)
                            Text(preset.detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if controller.selectedPreset == preset {
                            Image(systemName: "checkmark.circle.fill")
                                .accessibilityHidden(true)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(controller.selectedPreset == preset ? .isSelected : [])
            }
        }
    }

    @ViewBuilder
    private var rvcSection: some View {
        if controller.selectedPreset.kind == .rvc {
            Section("RVC / Mac・Azure") {
                TextField("Endpoint", text: $controller.rvcConfiguration.endpoint)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("許諾済みmodel ID", text: $controller.rvcConfiguration.modelID)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Picker("F0", selection: $controller.rvcConfiguration.f0Method) {
                    Text("RMVPE").tag("rmvpe")
                    Text("PM").tag("pm")
                }
                LabeledContent(
                    "chunk / look-ahead",
                    value: "\(controller.rvcConfiguration.chunkPolicy.chunkMilliseconds) / \(controller.rvcConfiguration.chunkPolicy.lookAheadMilliseconds) ms"
                )
                Text("実在人物ではなく、許諾済みまたはShannon用に収録したmodelだけを指定します。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var livePresetMessage: String {
        switch controller.selectedPreset.kind {
        case .bypass:
            "次の通常起動は標準WebRTC音声経路です。"
        case .appleTimePitch:
            "次の通常起動でcustom RTCAudioDeviceを使い、受信PCMへこのPitchを適用します。"
        case .signalsmith, .rvc:
            "このpresetのLiveストリーミングは未接続です。次の通常起動は安全のためOFFになります。"
        }
    }

    private func actionSection(_ palette: ShannonPalette) -> some View {
        Section("A/B") {
            Button {
                Task { await controller.playSelectedPreset() }
            } label: {
                Label(
                    controller.isPlaying ? "先頭から聴き直す" : "このpresetを再生",
                    systemImage: "play.fill"
                )
                .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum)
            }
            .disabled(controller.isBusy || controller.selectedSource == .realtime)

            if controller.isPlaying {
                Button("停止", role: .cancel) { controller.stopPlayback() }
                    .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum)
            }

            LabeledContent("状態", value: controller.status)
            if let error = controller.errorMessage {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(palette.danger)
            }
        }
    }

    @ViewBuilder
    private var measurementSection: some View {
        Section("実測") {
            if controller.measurements.isEmpty {
                Text("再生ごとに前処理時間とDSP報告遅延を記録します。")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(controller.measurements.prefix(12)) { measurement in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(measurement.presetID)
                            .font(.subheadline.weight(.semibold))
                        Text(
                            "前処理 \(measurement.processingMilliseconds, format: .number.precision(.fractionLength(1))) ms・DSP遅延 \(measurement.algorithmLatencyMilliseconds, format: .number.precision(.fractionLength(1))) ms"
                        )
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                    }
                }
                Button("実測を消去", role: .destructive) { controller.clearMeasurements() }
            }
        }
    }
}
#endif
