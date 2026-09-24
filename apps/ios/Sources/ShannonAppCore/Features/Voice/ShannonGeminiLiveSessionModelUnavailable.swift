#if !os(iOS)
import Observation

public enum ShannonGeminiLivePhase: String, Equatable, Sendable {
    case idle
    case requestingPermission
    case connecting
    case listening
    case thinking
    case speaking
    case reconnecting
    case failed
}

@MainActor
@Observable
public final class ShannonGeminiLiveSessionModel {
    public init() {}
    public func stop() {}
}
#endif
