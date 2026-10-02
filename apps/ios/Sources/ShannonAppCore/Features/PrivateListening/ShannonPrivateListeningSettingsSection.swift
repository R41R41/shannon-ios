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
                    Text("\(output.name)：\(ShannonPrivateListeningCopy.outputDescription(output, registered: model.registered))")
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
    /// `runsInBackground` is false for an app that is suspended when it leaves the foreground.
    func shannonPrivateListening(_ model: ShannonPrivateListeningModel, runsInBackground: Bool) -> some View {
        modifier(ShannonPrivateListeningLifecycle(model: model, runsInBackground: runsInBackground))
    }
}

private struct ShannonPrivateListeningLifecycle: ViewModifier {
    let model: ShannonPrivateListeningModel
    let runsInBackground: Bool
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .environment(model)
            .task { model.start() }
            .onChange(of: scenePhase) {
                guard !runsInBackground else { return }
                model.isAppRunning = scenePhase != .background
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
