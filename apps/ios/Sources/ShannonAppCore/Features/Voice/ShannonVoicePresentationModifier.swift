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
                    try await conversationModel.performLiveVoiceDelegationResponse(
                        transcript: request,
                        userUtterance: utterance,
                        participantMode: participantMode
                    )
                },
                performStreamingDelegation: { request, utterance, participantMode, onSegment in
                    try await conversationModel.performLiveVoiceDelegationStreamingResponse(
                        transcript: request,
                        userUtterance: utterance,
                        participantMode: participantMode,
                        onSegment: onSegment
                    )
                },
                analyzeCameraSnapshot: { data in
                    try await conversationModel.analyzeVoiceCameraSnapshot(jpegData: data)
                },
                streamSpeech: { text, style in
                    try await conversationModel.streamGeminiSpeech(text, style: style)
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
