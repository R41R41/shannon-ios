import Foundation
import Observation

/// Owner-facing state of Shannon's study: what she is willing to show, the owner's
/// reactions, and the request to put a piece away. Every change is confirmed by the
/// server before it is shown, and nothing here can change her text.
@MainActor
@Observable
public final class ShannonStudyModel {
    public private(set) var pieces: [ShannonStudyPieceCardDTO] = []
    public private(set) var reactions = ShannonStudyReactionChoiceDTO.standard
    public private(set) var details: [String: ShannonStudyPieceDetailDTO] = [:]
    public private(set) var isLoading = false
    public private(set) var loadingPieceID: String?
    public private(set) var savingPieceID: String?
    public private(set) var errorMessage: String?
    /// False when the server has no study yet; the surfaces then stay hidden.
    public private(set) var isSupported = true

    private let scopeKey: String
    private let client: (any ShannonStudyServing)?
    private var didLoad = false

    public init(scopeKey: String = "local-owner", client: (any ShannonStudyServing)? = ShannonAPIClient()) {
        self.scopeKey = scopeKey
        self.client = client
        if client == nil { isSupported = false }
    }

    public var stories: [ShannonStudyPieceCardDTO] { pieces.filter { $0.isStory && !$0.isPutAway } }
    public var notes: [ShannonStudyPieceCardDTO] { pieces.filter { !$0.isStory && !$0.isPutAway } }
    public var putAway: [ShannonStudyPieceCardDTO] { pieces.filter(\.isPutAway) }

    /// One line for the entrance row.
    public var summary: String {
        if pieces.isEmpty { return isLoading ? ShannonGeneratedStrings.commonLoading : "まだありません" }
        var parts: [String] = []
        if !stories.isEmpty { parts.append("物語 \(stories.count)") }
        if !notes.isEmpty { parts.append("メモ \(notes.count)") }
        return parts.isEmpty ? "しまったもの \(putAway.count)" : parts.joined(separator: " ・ ")
    }

    public func loadIfNeeded() async {
        guard !didLoad else { return }
        didLoad = true
        await reload()
    }

    public func reload() async {
        guard let client, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let overview = try await client.loadStudy(scopeKey: scopeKey)
            pieces = overview.pieces
            if !overview.reactions.isEmpty { reactions = overview.reactions }
            isSupported = true
        } catch let error as ShannonAPIError where error == .rejected(status: 404) {
            // An older server has no study. Nothing is shown rather than a permanent error.
            isSupported = false
        } catch {
            errorMessage = "書斎を読み込めませんでした。接続を確認して、もう一度お試しください。"
        }
    }

    /// A background refresh for a screen that only shows a count: a failure changes nothing and says nothing.
    public func refreshQuietly() async {
        guard let client, !isLoading, let overview = try? await client.loadStudy(scopeKey: scopeKey) else { return }
        pieces = overview.pieces
    }

    public func loadPiece(_ pieceID: String) async {
        guard let client, loadingPieceID != pieceID else { return }
        loadingPieceID = pieceID
        errorMessage = nil
        defer { loadingPieceID = nil }
        do {
            store(try await client.loadStudyPiece(scopeKey: scopeKey, pieceID: pieceID))
        } catch let error as ShannonAPIError where error == .rejected(status: 404) {
            errorMessage = "この作品は見つかりませんでした。"
        } catch {
            errorMessage = "作品を読み込めませんでした。接続を確認して、もう一度お試しください。"
        }
    }

    /// Sends the owner's reaction. Returns true when the server stored it.
    @discardableResult
    public func react(to pieceID: String, reaction: String, comment: String) async -> Bool {
        guard let client, savingPieceID == nil else { return false }
        let trimmed = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count <= ShannonStudyLimits.comment else {
            errorMessage = "感想は\(ShannonStudyLimits.comment)文字までです。"
            return false
        }
        savingPieceID = pieceID
        errorMessage = nil
        defer { savingPieceID = nil }
        do {
            store(try await client.reactToStudyPiece(
                scopeKey: scopeKey, pieceID: pieceID, reaction: reaction, comment: trimmed.isEmpty ? nil : trimmed
            ))
            return true
        } catch let error as ShannonAPIError where error == .rejected(status: 409) {
            errorMessage = "いまは感想を受け取れません。まだ見せてもらっていないか、しまわれたか、感想がたまっています。"
            await loadPiece(pieceID)
            return false
        } catch {
            errorMessage = "感想を送れませんでした。保存されていません。少し待ってもう一度お試しください。"
            return false
        }
    }

    /// Asks her to put a piece away. The text and its versions stay.
    public func putAway(_ pieceID: String) async {
        guard let client, savingPieceID == nil else { return }
        savingPieceID = pieceID
        errorMessage = nil
        defer { savingPieceID = nil }
        do {
            store(try await client.putAwayStudyPiece(scopeKey: scopeKey, pieceID: pieceID))
        } catch {
            errorMessage = "しまうお願いを保存できませんでした。もう一度お試しください。"
        }
    }

    public func dismissError() {
        errorMessage = nil
    }

    private func store(_ detail: ShannonStudyPieceDetailDTO) {
        details[detail.id] = detail
        if let index = pieces.firstIndex(where: { $0.id == detail.id }) {
            pieces[index] = detail.card
        } else {
            pieces.insert(detail.card, at: 0)
        }
    }
}
