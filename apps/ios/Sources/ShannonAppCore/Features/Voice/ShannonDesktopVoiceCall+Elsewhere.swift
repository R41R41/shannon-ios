#if os(macOS)
import AppKit
import SwiftUI

public extension Notification.Name {
    /// The call asked the window to show Talk (トークに戻る in the menu bar).
    static let shannonDesktopReturnToTalk = Notification.Name("ShannonDesktopReturnToTalk")
}

/// The call while the owner is not in Talk (owner decision 2026-10-06, option B): a row at the bottom of the
/// sidebar on every page, and the menu bar while no window of the app is on screen.
extension ShannonDesktopVoiceCall {
    /// The call is shown in the menu bar: it is on, and no window is on screen.
    public var showsInMenuBar: Bool { isShown && !windowsOnScreen }

    /// 「聞いています」「ミュート中」…, the same words as the call's status line.
    public var phaseTitle: String {
        ShannonGeminiLiveStatusPresentation(phase: session.phase, isMuted: session.isMicrophoneMuted).title
    }

    /// 「音声会話・聞いています」.
    public var rowTitle: String { ShannonGeneratedStrings.voiceMacRowTitle(phase: phaseTitle) }

    /// The call's time, or nil before it was ready to listen.
    public func durationText(at now: Date = Date()) -> String? {
        session.callStartedAt.map { ShannonVoiceCallDuration.text(seconds: Int(now.timeIntervalSince($0))) }
    }

    func durationAccessibilityText(at now: Date = Date()) -> String? {
        session.callStartedAt.map { ShannonVoiceCallDuration.accessibilityText(seconds: Int(now.timeIntervalSince($0))) }
    }

    /// The row and the menu read: 「音声会話・聞いています、通話時間 3分12秒」.
    func spokenSummary(at now: Date = Date()) -> String {
        [rowTitle, durationAccessibilityText(at: now)].compactMap { $0 }.joined(separator: "、")
    }

    /// トークに戻る: the window comes back (unhidden, out of the Dock) and shows Talk.
    /// The window is one that shows the app's root view and is visible or in the Dock: the one the owner used
    /// last, else another. With none, a new window opens on Talk.
    public func returnToTalk() {
        let app = NSApplication.shared
        if app.isHidden { app.unhide(nil) }
        app.activate()
        guard let window = Self.windowToReturnTo(hosts: rootWindows, last: lastMainWindow) else {
            openTalkWindow?()
            return
        }
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NotificationCenter.default.post(name: .shannonDesktopReturnToTalk, object: window)
    }

    /// The windows that show the app's root view now.
    var rootWindows: [NSWindow] { windowHosts.values.compactMap(\.window) }

    /// The window of the root view `id` (nil: it has none yet, or no longer).
    public func window(_ window: NSWindow?, hosts id: UUID) {
        if let window { windowHosts[id] = DesktopWindowRef(window: window) } else { windowHosts[id] = nil }
    }

    static func windowToReturnTo(hosts: [NSWindow], last: NSWindow?) -> NSWindow? {
        let usable = hosts.filter { $0.isVisible || $0.isMiniaturized }
        return usable.first { $0 === last } ?? usable.first
    }

    /// Re-reads whether a window is on screen.
    func updateWindowsOnScreen() {
        let onScreen = windowsOnScreenProbe()
        if windowsOnScreen != onScreen { windowsOnScreen = onScreen }
        menuSection?.refresh()
    }

    /// A window counts when it could be the main window and the system says some of it is visible.
    static func anyWindowOnScreen() -> Bool {
        let app = NSApplication.shared
        guard !app.isHidden else { return false }
        return app.windows.contains {
            $0.canBecomeMain && $0.isVisible && !$0.isMiniaturized && $0.occlusionState.contains(.visible)
        }
    }

    /// Follows the windows and the app, and keeps the menu bar part current.
    func followWindows(menuBar: ShannonDesktopMenuBar?) {
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            NSApplication.didHideNotification, NSApplication.didUnhideNotification,
            NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification,
            NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification,
            NSWindow.willCloseNotification, NSWindow.didBecomeKeyNotification,
            NSWindow.didChangeOcclusionStateNotification,
        ]
        for name in names {
            windowObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                // A closing window is still listed while it closes: read again once it is gone.
                Task { @MainActor [weak self] in self?.updateWindowsOnScreen() }
            })
        }
        updateWindowsOnScreen()
        windowObservers.append(center.addObserver(forName: NSWindow.didBecomeMainNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                // The window that just became main is the app's main window now.
                if let window = NSApplication.shared.mainWindow, window.canBecomeMain { self?.lastMainWindow = window }
            }
        })
        guard let menuBar else { return }
        let section = ShannonDesktopVoiceCallMenuSection(call: self, menuBar: menuBar)
        menuSection = section
        menuBar.register(section)
        section.follow()
    }
}

/// The call's part of the app's menu bar item: the button shows her phase and the call's time; the menu has
/// トークに戻る, ミュート／ミュートを解除 and 音声会話を終了する. It is there only while the call is on and no
/// window is on screen, and goes when the call ends.
@MainActor
final class ShannonDesktopVoiceCallMenuSection: ShannonDesktopMenuBarSection {
    private weak var call: ShannonDesktopVoiceCall?
    private weak var menuBar: ShannonDesktopMenuBar?
    private var ticker: Task<Void, Never>?

    init(call: ShannonDesktopVoiceCall, menuBar: ShannonDesktopMenuBar) {
        self.call = call
        self.menuBar = menuBar
    }

    var wantsMenuBarItem: Bool { call?.showsInMenuBar ?? false }

    var menuBarButton: ShannonDesktopMenuBarButton? {
        guard let call, call.showsInMenuBar else { return nil }
        let title = [call.phaseTitle, call.durationText()].compactMap { $0 }.joined(separator: " ")
        return ShannonDesktopMenuBarButton(title: title, symbol: "waveform", accessibilityLabel: call.spokenSummary())
    }

    func menuBarItems() -> [NSMenuItem] {
        guard let call else { return [] }
        let header = ShannonDesktopMenuItem.caption(call.spokenSummary())
        let back = ShannonDesktopMenuItem(ShannonGeneratedStrings.voiceMacReturnToTalk, symbol: "bubble.left.and.bubble.right") { [weak call] in
            call?.returnToTalk()
        }
        // A toggle in a macOS menu keeps its name and shows its state with a checkmark.
        let mute = ShannonDesktopMenuItem(
            ShannonGeneratedStrings.voiceMacMute, symbol: "mic.slash",
            state: call.session.isMicrophoneMuted ? .on : .off
        ) { [weak call] in call?.session.toggleMicrophoneMute() }
        mute.isEnabled = call.holdsMicrophone
        let end = ShannonDesktopMenuItem(ShannonGeneratedStrings.voiceMacEndLabel, symbol: "phone.down.fill") { [weak call] in
            call?.end()
        }
        return [header, back, mute, end]
    }

    func refresh() { menuBar?.refresh() }

    /// Updates the item when the call changes, and every second for its time while it is shown.
    func follow() {
        guard let call else { return }
        withObservationTracking {
            _ = call.showsInMenuBar
            _ = call.session.phase
            _ = call.session.isMicrophoneMuted
            _ = call.session.callStartedAt
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                self?.changed()
                self?.follow()
            }
        }
        changed()
    }

    private func changed() {
        refresh()
        let shown = wantsMenuBarItem
        if shown, ticker == nil {
            ticker = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(1))
                    guard let self else { return }
                    self.refresh()
                }
            }
        } else if !shown {
            ticker?.cancel()
            ticker = nil
        }
    }
}

/// The call at the bottom of the sidebar, the same on every page: 「音声会話・〈いまの段階〉」, the call's time,
/// mute and 終了. Clicking the row shows Talk.
public struct ShannonDesktopVoiceCallRow: View {
    private let call: ShannonDesktopVoiceCall
    private let openTalk: () -> Void

    public init(call: ShannonDesktopVoiceCall, openTalk: @escaping () -> Void) {
        self.call = call
        self.openTalk = openTalk
    }

    public var body: some View {
        if call.isShown {
            HStack(spacing: ShannonDesktopSpacing.small) {
                Button(action: openTalk) {
                    HStack(spacing: ShannonDesktopSpacing.small) {
                        Image(systemName: "waveform")
                            .foregroundStyle(Color.shannonIntelligenceColor)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(call.rowTitle)
                                .lineLimit(1)
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                if let duration = call.durationText(at: context.date) {
                                    Text(duration)
                                        .font(.shannonDesktop(.caption).monospacedDigit())
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(call.spokenSummary())
                .accessibilityHint(ShannonGeneratedStrings.voiceMacRowHint)
                .accessibilityAddTraits(.isButton)
                .help(ShannonGeneratedStrings.voiceMacRowHint)
                .accessibilityIdentifier("sidebar-voice-call")

                let muted = call.session.isMicrophoneMuted
                Button(action: call.session.toggleMicrophoneMute) {
                    Image(systemName: muted ? "mic.slash.fill" : "mic.fill")
                }
                .buttonStyle(.borderless)
                .disabled(!call.holdsMicrophone)
                // The symbol shows the state (as the menu's checkmark does); the hint says what a click does.
                .help(muted ? ShannonGeneratedStrings.voiceMacUnmute : ShannonGeneratedStrings.voiceMacMute)
                .accessibilityLabel(ShannonGeneratedStrings.voiceMacMute)
                .accessibilityValue(ShannonGeminiLiveMicrophoneControl(isMuted: muted).accessibilityValue)
                .accessibilityIdentifier("sidebar-voice-call-mute")

                Button(action: call.end) {
                    Image(systemName: "phone.down.fill")
                        .foregroundStyle(Color.shannonDanger)
                }
                .buttonStyle(.borderless)
                .help(ShannonGeneratedStrings.voiceMacEndLabel)
                .accessibilityLabel(ShannonGeneratedStrings.voiceMacEndLabel)
                .accessibilityIdentifier("sidebar-voice-call-end")
            }
            .font(.shannonDesktop(.callout))
            .padding(.horizontal, ShannonDesktopSpacing.medium)
            .frame(minHeight: ShannonDesktopMetrics.rowHeight)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(ShannonGeneratedStrings.voiceName)
        }
    }
}
#endif
