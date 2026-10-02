import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The settings section for earphones, shared by the iPhone and Mac apps: what the sound comes out
/// of now, the earphones the owner registered, and whether Shannon is being told "only I can hear".
/// It shows nothing when the app did not provide a model.
public struct ShannonPrivateListeningSettingsSection: View {
    @Environment(ShannonPrivateListeningModel.self) private var model: ShannonPrivateListeningModel?

    public init() {}

    public var body: some View {
        if let model {
            ShannonPrivateListeningSectionContent(model: model)
        }
    }
}

struct ShannonPrivateListeningSectionContent: View {
    let model: ShannonPrivateListeningModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Section {
            currentOutputRow
            if let output = model.registrableOutput {
                Button(ShannonPrivateListeningCopy.registerTitle(output.name)) {
                    model.registerCurrentOutput()
                }
                .frame(minHeight: ShannonTouchTarget.minimum)
                .accessibilityIdentifier("settings-earphones-register")
            }
            ForEach(model.registered) { earphones in
                registeredRow(earphones)
            }
            Toggle(ShannonPrivateListeningCopy.wiredTitle, isOn: Binding(
                get: { model.wiredCountsAsPrivate },
                set: { counts in model.setWiredCountsAsPrivate(counts) }
            ))
            .frame(minHeight: ShannonTouchTarget.minimum)
            .accessibilityHint(ShannonPrivateListeningCopy.wiredHint)
            .accessibilityIdentifier("settings-earphones-wired")
            LabeledContent(ShannonPrivateListeningCopy.statusTitle) {
                Text(ShannonPrivateListeningCopy.statusText(model.status))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
                    .accessibilityIdentifier("private-listening-status")
            }
            .frame(minHeight: ShannonTouchTarget.minimum)
        } header: {
            Text(ShannonPrivateListeningCopy.sectionTitle)
        } footer: {
            Text(ShannonPrivateListeningCopy.explanation)
        }
        .onAppear { model.evaluate() }

        Section {
            Toggle(isOn: Binding(
                get: { model.speaksEnabled },
                set: { enabled in setSpeaks(enabled) }
            )) {
                statusLabel(
                    ShannonPrivateListeningCopy.speaksTitle,
                    status: ShannonPrivateListeningCopy.speaksStatus(
                        enabled: model.speaksEnabled, speaksNow: model.speaksNow, serverDelivers: model.serverDelivers || model.status != .reported
                    ),
                    symbol: "waveform", identifier: "earphone-speaking-status"
                )
            }
            .frame(minHeight: ShannonTouchTarget.minimum)
            .accessibilityHint(ShannonPrivateListeningCopy.speaksHint)
            .accessibilityIdentifier("settings-earphone-speaking")
            if model.speaksEnabled, !model.microphoneIsPermitted {
                Text(ShannonPrivateListeningCopy.microphoneDenied)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
#if os(iOS)
            Toggle(isOn: Binding(
                get: { model.standbyEnabled },
                set: { enabled in model.setStandbyEnabled(enabled) }
            )) {
                statusLabel(
                    ShannonPrivateListeningCopy.standbyTitle,
                    status: ShannonPrivateListeningCopy.standbyStatus(
                        model.standbyState, enabled: model.speaksEnabled && model.standbyEnabled, lowPowerMode: model.isLowPowerMode
                    ),
                    symbol: "moon.zzz", identifier: "earphone-standby-status"
                )
            }
            .disabled(!model.speaksEnabled)
            .frame(minHeight: ShannonTouchTarget.minimum)
            .accessibilityHint(ShannonPrivateListeningCopy.standbyHint)
            .accessibilityIdentifier("settings-earphone-standby")
#endif
        } footer: {
#if os(macOS)
            Text(ShannonPrivateListeningCopy.speaksExplanation)
#else
            Text(ShannonPrivateListeningCopy.speaksExplanation + "\n\n" + ShannonPrivateListeningCopy.standbyExplanation)
#endif
        }
    }

    private func setSpeaks(_ enabled: Bool) {
        model.setSpeaksEnabled(enabled)
#if os(macOS)
        // The Mac has no voice conversation that would have asked before: the answer needs the microphone.
        if enabled { Task { await model.requestMicrophoneForAnswers() } }
#endif
    }

    private func statusLabel(_ title: String, status: String, symbol: String, identifier: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(status)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(identifier)
            }
        } icon: {
#if os(iOS)
            Image(systemName: symbol).foregroundStyle(ShannonPalette.resolve(colorScheme).action)
#else
            Image(systemName: symbol)
#endif
        }
    }

    private var currentOutputRow: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(ShannonPrivateListeningCopy.currentOutputTitle)
                if model.outputs.isEmpty {
                    Text(ShannonPrivateListeningCopy.noOutput)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(model.outputs, id: \.id) { output in
                    Text("\(output.name)：\(ShannonPrivateListeningCopy.outputDescription(output, registered: model.registered, wiredCountsAsPrivate: model.wiredCountsAsPrivate))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
#if os(iOS)
            Image(systemName: "headphones").foregroundStyle(ShannonPalette.resolve(colorScheme).action)
#else
            Image(systemName: "headphones")
#endif
        }
        .frame(minHeight: ShannonTouchTarget.minimum)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("settings-earphones-current")
    }

    private func registeredRow(_ earphones: ShannonRegisteredEarphones) -> some View {
        LabeledContent {
            Button(ShannonPrivateListeningCopy.removeTitle, role: .destructive) {
                model.removeRegistration(id: earphones.id)
            }
            .accessibilityLabel(ShannonPrivateListeningCopy.removeAccessibilityLabel(earphones.name))
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(earphones.name)
                Text(ShannonPrivateListeningCopy.registeredTitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(minHeight: ShannonTouchTarget.minimum)
    }
}

public extension View {
    /// Provides the model to the settings and keeps Shannon told while only the owner can hear.
    func shannonPrivateListening(_ model: ShannonPrivateListeningModel) -> some View {
        modifier(ShannonPrivateListeningLifecycle(model: model))
    }
}

private struct ShannonPrivateListeningLifecycle: ViewModifier {
    let model: ShannonPrivateListeningModel
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .environment(model)
            .task { model.start() }
            .onChange(of: scenePhase, initial: true) {
                model.isInForeground = scenePhase != .background
            }
            .onReceive(NotificationCenter.default.publisher(for: Self.willTerminate)) { _ in
                // Best effort: a report that is not renewed lapses on the server anyway.
                Task { await model.withdraw() }
            }
    }

    private static var willTerminate: Notification.Name {
#if canImport(UIKit)
        UIApplication.willTerminateNotification
#else
        NSApplication.willTerminateNotification
#endif
    }
}
