import Foundation

/// Owner-side access to Shannon's study. The owner reads, reacts, and may ask her to
/// put a piece away; there is no call that writes or edits her text.
public protocol ShannonStudyServing: Sendable {
    func loadStudy(scopeKey: String) async throws -> ShannonStudyOverviewDTO
    func loadStudyPiece(scopeKey: String, pieceID: String) async throws -> ShannonStudyPieceDetailDTO
    func reactToStudyPiece(scopeKey: String, pieceID: String, reaction: String, comment: String?) async throws -> ShannonStudyPieceDetailDTO
    func putAwayStudyPiece(scopeKey: String, pieceID: String) async throws -> ShannonStudyPieceDetailDTO
}

extension ShannonAPIClient: ShannonStudyServing {
    public func loadStudy(scopeKey: String) async throws -> ShannonStudyOverviewDTO {
        try await response(ShannonStudyOverviewDTO.self, for: autonomyGet("/v1/autonomy/study", scopeKey: scopeKey))
    }

    public func loadStudyPiece(scopeKey: String, pieceID: String) async throws -> ShannonStudyPieceDetailDTO {
        try await response(
            ShannonStudyPieceDetailDTO.self,
            for: autonomyGet("/v1/autonomy/study/pieces/\(try Self.pathComponent(pieceID))", scopeKey: scopeKey)
        )
    }

    public func reactToStudyPiece(
        scopeKey: String,
        pieceID: String,
        reaction: String,
        comment: String?
    ) async throws -> ShannonStudyPieceDetailDTO {
        let connection = currentConnection()
        return try await response(ShannonStudyPieceDetailDTO.self, for: autonomyPost(
            "/v1/autonomy/study/pieces/\(try Self.pathComponent(pieceID))/reaction",
            body: ShannonStudyReactionRequestDTO(scopeKey: connection?.scopeKey ?? scopeKey, reaction: reaction, comment: comment),
            connection: connection
        ))
    }

    public func putAwayStudyPiece(scopeKey: String, pieceID: String) async throws -> ShannonStudyPieceDetailDTO {
        let connection = currentConnection()
        return try await response(ShannonStudyPieceDetailDTO.self, for: autonomyPost(
            "/v1/autonomy/study/pieces/\(try Self.pathComponent(pieceID))/put-away",
            body: ShannonStudyScopeRequestDTO(scopeKey: connection?.scopeKey ?? scopeKey),
            connection: connection
        ))
    }
}
