import Foundation
import Observation

public enum ShannonModelMode: String, Codable, CaseIterable, Sendable {
    case haiku, sonnet

    public var title: String {
        switch self {
        case .haiku: "通常（Haiku 5.5）"
        case .sonnet: "高精度（Sonnet 5.5）"
        }
    }
}

public struct ShannonModelModeDTO: Codable, Equatable, Sendable {
    static let maximumRevision = 9_007_199_254_740_991 // The server's safe integer contract.
    public let mode: ShannonModelMode
    public let revision: Int
    public let available: Availability
    public let models: Models
    public let appliesTo: [String]
    public struct Availability: Codable, Equatable, Sendable {
        public let haiku: Bool
        public let sonnet: Bool
    }
    public struct Models: Codable, Equatable, Sendable {
        public let haiku: String
        public let sonnet: String
    }
    public func represents(_ mode: ShannonModelMode) -> Bool {
        switch mode {
        case .haiku: models.haiku == "claude-haiku-5-5"
        case .sonnet: models.sonnet == "claude-sonnet-5-5"
        }
    }
    public func isSelected(_ mode: ShannonModelMode) -> Bool { self.mode == mode && represents(mode) }
    public func isAvailable(_ mode: ShannonModelMode) -> Bool {
        guard represents(mode) else { return false }
        return switch mode {
        case .haiku: available.haiku
        case .sonnet: available.sonnet
        }
    }
    public var configuredModelLabel: String? {
        guard !represents(mode) else { return nil }
        let model = (mode == .haiku ? models.haiku : models.sonnet).trimmingCharacters(in: .whitespacesAndNewlines)
        return model.isEmpty ? "現在：サーバー指定モデル" : "現在：サーバー指定モデル（\(model)）"
    }
    public var applicationLabel: String? {
        let labels = appliesTo.compactMap { scope -> String? in
            switch scope {
            case "conversation": "会話"
            case "autonomy-planning": "自律の計画"
            case "minecraft-planning": "Minecraftの主判断"
            default: nil
            }
        }
        return labels.isEmpty ? nil : "適用先：" + labels.joined(separator: "・")
    }
}

/// An opaque, in-memory fence. Tokens never become display state or durable settings.
public struct ShannonModelModeConnection: Equatable, Hashable, Sendable {
    let baseURL: URL
    let scopeKey: String
    let deviceID: String
    private let token: String

    init(_ credential: ShannonConnectionCredential) {
        baseURL = credential.baseURL; scopeKey = credential.scopeKey
        deviceID = credential.deviceID; token = credential.token
    }
}

@MainActor public protocol ShannonModelModeServing: Sendable {
    func modelModeConnection() -> ShannonModelModeConnection?
    func loadModelMode(connection: ShannonModelModeConnection) async throws -> ShannonModelModeDTO
    func setModelMode(_ mode: ShannonModelMode, expectedRevision: Int, connection: ShannonModelModeConnection) async throws -> ShannonModelModeDTO
}

public enum ShannonModelModeAPIError: Error, Equatable {
    case pairingRequired
    case connectionChanged
    case rejected(status: Int)
}

@MainActor @Observable
public final class ShannonModelModeModel {
    public private(set) var snapshot: ShannonModelModeDTO?
    public private(set) var isLoading = false
    public private(set) var isSaving = false
    public private(set) var isFresh = false
    public private(set) var isUnsupported = false
    public private(set) var needsConfirmation = false
    public private(set) var notice: String?
    public private(set) var savingMode: ShannonModelMode?
    private let scopeKey: String
    private let client: (any ShannonModelModeServing)?
    private var connection: ShannonModelModeConnection?
    private var generation = 0

    public init(scopeKey: String, client: (any ShannonModelModeServing)?) {
        self.scopeKey = scopeKey; self.client = client
    }

    public var connectionIdentity: ShannonModelModeConnection? {
        guard let value = client?.modelModeConnection(), value.scopeKey == scopeKey else { return nil }
        return value
    }
    public var canChange: Bool {
        isFresh && !isLoading && !isSaving && !needsConfirmation && !isUnsupported && connectionIdentity != nil
    }
    public var statusText: String {
        if isSaving { return "保存しています…" }
        if isLoading { return needsConfirmation ? "現在の設定を確かめています…" : "読み込んでいます…" }
        if needsConfirmation { return "変更が届いたか確認できません。現在の設定を読み直してください。" }
        if isUnsupported { return "このサーバーはモデルの切替に対応していません。" }
        if connectionIdentity == nil { return "シャノンに接続すると切り替えられます。" }
        return snapshot == nil ? "現在の設定は未確認です。" : (isFresh ? "端末間で共通の設定です。" : "前回確認した設定を表示しています。")
    }

    public func connectionDidChange() {
        guard connection != connectionIdentity else { return }
        generation += 1; connection = connectionIdentity
        snapshot = nil; isFresh = false; isLoading = false; isSaving = false
        isUnsupported = false; needsConfirmation = false; notice = nil; savingMode = nil
    }

    public func reload() async {
        connectionDidChange()
        guard let client, let context = connection, !isSaving else { return }
        generation += 1; let epoch = generation
        isLoading = true; isFresh = false; notice = nil
        defer { if generation == epoch { isLoading = false } }
        do {
            let value = try await client.loadModelMode(connection: context)
            guard acceptContext(context, epoch: epoch), !Task.isCancelled else { return }
            guard (0...ShannonModelModeDTO.maximumRevision).contains(value.revision),
                  value.revision >= (snapshot?.revision ?? 0) else { throw ShannonAPIError.invalidResponse }
            snapshot = value; isFresh = true; isUnsupported = false
            if needsConfirmation { notice = "現在の設定を読み直しました。" }
            needsConfirmation = false
        } catch {
            guard acceptContext(context, epoch: epoch), !Task.isCancelled else { return }
            handleReadFailure(error)
        }
    }

    public func select(_ mode: ShannonModelMode) async {
        connectionDidChange()
        guard let client, let context = connection, canChange, let current = snapshot,
              current.mode != mode, current.isAvailable(mode) else { return }
        generation += 1; let epoch = generation
        isSaving = true; savingMode = mode; notice = nil
        do {
            let value = try await client.setModelMode(mode, expectedRevision: current.revision, connection: context)
            guard acceptContext(context, epoch: epoch) else { return }
            guard value.mode == mode, value.revision == current.revision + 1 else { throw ShannonAPIError.invalidResponse }
            snapshot = value; isFresh = true; isSaving = false; savingMode = nil
            notice = "次に始まる処理から反映されます。"
        } catch {
            guard acceptContext(context, epoch: epoch) else { return }
            isSaving = false; savingMode = nil; isFresh = false
            if let failure = error as? ShannonModelModeAPIError, case .rejected(let status) = failure,
               [400, 401, 403, 404, 409].contains(status) {
                if status == 404 { isUnsupported = true; notice = nil; return }
                if status == 401 || status == 403 { snapshot = nil; notice = "接続を確認してください。"; return }
                await reload()
                if context == connectionIdentity { notice = "変更されませんでした。最新の設定を確認してください。" }
            } else {
                needsConfirmation = true
                await reload() // A GET checks current state; it never resends the uncertain PUT.
            }
        }
    }

    private func acceptContext(_ expected: ShannonModelModeConnection, epoch: Int) -> Bool {
        guard expected == connectionIdentity else { connectionDidChange(); return false }
        return generation == epoch && connection == expected
    }
    private func handleReadFailure(_ error: Error) {
        if let failure = error as? ShannonModelModeAPIError, case .rejected(let status) = failure {
            if status == 404 { isUnsupported = true; return }
            if status == 401 || status == 403 { snapshot = nil }
        }
        notice = "設定を読み込めません。接続を確認して、読み直してください。"
    }
}
