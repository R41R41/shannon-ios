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

/// One of the Mac's microphones. `id` is Core Audio's unique id, which stays the same across launches.
public struct ShannonVoiceInputDevice: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let isBuiltIn: Bool

    public init(id: String, name: String, isBuiltIn: Bool) {
        self.id = id
        self.name = name
        self.isBuiltIn = isBuiltIn
    }
}

/// Resolves the Mac's chosen microphone against the ones connected now. As on the iPhone, a missing
/// choice never fails the call: the system's input is used for it, the choice is kept, and the state says so.
public enum ShannonMacVoiceInputRouting {
    public struct Resolution: Equatable, Sendable {
        /// The microphone to use, or nil for the system's input.
        public let deviceID: String?
        public let isPreferenceUnavailable: Bool
    }

    public static func resolve(selectedID: String?, devices: [ShannonVoiceInputDevice]) -> Resolution {
        guard let selectedID else { return Resolution(deviceID: nil, isPreferenceUnavailable: false) }
        guard devices.contains(where: { $0.id == selectedID }) else {
            return Resolution(deviceID: nil, isPreferenceUnavailable: true)
        }
        return Resolution(deviceID: selectedID, isPreferenceUnavailable: false)
    }
}
