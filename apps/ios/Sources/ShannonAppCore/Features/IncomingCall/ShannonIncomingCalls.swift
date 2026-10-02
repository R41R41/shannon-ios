#if os(iOS)
import Foundation
import SwiftUI
import UIKit
@preconcurrency import AVFoundation

/// Calls from Shannon on the iPhone (owner decision 2026-10-03): 「イヤホンをつないでいるとき、アプリを起動して
/// いなくても、シャノンから話しかけていい」. iOS allows that only as an incoming call, so when she reaches out
/// and nothing else can say it, the server sends a VoIP push and the phone rings with a call from 「シャノン」.
///
/// The app sets this up in two steps at every launch, also a launch by the push itself with no window:
/// `configure` when the app object is made, and `activate` when the application finished launching. From
/// then on a push is answered with a call whether or not the owner's switch is on; the switch decides
/// whether the server is given this phone's address at all, and whether a push rings.
@MainActor
public enum ShannonIncomingCalls {
    private static var bridge: ShannonCallKitBridge?
    private static var pending: (@MainActor (ShannonCallKitBridge) -> Void)?
    public private(set) static var settings: ShannonIncomingCallSettings?

    /// Wires a call to the server, the conversation and her voice. `environment` is the push environment of this build.
    public static func configure(
        client: ShannonAPIClient, conversationModel: ShannonConversationModel, environment: ShannonPushEnvironmentDTO,
        connectionStore: ShannonKeychainConnectionStore
    ) -> ShannonIncomingCallSettings {
        let settings = ShannonIncomingCallSettings(
            server: client, environment: environment, bundleID: Bundle.main.bundleIdentifier ?? ""
        )
        settings.setCredentialReadableWhileLocked = { readable in
            do {
                try connectionStore.setReadableWhileLocked(readable)
            } catch {
                ShannonVoiceDiagnostics.shared.record("incoming_call.credential.protection.failed")
            }
        }
        self.settings = settings
        pending = { bridge in
            let speaker = ShannonEarphoneSpeaker(
                streamSpeech: { [conversationModel] text, style, provider in
                    try await conversationModel.streamSpeech(text, style: style, provider: provider)
                },
                monitor: ShannonSystemAudioRouteMonitor()
            )
            let coordinator = ShannonIncomingCallCoordinator(
                server: client, system: bridge, speaker: speaker,
                conversation: ShannonCallConversation(conversationModel: conversationModel)
            )
            // Read where it is stored, at the moment of the push: a launch before the phone's first unlock could not
            // read it, and the same process may still be running when he unlocks.
            coordinator.isEnabled = { UserDefaults.standard.bool(forKey: ShannonIncomingCallSettings.enabledDefaultsKey) }
            // A report leaves after the call is over; iOS would otherwise suspend the app before it is sent.
            coordinator.protect = { work in
                let assertion = ShannonBackgroundAssertion(name: "shannon.incoming-call.report")
                await work()
                assertion.end()
            }
            bridge.coordinator = coordinator
            bridge.tokenChanged = { token in
                guard let token else { return }
                settings.received(token: token)
            }
            ShannonVoiceCallHost.shared.calls = coordinator
        }
        if let bridge { connect(bridge) }
        return settings
    }

    /// Registers with PushKit and CallKit. Called from `application(_:didFinishLaunchingWithOptions:)`, at every launch.
    public static func activate() {
        guard bridge == nil else { return }
        let bridge = ShannonCallKitBridge()
        self.bridge = bridge
        connect(bridge)
    }

    private static func connect(_ bridge: ShannonCallKitBridge) {
        guard let pending else { return }
        self.pending = nil
        pending(bridge)
    }
}

/// The settings section for calls from Shannon (iPhone only). Shows nothing when the app did not set calls up.
public struct ShannonIncomingCallSettingsSection: View {
    @State private var asksToConfirm = false
    @State private var microphone = ShannonMediaPermission.currentMicrophone()
    @Environment(\.colorScheme) private var colorScheme

    public init() {}

    public var body: some View {
        if let settings = ShannonIncomingCalls.settings {
            Section {
                Toggle(isOn: Binding(
                    get: { settings.isEnabled },
                    set: { enabled in
                        // Switching it on is explained first; switching it off needs no question.
                        if enabled { asksToConfirm = true } else { settings.setEnabled(false) }
                    }
                )) {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ShannonIncomingCallCopy.toggleTitle)
                            Text(ShannonIncomingCallCopy.statusText(settings.status))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier("incoming-call-status")
                        }
                    } icon: {
                        Image(systemName: "phone.arrow.down.left").foregroundStyle(ShannonPalette.resolve(colorScheme).action)
                    }
                }
                .frame(minHeight: ShannonTouchTarget.minimum)
                .accessibilityHint(ShannonIncomingCallCopy.toggleHint)
                .accessibilityIdentifier("settings-incoming-call")
                if settings.isEnabled, microphone == .denied {
                    Text(ShannonIncomingCallCopy.microphoneDenied)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text(ShannonIncomingCallCopy.sectionTitle)
            } footer: {
                Text(ShannonIncomingCallCopy.explanation)
            }
            .task { await settings.synchronize() }
            .alert(ShannonIncomingCallCopy.confirmTitle, isPresented: $asksToConfirm) {
                Button(ShannonIncomingCallCopy.confirmAccept) {
                    settings.setEnabled(true)
                    Task {
                        // The conversation after her line needs the microphone, and a call cannot ask for it: it is asked for
                        // here, by the owner's own tap.
                        if microphone == .undetermined { _ = await AVAudioApplication.requestRecordPermission() }
                        microphone = ShannonMediaPermission.currentMicrophone()
                    }
                }
                Button(ShannonIncomingCallCopy.confirmCancel, role: .cancel) {}
            } message: {
                Text(ShannonIncomingCallCopy.confirmMessage)
            }
        }
    }
}
#endif
