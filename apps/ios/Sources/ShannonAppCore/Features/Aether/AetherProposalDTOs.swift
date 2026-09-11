import Foundation

public struct AetherProposalRequestDTO: Codable, Equatable, Sendable {
    public let scopeKey: String
    public let title: String
    public let content: String
    public let reason: String
}

public struct AetherProposalResponseDTO: Codable, Equatable, Sendable {
    public let id: String
    public let operation: String
    public let title: String
    public let content: String
    public let reason: String
    public let createdAt: String
}
