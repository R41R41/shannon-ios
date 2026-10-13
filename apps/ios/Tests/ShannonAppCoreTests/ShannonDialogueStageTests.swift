import CoreGraphics
import Testing
@testable import ShannonAppCore

/// Talk's dialogue display in the Live2D form (owner pick 2026-10-13, option C): talk, read and call.
struct ShannonDialogueStageTests {
    @Test func `a running call wins over reading`() {
        #expect(ShannonDialogueStage.resolve(callIsLive: true, reads: true) == .call)
        #expect(ShannonDialogueStage.resolve(callIsLive: true, reads: false) == .call)
    }

    @Test func `without a call the owner's reading decides`() {
        #expect(ShannonDialogueStage.resolve(callIsLive: false, reads: true) == .read)
        #expect(ShannonDialogueStage.resolve(callIsLive: false, reads: false) == .talk)
    }

    @Test func `only scrolling back starts reading`() {
        #expect(ShannonDialogueStage.reads(after: .scrolledBack))
        for event in [ShannonDialogueStage.Event.tappedFace, .ownerSent, .threadChanged, .callChanged] {
            #expect(!ShannonDialogueStage.reads(after: event))
        }
    }

    @Test func `a long downward pull is a scroll back; a short or sideways one is not`() {
        #expect(ShannonDialogueStage.isScrollBack(translation: CGSize(width: 4, height: 80)))
        #expect(!ShannonDialogueStage.isScrollBack(translation: CGSize(width: 0, height: 20)))
        #expect(!ShannonDialogueStage.isScrollBack(translation: CGSize(width: 0, height: -80)))
        #expect(!ShannonDialogueStage.isScrollBack(translation: CGSize(width: 90, height: 60)))
    }

    @Test func `she is large in talk, larger in a call, and a still face while reading`() {
        #expect(ShannonDialogueStage.talk.figureShare == 0.6)
        #expect(ShannonDialogueStage.call.figureShare > ShannonDialogueStage.talk.figureShare)
        #expect(ShannonDialogueStage.read.figureShare == 0)
        #expect(ShannonDialogueStage.talk.drawsLive2D && ShannonDialogueStage.call.drawsLive2D)
        #expect(!ShannonDialogueStage.read.drawsLive2D)
        #expect(ShannonDialogueStage.cornerFaceSize == 56)
    }

    @Test func `the call's controls replace the composer and the activity line`() {
        #expect(!ShannonDialogueStage.call.showsComposer && !ShannonDialogueStage.call.showsActivityLine)
        #expect(ShannonDialogueStage.talk.showsComposer && ShannonDialogueStage.read.showsComposer)
        #expect(ShannonDialogueStage.talk.showsActivityLine && ShannonDialogueStage.read.showsActivityLine)
    }
}
