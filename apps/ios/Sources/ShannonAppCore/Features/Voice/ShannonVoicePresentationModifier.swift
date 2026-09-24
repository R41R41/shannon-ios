import SwiftUI

#if os(iOS)
struct ShannonVoicePresentationModifier: ViewModifier {
    @Binding var showsLiveVoice: Bool
    @Binding var showsGeminiLiveVoice: Bool
    @Binding var showsGeminiVoice: Bool
    @Binding var showsVoiceModePicker: Bool

    let conversationModel: ShannonConversationModel
    let voiceModel: ShannonVoiceConversationModel
    let realtimeVoiceModel: ShannonRealtimeVoiceSessionModel
    let geminiLiveVoiceModel: ShannonGeminiLiveSessionModel
    let expression: ShannonExpressionDTO

    func body(content: Content) -> some View {
        content
            .fullScreenCover(isPresented: $showsLiveVoice) {
                liveVoiceView
            }
            .fullScreenCover(isPresented: $showsGeminiVoice) {
                geminiVoiceView
            }
            .fullScreenCover(isPresented: $showsGeminiLiveVoice) {
                geminiLiveVoiceView
            }
            .confirmationDialog(
                "音声モード",
                isPresented: $showsVoiceModePicker,
                titleVisibility: .visible
            ) {
                Button("OpenAI ライブ") {
                    showsLiveVoice = true
                }
                Button("Gemini 3.8 Live · リアルタイム実験") {
                    geminiLiveVoiceModel.stop()
                    showsGeminiLiveVoice = true
                }
                Button("Gemini 3.8 Flash-Lite TTS · 比較用") {
                    voiceModel.cancel()
                    showsGeminiVoice = true
                }
                Button("キャンセル", role: .cancel) {}
            } message: {
                Text("Gemini Liveは低遅延と割り込み、Flash-Lite TTSはLedaの声質を比較できます。")
            }
    }

    private var geminiLiveVoiceView: some View {
        ShannonGeminiLiveVoiceView(
            model: geminiLiveVoiceModel,
            expression: expression,
            createSession: {
                try await conversationModel.createGeminiLiveSession()
            },
            performDelegation: { request, utterance in
                try await conversationModel.performLiveVoiceDelegation(
                    transcript: request,
                    userUtterance: utterance,
                    participantMode: .owner
                )
            },
            commitTurn: { user, shannon in
                try await conversationModel.commitRealtimeVoiceTurn(
                    userTranscript: user,
                    shannonTranscript: shannon
                )
            },
            dismiss: { showsGeminiLiveVoice = false }
        )
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
