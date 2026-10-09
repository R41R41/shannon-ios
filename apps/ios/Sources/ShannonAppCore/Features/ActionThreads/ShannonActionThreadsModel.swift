import Foundation
import Observation

@MainActor @Observable
public final class ShannonActionThreadsModel {
    public enum Phase: Equatable { case hidden, loading, loaded, recovering }
    public private(set) var phase: Phase = .loading
    public private(set) var reading: ShannonActionThreadsDTO?
    private var clientOthers = false
    private var serverOthers = false
    public var othersPresent: Bool { clientOthers || serverOthers }
    public private(set) var controlPending = false
    public private(set) var notice: String?
    public private(set) var readAt: Date?
    private let client: (any ShannonActionThreadsServing)?
    private let scopeKey: String
    private var context = 0
    private var readGeneration = 0
    private var hasRead = false

    public init(scopeKey: String, client: (any ShannonActionThreadsServing)?) {
        self.scopeKey = scopeKey
        self.client = client
        if client == nil { phase = .hidden }
    }
    public static func make(for conversation: ShannonConversationModel) -> ShannonActionThreadsModel {
#if DEBUG
        if conversation.isDesignPreview, ShannonActionFixtureClient.isRequested {
            return ShannonActionThreadsModel(scopeKey: conversation.scopeKey, client: ShannonActionFixtureClient())
        }
#endif
        return ShannonActionThreadsModel(scopeKey: conversation.scopeKey, client: conversation.client as? any ShannonActionThreadsServing)
    }
    public var threads: [ShannonActionThreadsDTO.Thread] { othersPresent ? [] : reading?.threads ?? [] }
    public var showsCapsule: Bool {
        hasRead && phase != .hidden && ((reading?.count ?? 0) > 0 || phase == .recovering
            || threads.contains { $0.state == "unknown" || $0.state == "stopping" || $0.failures >= 5 || $0.canResume })
    }
    public func isStale(at date: Date) -> Bool { readAt.map { date.timeIntervalSince($0) > 15 } ?? true }
    public var capsuleText: String {
        if othersPresent { return ShannonGeneratedStrings.threadsGeneric }
        if phase == .recovering { return ShannonGeneratedStrings.threadsRecovering }
        if threads.contains(where: { $0.hasUnacknowledgedNotice }) { return ShannonGeneratedStrings.threadsUnknown }
        if (reading?.count ?? 0) == 0 && threads.contains(where: { $0.canResume }) {
            return threads.contains(where: { $0.state == "failed" }) ? ShannonGeneratedStrings.threadsFailed : ShannonGeneratedStrings.threadsCancelled
        }
        if (reading?.count ?? 0) == 0 && threads.contains(where: { $0.state == "unknown" }) { return ShannonGeneratedStrings.threadsRecords }
        return ShannonGeneratedStrings.threadsCount(count: String(reading?.count ?? 0))
    }
    /// Privacy changes invalidate both pending reads and controls before another frame is drawn.
    public func reset(othersPresent: Bool, disconnected: Bool = false) {
        context += 1; readGeneration += 1
        self.clientOthers = othersPresent; serverOthers = false
        reading = nil; readAt = nil; controlPending = false; notice = nil
        phase = disconnected ? .hidden : client == nil ? .hidden : .loading
        if disconnected { hasRead = false }
    }
    public func reload() async {
        guard let client else { return }
        readGeneration += 1
        let expected = readGeneration, audience = clientOthers, expectedContext = context
        do {
            let answer = try await client.loadActionThreads(scopeKey: scopeKey, othersPresent: audience)
            guard expected == readGeneration, expectedContext == context, !Task.isCancelled else { return }
            apply(answer)
        } catch let error as ShannonAPIError where error == .rejected(status: 403) || error == .rejected(status: 404) {
            guard expected == readGeneration, expectedContext == context else { return }
            reading = nil; phase = .hidden; hasRead = false
        } catch {
            guard expected == readGeneration, expectedContext == context, !Task.isCancelled else { return }
            phase = .recovering
        }
    }
    private func apply(_ answer: ShannonActionThreadsDTO) {
        serverOthers = answer.othersPresent ?? false
        reading = othersPresent ? .init(availability: answer.availability, generatedAt: answer.generatedAt, count: answer.count, threads: []) : answer
        let generated = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(answer.generatedAt))
            ?? (try? Date.ISO8601FormatStyle().parse(answer.generatedAt))
        hasRead = true; readAt = generated.map { min($0, Date()) }; phase = answer.availability == "ready" ? .loaded : .recovering
    }
    /// A presentation receipt only. Never calls stop/resume or changes the execution outcome.
    public func acknowledgeNotice(id: String, notificationID: String) async {
        guard let client, !controlPending, !othersPresent, phase == .loaded, !isStale(at: Date()),
              threads.contains(where: { $0.id == id && $0.state == "unknown" && $0.notification?.id == notificationID && $0.notification?.acknowledgedAt == nil }) else { return }
        controlPending = true; notice = nil; readGeneration += 1
        let expectedContext = context, expectedRead = readGeneration, requestID = UUID().uuidString
        defer { if expectedContext == context { controlPending = false } }
        do {
            let answer = try await client.acknowledgeActionNotice(scopeKey: scopeKey, id: id, notificationID: notificationID, requestID: requestID)
            guard expectedContext == context, !Task.isCancelled else { return }
            if expectedRead == readGeneration { readGeneration += 1; apply(answer) }
            else { await reload() }
        } catch {
            guard expectedContext == context, !Task.isCancelled else { return }
            notice = ShannonGeneratedStrings.threadsChecking
            await reload()
        }
        guard expectedContext == context, !othersPresent, !Task.isCancelled else { return }
        let confirmed = phase == .loaded && !isStale(at: Date()) && threads.contains {
            $0.id == id && $0.notification?.id == notificationID && $0.notification?.acknowledgedAt != nil
        }
        notice = confirmed ? ShannonGeneratedStrings.threadsNoticeAcknowledged : ShannonGeneratedStrings.threadsNoticeUnconfirmed
    }
    /// One request, then read-back. An uncertain delivery is never automatically posted again.
    public func control(id: String?, resume: Bool = false) async {
        guard let client, !controlPending, !othersPresent, phase == .loaded, !isStale(at: Date()) else { return }
        controlPending = true; notice = nil; readGeneration += 1
        let expectedContext = context, expectedRead = readGeneration, requestID = UUID().uuidString
        defer { if expectedContext == context { controlPending = false } }
        do {
            let answer = try await client.controlActionThread(scopeKey: scopeKey, id: id, resume: resume, requestID: requestID)
            guard expectedContext == context else { return }
            // A poll may already have observed a new audience or outcome while this POST's answer was in transit.
            guard expectedRead == readGeneration else { await reload(); return }
            readGeneration += 1; apply(answer)
        } catch {
            guard expectedContext == context else { return }
            notice = ShannonGeneratedStrings.threadsChecking
            await reload()
            guard expectedContext == context else { return }
            let targets = threads.filter { id == nil || $0.id == id }
            let confirmed = !targets.isEmpty && targets.allSatisfy {
                resume ? ["queued", "running", "waiting"].contains($0.state) : ["stopping", "cancelled", "completed", "failed"].contains($0.state)
            }
            notice = confirmed && phase == .loaded && !isStale(at: Date()) ? ShannonGeneratedStrings.threadsAccepted : ShannonGeneratedStrings.threadsUnconfirmed
        }
    }
}
