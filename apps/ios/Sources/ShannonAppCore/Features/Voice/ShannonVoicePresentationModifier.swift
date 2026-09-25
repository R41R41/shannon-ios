import SwiftUI

#if os(iOS)
struct ShannonVoicePresentationModifier: ViewModifier {
    @Binding var isPresented: Bool

    let conversationModel: ShannonConversationModel
    let geminiVoiceModel: ShannonGeminiLiveSessionModel
    let expression: ShannonExpressionDTO

    func body(content: Content) -> some View {
        content.fullScreenCover(isPresented: $isPresented) {
            ShannonGeminiLiveVoiceView(
                model: geminiVoiceModel,
                expression: expression,
                createSession: { participantMode in
                    try await conversationModel.createGeminiLiveSession(participantMode: participantMode)
                },
                performDelegation: { request, utterance, participantMode in
                    try await conversationModel.performLiveVoiceDelegation(
                        transcript: request,
                        userUtterance: utterance,
                        participantMode: participantMode
                    )
                },
                analyzeCameraSnapshot: { data in
                    try await conversationModel.analyzeVoiceCameraSnapshot(jpegData: data)
                },
                synthesize: { text, style in
                    try await conversationModel.synthesizeGeminiSpeech(text, style: style)
                },
                commitTurn: { user, shannon in
                    try await conversationModel.commitRealtimeVoiceTurn(
                        userTranscript: user,
                        shannonTranscript: shannon
                    )
                },
                dismiss: { isPresented = false }
            )
        }
    }
}
#endif
