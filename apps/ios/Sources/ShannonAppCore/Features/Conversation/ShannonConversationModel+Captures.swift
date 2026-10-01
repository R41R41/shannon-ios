import Foundation

extension ShannonConversationModel {
    /// Fetches what the server recorded for this thread and attaches it to the
    /// replies already on screen. Message identity and local-only content stay
    /// untouched, so nothing scrolls or flickers when a capture arrives.
    public func refreshCaptures() async {
        guard let threadId = selectedThreadId, !isDesignPreview else { return }
        guard let response = try? await client.loadConversationCaptures(scopeKey: scopeKey, threadId: threadId),
              selectedThreadId == threadId, response.threadId == threadId
        else { return }
        applyCaptures(response)
    }

    func applyCaptures(_ response: ShannonConversationCapturesDTO) {
        let capturesByTurn = Dictionary(response.turns.map { ($0.turnId, $0.captures) }, uniquingKeysWith: { $1 })
        let remindersByMessage = Dictionary(
            response.reminders.map {
                ($0.messageId.lowercased(), ShannonReminderDTO(commitmentId: $0.commitmentId, state: $0.state, text: $0.text))
            },
            uniquingKeysWith: { $1 }
        )
        let updated = messages.map { message -> ConversationMessage in
            // A message without a turn reference came from an older server or cache; leave it as it is.
            guard message.role == .shannon, let turnID = message.turnID else { return message }
            return message.with(
                captures: capturesByTurn[turnID] ?? [],
                reminder: remindersByMessage[message.id.uuidString.lowercased()]
            )
        }
        guard updated != messages else { return }
        messages = updated
        cacheCurrentHistory()
        persistDisplayCache()
    }

    /// Extraction runs after the reply, usually within a second; three short
    /// checks cover a busy worker without keeping a poll alive.
    func scheduleCaptureRefresh() {
        captureRefreshTask?.cancel()
        let delays = captureRefreshDelays
        captureRefreshTask = Task { [weak self] in
            for delay in delays {
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled else { return }
                await self?.refreshCaptures()
            }
        }
    }

    /// Undo uses the existing memory controls: cancel a promise, forget a fact, withdraw a goal.
    @discardableResult
    public func undoCapture(_ capture: ShannonTurnCaptureDTO) async -> Bool {
        guard capture.canUndo, let itemID = capture.itemId else { return false }
        return await performCaptureAction(id: capture.id, failure: "取り消せませんでした。変更は保存されていません。") {
            switch capture.kind {
            case .commitment:
                _ = try await self.client.mutateMemory(scopeKey: self.scopeKey, memoryID: itemID, action: .dismiss, text: nil)
            case .knowledge:
                _ = try await self.client.mutateMemory(scopeKey: self.scopeKey, memoryID: itemID, action: .forget, text: nil)
            case .intent:
                _ = try await self.client.updateCognitiveIntent(scopeKey: self.scopeKey, intentID: itemID, status: .dismissed)
            case .notice:
                break
            }
        }
    }

    @discardableResult
    public func completeReminder(_ reminder: ShannonReminderDTO) async -> Bool {
        await performCaptureAction(id: reminder.commitmentId, failure: "約束を完了にできませんでした。変更は保存されていません。") {
            _ = try await self.client.mutateMemory(
                scopeKey: self.scopeKey, memoryID: reminder.commitmentId, action: .complete, text: nil
            )
        }
    }

    @discardableResult
    public func snoozeReminder(_ reminder: ShannonReminderDTO) async -> Bool {
        await performCaptureAction(id: reminder.commitmentId, failure: "あとでに変更できませんでした。約束はそのまま残っています。") {
            _ = try await self.client.mutateMemory(
                scopeKey: self.scopeKey, memoryID: reminder.commitmentId, action: .snooze, text: nil
            )
        }
    }

    public func dismissCaptureActionError() {
        captureActionError = nil
    }

    private func performCaptureAction(
        id: String,
        failure: String,
        _ operation: @escaping () async throws -> Void
    ) async -> Bool {
        guard !pendingCaptureActionIDs.contains(id) else { return false }
        pendingCaptureActionIDs.insert(id)
        captureActionError = nil
        defer { pendingCaptureActionIDs.remove(id) }
        do {
            try await operation()
            await refreshCaptures()
            return true
        } catch {
            captureActionError = failure
            return false
        }
    }
}
