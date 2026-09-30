import Foundation

/// Resolves the saved microphone choice against the inputs connected right now.
///
/// A chosen input that is missing never fails the call. Routing falls back to the
/// system's automatic choice for this call, the saved choice is kept, and the
/// input state says so. When the chosen input reappears, the next route change
/// applies it again.
public enum ShannonVoiceInputRouting {
    public struct Resolution: Equatable, Sendable {
        /// Index into the available inputs to prefer, or `nil` for automatic routing.
        public let preferredIndex: Int?
        public let isPreferenceUnavailable: Bool
    }

    public static func resolve(
        _ preference: ShannonVoiceInputPreference,
        inputIsBuiltIn: [Bool]
    ) -> Resolution {
        let match: Int?
        switch preference {
        case .automatic: return Resolution(preferredIndex: nil, isPreferenceUnavailable: false)
        case .builtIn: match = inputIsBuiltIn.firstIndex(of: true)
        case .connected: match = inputIsBuiltIn.firstIndex(of: false)
        }
        return Resolution(preferredIndex: match, isPreferenceUnavailable: match == nil)
    }
}
