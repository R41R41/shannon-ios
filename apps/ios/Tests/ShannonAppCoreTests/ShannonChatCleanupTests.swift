import Foundation
import Testing
@testable import ShannonAppCore

/// Owner feedback on Talk (TestFlight 243): the strip above the composer shows only work in progress, and a
/// message's small icon follows that message's own feeling.
private actor StripClient: ShannonConversationActivityServing {
    let phases: [String]
    init(phases: [String]) { self.phases = phases }
    func loadNow(scopeKey: String) async throws -> ShannonConversationActivityDTO {
        let now = Date().formatted(.iso8601)
        return .init(generatedAt: now, tasks: phases.map { phase in
            .init(id: phase, parentId: nil, kind: "research", origin: "owner_request", title: phase, phase: phase,
                  summary: "", revision: 1, updatedAt: now, currentStep: "web.fetch")
        })
    }
    func sendNowCommand(scopeKey: String, id: String, command: String, message: String?, requestID: String) async throws {}
}

private func task(_ id: String, phase: String, step: String? = nil) -> ShannonConversationActivityDTO.Task {
    .init(id: id, parentId: nil, kind: "research", origin: "owner_request", title: id, phase: phase,
          summary: "", revision: 1, updatedAt: Date().formatted(.iso8601), currentStep: step)
}

@MainActor struct ShannonTaskStripTests {
    @Test func `strip keeps only work in progress or waiting`() {
        let phases = ["executing", "waiting", "ready", "stopping", "completed", "failed", "stopped", "unknown"]
        let strip = ShannonConversationActivityModel.stripTasks(phases.map { task($0, phase: $0) }, dismissed: [])
        #expect(strip.map(\.id) == ["executing", "waiting", "ready", "stopping"])
    }

    @Test func `a dismissed row leaves the strip only`() {
        let tasks = [task("one", phase: "executing"), task("two", phase: "waiting")]
        #expect(ShannonConversationActivityModel.stripTasks(tasks, dismissed: ["one"]).map(\.id) == ["two"])
    }

    @Test func `finished work disappears from the strip but stays in いま`() async {
        let model = ShannonConversationActivityModel(scopeKey: "owner", client: StripClient(phases: ["completed", "failed"]))
        await model.reload()
        #expect(model.tasks.count == 2)
        #expect(model.showsActivity)
        #expect(!model.showsStrip)
        #expect(model.stripFeatured == nil)
    }

    @Test func `hiding the featured row shows the next one without stopping it`() async {
        let model = ShannonConversationActivityModel(scopeKey: "owner", client: StripClient(phases: ["executing", "waiting"]))
        await model.reload()
        #expect(model.stripFeatured?.id == "executing")
        model.dismissFromStrip("executing")
        #expect(model.stripFeatured?.id == "waiting")
        #expect(model.tasks.map(\.id) == ["executing", "waiting"])
        model.dismissFromStrip("waiting")
        #expect(!model.showsStrip)
    }

    @Test func `status text matches the phase`() {
        #expect(task("done", phase: "completed", step: "web.fetch").statusTitle == "完了")
        #expect(task("done", phase: "completed", step: "web.fetch").activeStepTitle == nil)
        #expect(task("stopped", phase: "stopped", step: "web.search").statusTitle == "停止済み")
        #expect(task("waiting", phase: "waiting", step: "web.search").statusTitle == "結果を待っています")
        #expect(task("running", phase: "executing", step: "web.fetch").statusTitle == "資料と結果を確認中")
        #expect(task("running", phase: "executing", step: "places.search").statusTitle == "場所の情報を確認中")
        #expect(task("running", phase: "executing").statusTitle == "進めています")
    }
}

@MainActor struct ShannonMessageAvatarMoodTests {
    private func snapshot(_ expression: ShannonExpressionDTO, feeling: ShannonFeelingDTO? = nil, kind: String? = nil)
        -> ConversationMessage.EmotionSnapshot {
        .init(valence: 0, arousal: 0, openness: 0, expression: expression, feeling: feeling, kind: kind, stateVersion: 1)
    }

    @Test func `a message without a feeling shows the usual eyes`() {
        #expect(ShannonMessageAvatarMood.eyeExpression(for: nil) == .neutral)
        #expect(ShannonMessageAvatarMood.face(for: nil).japaneseName == "ふだんどおり")
        #expect(ShannonMessageAvatarMood.faceAssetName(for: nil) == "shannon-expression-neutral")
    }

    @Test func `each message's eyes follow its own face`() {
        for expression in ShannonExpressionDTO.allCases {
            #expect(ShannonMessageAvatarMood.eyeExpression(for: snapshot(expression)) == expression)
        }
        #expect(ShannonMessageAvatarMood.eyeExpression(for: snapshot(.joyful))
            != ShannonMessageAvatarMood.eyeExpression(for: snapshot(.sad)))
    }

    @Test func `borrowed feelings and the uncomfortable kind keep their face's eyes`() {
        #expect(ShannonMessageAvatarMood.eyeExpression(for: snapshot(.determined, feeling: .proud)) == .determined)
        #expect(ShannonMessageAvatarMood.face(for: snapshot(.determined, feeling: .proud)).japaneseName == "得意げ")
        #expect(ShannonMessageAvatarMood.eyeExpression(for: snapshot(.neutral, kind: ShannonExpressionDTO.uncomfortableName)) == .annoyed)
    }

    @Test func `the label and the icon read the same face`() {
        let emotion = snapshot(.concerned)
        #expect(ShannonMessageAvatarMood.face(for: emotion) == emotion.face)
        #expect(ShannonMessageAvatarMood.faceAssetName(for: emotion) == "shannon-expression-concerned")
    }

    @Test func `every expression's eyes alone fit a message icon`() {
        for expression in ShannonExpressionDTO.allCases {
            let pose = ShannonEyeRig.pose(for: expression, activity: .idle, elapsedTime: 0, isAnimated: false)
            let frame = ShannonEyeRig.frame(pose: pose, elapsedTime: 0, isAnimated: false)
            let bounds = ShannonWaterlightCanvas.eyeBounds(frame)
            #expect(bounds != nil, "\(expression)")
            #expect((bounds?.width ?? 0) > 0 && (bounds?.height ?? 0) > 0, "\(expression)")
        }
    }
}
