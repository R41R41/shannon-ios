import Foundation
import Observation

/// The system's call screen (CallKit on the iPhone).
@MainActor
public protocol ShannonSystemCalling: AnyObject {
    /// Reports an incoming call from 「シャノン」. It must reach the system before this returns.
    func showIncoming(_ id: UUID)
    func end(_ id: UUID, reason: ShannonCallEndReason)
}

/// The voice conversation that follows her line: the ordinary one, on the Talk her message is in.
@MainActor
public protocol ShannonCallConversing: AnyObject {
    /// A conversation, dictation or a message on its way is using the app now: she does not call into it.
    var isBusy: Bool { get }
    /// Whether the microphone is permitted. It is never asked for from a call: a prompt belongs to a tap of the owner's.
    var canListen: Bool { get }
    /// Sets the audio session's category for a call, without activating it.
    func prepareAudio()
    /// Starts the conversation; false when it could not start.
    func start(threadID: String) async -> Bool
    func stop()
    func setMuted(_ muted: Bool)
    /// Called when a conversation this object started is over, however it ended.
    var ended: (@MainActor () -> Void)? { get set }
}

/// Runs a call from Shannon: turns what the system, the server and the audio say into events for
/// `ShannonIncomingCallMachine`, and performs what the machine decides.
///
/// A call owns the audio session from the moment it rings until it is over (`isActive`): standby steps aside,
/// and her messages are not said through the earphones meanwhile. A voice conversation the owner started in
/// the app is never a system call; while one runs, a push is shown to the system and ended at once.
@MainActor
@Observable
public final class ShannonIncomingCallCoordinator {
    /// A call is ringing or going on.
    public private(set) var isActive = false

    @ObservationIgnored private var machine = ShannonIncomingCallMachine()
    @ObservationIgnored private let server: any ShannonIncomingCallServing
    @ObservationIgnored private let system: any ShannonSystemCalling
    @ObservationIgnored private let speaker: any ShannonReachOutSpeaking
    @ObservationIgnored private let conversation: any ShannonCallConversing
    /// The owner's switch 「シャノンからの着信を受ける」.
    @ObservationIgnored public var isEnabled: @MainActor () -> Bool = { false }
    @ObservationIgnored public var now: @MainActor () -> Date = { Date() }
    /// Waits; returns false when the wait was cancelled.
    @ObservationIgnored public var sleep: @MainActor (TimeInterval) async -> Bool = { seconds in
        (try? await Task.sleep(for: .seconds(max(0, seconds)))) != nil
    }
    /// Keeps the app running for a report that leaves after the call is over.
    @ObservationIgnored public var protect: @MainActor (@escaping @MainActor () async -> Void) async -> Void = { await $0() }
    @ObservationIgnored private var ringTimer: Task<Void, Never>?
    @ObservationIgnored private var connectTimer: Task<Void, Never>?
    /// Work a test waits for: claims, lines, reports.
    @ObservationIgnored private var work: [Task<Void, Never>] = []

    /// He answered, and the audio and her words have this long to arrive.
    public static let connectTimeout: TimeInterval = 25
    /// A report that did not get through is tried again this often.
    static let reportAttempts = 3

    public init(
        server: any ShannonIncomingCallServing, system: any ShannonSystemCalling,
        speaker: any ShannonReachOutSpeaking, conversation: any ShannonCallConversing
    ) {
        self.server = server
        self.system = system
        self.speaker = speaker
        self.conversation = conversation
        conversation.ended = { [weak self] in
            guard let self else { return }
            self.perform(self.machine.conversationEnded())
        }
    }

    public var phase: ShannonIncomingCallMachine.Phase? { machine.call?.phase }

    // MARK: Events

    /// A VoIP push. An incoming call is reported to the system before this returns, whatever the push holds.
    public func receivedPush(_ payload: ShannonIncomingCallPayload?) {
        perform(machine.push(payload, fresh: UUID(), now: now(), busy: conversation.isBusy, enabled: isEnabled()))
    }

    public func showFailed(_ id: UUID, silenced: Bool) { perform(machine.showFailed(id, silenced: silenced)) }
    public func answered(_ id: UUID) { perform(machine.answer(id)) }
    public func hungUp(_ id: UUID) { perform(machine.hangUp(id)) }
    public func muted(_ id: UUID, _ muted: Bool) { perform(machine.muted(id, muted)) }
    public func audioActivated() { perform(machine.audioActivated()) }
    public func audioDeactivated() { perform(machine.audioDeactivated()) }
    public func systemReset() { perform(machine.reset()) }

    /// Waits until everything the last events started has finished. For tests.
    func settle() async {
        while !work.isEmpty {
            let running = work
            work.removeAll()
            for task in running { await task.value }
        }
    }

    private func track(_ task: Task<Void, Never>) {
        if work.count >= 32 { work.removeFirst(work.count - 31) }
        work.append(task)
    }

    // MARK: Effects

    private func perform(_ effects: [ShannonIncomingCallEffect]) {
        for effect in effects {
            switch effect {
            case let .showIncoming(id): system.showIncoming(id)
            case let .endSystemCall(id, reason): system.end(id, reason: reason)
            case let .report(callID, outcome): report(callID, outcome)
            case let .scheduleRingTimeout(id, at):
                ringTimer?.cancel()
                ringTimer = Task { @MainActor [weak self] in
                    guard let self, await self.sleep(at.timeIntervalSince(self.now())) else { return }
                    self.perform(self.machine.ringTimedOut(id))
                }
            case let .scheduleConnectTimeout(id):
                connectTimer?.cancel()
                connectTimer = Task { @MainActor [weak self] in
                    guard let self, await self.sleep(Self.connectTimeout) else { return }
                    self.perform(self.machine.connectTimedOut(id))
                }
            case .cancelTimeouts:
                ringTimer?.cancel()
                connectTimer?.cancel()
                ringTimer = nil
                connectTimer = nil
            case .prepareAudio: conversation.prepareAudio()
            case let .claim(reachOutID, callID): claim(reachOutID: reachOutID, callID: callID)
            case let .speak(line): speak(line)
            case .stopSpeaking: speaker.stop()
            case let .startConversation(threadID): startConversation(threadID: threadID)
            case .stopConversation: conversation.stop()
            case let .setMuted(muted): conversation.setMuted(muted)
            }
        }
        isActive = machine.isActive
    }

    private func claim(reachOutID: String, callID: String) {
        track(Task { @MainActor [weak self, server] in
            do {
                let claim = try await server.answerIncomingCall(reachOutID: reachOutID, callID: callID)
                guard let self else { return }
                self.perform(self.machine.claimed(callID: callID, line: claim.message.content))
            } catch {
                guard let self else { return }
                self.perform(self.machine.claimFailed(callID: callID))
            }
        })
    }

    private func speak(_ line: String) {
        let id = machine.call?.id
        track(Task { @MainActor [weak self, speaker] in
            // He chose to answer, so the call's sound is his to hear wherever the phone routes it: the earphone rule
            // of a message she says unasked does not apply.
            _ = await speaker.speak(line) { true }
            guard let self, self.machine.call?.id == id else { return }
            self.perform(self.machine.lineFinished(canListen: self.conversation.canListen))
        })
    }

    private func startConversation(threadID: String) {
        let id = machine.call?.id
        track(Task { @MainActor [weak self, conversation] in
            let started = await conversation.start(threadID: threadID)
            guard let self else { return }
            guard self.machine.call?.id == id else {
                // He hung up while it was starting: it must not go on without a call.
                if started { conversation.stop() }
                return
            }
            if !started { self.perform(self.machine.conversationEnded()) }
        })
    }

    /// The server is told what became of the call. A report that does not get through is tried a few more times;
    /// if none does, the server counts a ring nobody reported on as not answered by itself.
    private func report(_ callID: String, _ outcome: ShannonIncomingCallOutcome) {
        track(Task { @MainActor [weak self, server] in
            guard let self else { return }
            await self.protect {
                for attempt in 0..<Self.reportAttempts {
                    do {
                        try await server.reportIncomingCall(callID: callID, outcome: outcome)
                        return
                    } catch is ShannonAPIError {
                        // The server answered and will not take it: asking again changes nothing.
                        return
                    } catch {
                        guard attempt + 1 < Self.reportAttempts, await self.sleep(Double(attempt + 1) * 2) else { return }
                    }
                }
            }
        })
    }
}
