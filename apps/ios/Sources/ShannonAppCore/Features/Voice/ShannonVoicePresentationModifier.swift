import SwiftUI

#if os(iOS)
struct ShannonVoicePresentationModifier: ViewModifier {
    @Binding var showsLiveVoice: Bool
    @Binding var showsGeminiVoice: Bool
    @Binding var showsVoiceModePicker: Bool

    let conversationModel: ShannonConversationModel
    let voiceModel: ShannonVoiceConversationModel
    let realtimeVoiceModel: ShannonRealtimeVoiceSessionModel
    let expression: ShannonExpressionDTO

    func body(content: Content) -> some View {
        content
            .fullScreenCover(isPresented: $showsLiveVoice) {
                liveVoiceView
            }
            .fullScreenCover(isPresented: $showsGeminiVoice) {
                geminiVoiceView
            }
            .confirmationDialog(
                "音声モード",
                isPresented: $showsVoiceModePicker,
                titleVisibility: .visible
            ) {
                Button("OpenAI ライブ") {
                    showsLiveVoice = true
                }
                Button("Gemini 3.8 Flash-Lite · 試験版") {
                    voiceModel.cancel()
                    showsGeminiVoice = true
                }
                Button("キャンセル", role: .cancel) {}
            } message: {
                Text("ライブは自然な割り込み対応、Geminiは声質を比較するターン制会話です。")
            }
    }

    private var liveVoiceView: some View {
        ShannonLiveVoiceView(
            model: realtimeVoiceModel,
            expression: expression,
            createCall: { offer, participantMode in
                try await conversationModel.createRealtimeVoiceCall(
                    offerSDP: offer,
                    participantMode: participantMode
                )
            },
            performLiveDelegation: { transcript, utterance, participantMode in
                try await conversationModel.performLiveVoiceDelegation(
                    transcript: transcript,
                    userUtterance: utterance,
                    participantMode: participantMode
                )
            },
            analyzeCameraSnapshot: { jpegData in
                try await conversationModel.analyzeVoiceCameraSnapshot(jpegData: jpegData)
            },
            commitTurn: { user, shannon in
                try await conversationModel.commitRealtimeVoiceTurn(
                    userTranscript: user,
                    shannonTranscript: shannon
                )
            },
            dismiss: { showsLiveVoice = false }
        )
    }

    private var geminiVoiceView: some View {
        ShannonGeminiVoiceView(
            voiceModel: voiceModel,
            expression: expression,
            transcribe: { recording in
                try await conversationModel.transcribeVoice(recording)
            },
            reply: { transcript in
                try await conversationModel.sendGeminiVoiceTurn(transcript)
            },
            synthesize: { text in
                try await conversationModel.synthesizeGeminiSpeech(text)
            },
            dismiss: { showsGeminiVoice = false }
        )
    }
}
#endif
