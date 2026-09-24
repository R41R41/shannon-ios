import Foundation

/// Provider IDs are retained all the way from transport to persistence. Kept
/// independent of WebRTC so event order and interruption tests also run on Mac.
public struct ShannonRealtimePacket: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case speechStarted, speechStopped, inputDone, outputDelta, outputDone
        case responseStarted, responseFinished, playbackStopped, truncated, functionCall
    }
    public var kind: Kind
    public var itemID: String = ""
    public var responseID: String = ""
    public var callID: String = ""
    public var text: String = ""
    public var status: String = ""
    public var hasTools = false
    public var usage: ShannonRealtimeVoiceUsage?

    static func decode(_ object: [String: Any], type: String) -> Self? {
        let item = object["item_id"] as? String ?? ""
        let responseID = object["response_id"] as? String ?? ""
        switch type {
        case "input_audio_buffer.speech_started" where !item.isEmpty:
            return Self(kind: .speechStarted, itemID: item)
        case "input_audio_buffer.speech_stopped" where !item.isEmpty:
            return Self(kind: .speechStopped, itemID: item)
        case "conversation.item.input_audio_transcription.completed" where !item.isEmpty:
            return Self(kind: .inputDone, itemID: item, text: object["transcript"] as? String ?? "")
        case "response.output_audio_transcript.delta", "response.audio_transcript.delta":
            guard !responseID.isEmpty, !item.isEmpty else { return nil }
            return Self(kind: .outputDelta, itemID: item, responseID: responseID, text: object["delta"] as? String ?? "")
        case "response.output_audio_transcript.done", "response.audio_transcript.done":
            guard !responseID.isEmpty, !item.isEmpty else { return nil }
            return Self(kind: .outputDone, itemID: item, responseID: responseID, text: object["transcript"] as? String ?? "")
        case "response.created", "response.done":
            guard let response = object["response"] as? [String: Any], let id = response["id"] as? String else { return nil }
            let output = response["output"] as? [[String: Any]] ?? []
            return Self(kind: type == "response.created" ? .responseStarted : .responseFinished,
                responseID: id, status: response["status"] as? String ?? "",
                hasTools: output.contains { $0["type"] as? String == "function_call" },
                usage: ShannonRealtimeVoiceEvent.decodeUsage(response["usage"]))
        case "output_audio_buffer.stopped" where !responseID.isEmpty:
            return Self(kind: .playbackStopped, responseID: responseID)
        case "conversation.item.truncated" where !item.isEmpty:
            return Self(kind: .truncated, itemID: item)
        case "response.function_call_arguments.done" where !responseID.isEmpty:
            guard object["name"] as? String == "consult_shannon_backend",
                  let call = object["call_id"] as? String, !call.isEmpty,
                  let args = object["arguments"] as? String, let data = args.data(using: .utf8),
                  let values = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let request = values["request"] as? String, !request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return Self(kind: .functionCall, responseID: responseID, callID: call, text: String(request.prefix(8_000)))
        default: return nil
        }
    }
}

public struct ShannonRealtimeTurnCoordinator: Sendable {
    private struct Turn: Sendable {
        var user = ""
        var items: [String: String] = [:]
        var order: [String] = []
        var finalResponse: String?
        var interrupted = false
        var persisted = false
    }
    public private(set) var epoch = 0
    public private(set) var userText = ""
    public private(set) var shannonText = ""
    public private(set) var isUserSpeaking = false
    public private(set) var activeResponse: String?
    private var currentTurn = ""
    private var turns: [String: Turn] = [:]
    private var responseTurns: [String: String] = [:]
    private var responseItems: [String: Set<String>] = [:]
    private var playedResponses: Set<String> = []
    private var calls: [String: Int] = [:]
    private var seenCalls: Set<String> = []
    private var wantsResponse = false
    private var responseRequested = false

    public init() {}
    public var isWorking: Bool { !calls.isEmpty || wantsResponse || responseRequested }
    public var pendingCallIDs: [String] { Array(calls.keys) }
    public var userItemID: String { currentTurn }
    public func belongsToCurrentTurn(responseID: String) -> Bool { responseTurns[responseID] == currentTurn }

    @discardableResult
    public mutating func beginUserTurn(itemID: String, text: String = "", speaking: Bool = false) -> Bool {
        guard currentTurn != itemID else { return false }
        if let previous = turns[currentTurn], previous.finalResponse.map({ playedResponses.contains($0) }) != true {
            turns[currentTurn]?.interrupted = true
        }
        epoch += 1
        currentTurn = itemID
        turns[itemID] = Turn(user: text)
        userText = text
        shannonText = ""
        isUserSpeaking = speaking
        calls.removeAll()
        wantsResponse = false
        responseRequested = false
        return true
    }

    public mutating func registerCall(_ id: String, responseID: String? = nil) -> Int? {
        guard !seenCalls.contains(id), !currentTurn.isEmpty,
              responseID == nil || responseTurns[responseID!] == currentTurn else { return nil }
        seenCalls.insert(id)
        calls[id] = epoch
        return epoch
    }

    public mutating func finishCall(_ id: String, epoch expected: Int) -> Bool {
        guard expected == epoch, calls.removeValue(forKey: id) == expected else { return false }
        wantsResponse = true
        return true
    }

    public func canFinishCall(_ id: String, epoch expected: Int) -> Bool {
        expected == epoch && calls[id] == expected
    }

    public mutating func requestResponse() { wantsResponse = true }

    /// Appending a function result does not itself authorize another response.
    public mutating func takeResponseRequest() -> Bool {
        guard wantsResponse, !isUserSpeaking, calls.isEmpty,
              activeResponse == nil, !responseRequested else { return false }
        wantsResponse = false
        responseRequested = true
        return true
    }

    public mutating func recoverResponseConflict() {
        responseRequested = false
        // Wait for the provider's active response to finish; no immediate retry loop.
        wantsResponse = true
    }

    public mutating func apply(_ packet: ShannonRealtimePacket) -> (user: String, shannon: String)? {
        switch packet.kind {
        case .speechStarted:
            beginUserTurn(itemID: packet.itemID, speaking: true)
        case .speechStopped:
            if packet.itemID == currentTurn { isUserSpeaking = false }
        case .inputDone:
            if currentTurn.isEmpty { beginUserTurn(itemID: packet.itemID) }
            if turns[packet.itemID] != nil { turns[packet.itemID]?.user = packet.text }
        case .responseStarted:
            guard !currentTurn.isEmpty else { return nil }
            if responseTurns[packet.responseID] == nil { responseTurns[packet.responseID] = currentTurn }
            activeResponse = packet.responseID
            responseRequested = false
        case .outputDelta, .outputDone:
            guard let key = responseTurns[packet.responseID], var turn = turns[key], !turn.interrupted else { return nil }
            if turn.items[packet.itemID] == nil { turn.order.append(packet.itemID) }
            turn.items[packet.itemID] = String((packet.kind == .outputDone ? packet.text : (turn.items[packet.itemID] ?? "") + packet.text).prefix(8_000))
            turns[key] = turn
            responseItems[packet.responseID, default: []].insert(packet.itemID)
        case .responseFinished:
            if activeResponse == packet.responseID { activeResponse = nil }
            if let key = responseTurns[packet.responseID] {
                if packet.status == "completed", !packet.hasTools {
                    turns[key]?.finalResponse = packet.responseID
                } else if packet.status != "completed" {
                    // Generated text is not proof it was heard. On interruption
                    // discard this response rather than archive unheard speech.
                    for item in responseItems[packet.responseID] ?? [] { turns[key]?.items[item] = nil }
                }
            }
        case .playbackStopped:
            playedResponses.insert(packet.responseID)
        case .truncated:
            for key in Array(turns.keys) { turns[key]?.items[packet.itemID] = nil }
        case .functionCall: break
        }
        if let current = turns[currentTurn] {
            userText = current.user
            shannonText = current.order.compactMap { current.items[$0] }.joined(separator: "\n")
        }
        let key = packet.kind == .inputDone ? packet.itemID : responseTurns[packet.responseID] ?? currentTurn
        guard var turn = turns[key], !turn.persisted, !turn.interrupted,
              let final = turn.finalResponse, playedResponses.contains(final), !turn.user.isEmpty else { return nil }
        let answer = turn.order.compactMap { turn.items[$0] }.filter { !$0.isEmpty }.joined(separator: "\n")
        guard !answer.isEmpty else { return nil }
        turn.persisted = true
        turns[key] = turn
        return (String(turn.user.prefix(8_000)), String(answer.prefix(8_000)))
    }
}
