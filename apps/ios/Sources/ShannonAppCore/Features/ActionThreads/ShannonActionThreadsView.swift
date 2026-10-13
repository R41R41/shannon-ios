import SwiftUI

public struct ShannonActionThreadsCapsule: View {
    private let model: ShannonActionThreadsModel
    private let compact: Bool
    @State private var showsList = false
    @FocusState private var capsuleFocused: Bool
    @Environment(\.colorScheme) private var colorScheme
    public init(model: ShannonActionThreadsModel, compact: Bool = false) { self.model = model; self.compact = compact }
    public var body: some View {
        if model.showsCapsule {
            let palette = ShannonPalette.resolve(colorScheme)
            Button { showsList = true } label: {
                Label(compact && model.othersPresent ? ShannonGeneratedStrings.threadsGeneric : model.capsuleText,
                      systemImage: model.phase == .recovering ? "arrow.triangle.2.circlepath" : "square.stack.3d.up")
                    .font(.shannon(.callout)).foregroundStyle(palette.textSecondary)
                    .padding(.horizontal, ShannonSpacing.medium).frame(minHeight: 44)
                    .background(palette.subtleSurface, in: Capsule())
            }
            .buttonStyle(.plain).focusable().focused($capsuleFocused)
            .accessibilityIdentifier(compact ? "action-threads-avatar" : "action-threads-capsule")
            .accessibilityHint(ShannonGeneratedStrings.threadsTitle)
#if os(iOS)
            .sheet(isPresented: $showsList, onDismiss: { capsuleFocused = true }) {
                ShannonActionThreadsList(model: model).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            }
#else
            .popover(isPresented: $showsList) { ShannonActionThreadsList(model: model).frame(width: 400, height: 450) }
            .onChange(of: showsList) { if !showsList { capsuleFocused = true } }
#endif
        }
    }
}

struct ShannonActionThreadsList: View {
    let model: ShannonActionThreadsModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
#if os(iOS)
        NavigationStack {
            contents
                .navigationTitle(ShannonGeneratedStrings.threadsTitle)
                .toolbar { ToolbarItem(placement: .confirmationAction) { closeButton } }
        }
#else
        VStack(spacing: 0) {
            HStack {
                Text(ShannonGeneratedStrings.threadsTitle).font(.headline)
                Spacer()
                closeButton
            }.padding(ShannonSpacing.medium)
            Divider()
            contents
        }
#endif
    }
    private var closeButton: some View {
        Button(ShannonGeneratedStrings.threadsClose) { dismiss() }
            .keyboardShortcut(.cancelAction).frame(minHeight: 44)
    }
    private var contents: some View {
        TimelineView(.periodic(from: .now, by: 5)) { clock in
            let stale = model.isStale(at: clock.date)
#if os(iOS)
            List { rows(stale: stale) }
#else
            ScrollView {
                VStack(alignment: .leading, spacing: ShannonSpacing.medium) { rows(stale: stale) }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(ShannonSpacing.medium)
            }
#endif
        }
    }
    private func originText(_ origin: String) -> String {
        switch origin {
        case "maintenance": ShannonGeneratedStrings.threadsMaintenanceOrigin
        case "own_time": ShannonGeneratedStrings.threadsOwnTimeOrigin
        default: ShannonGeneratedStrings.threadsOwnerOrigin
        }
    }
    @ViewBuilder private func rows(stale: Bool) -> some View {
        if model.othersPresent { Text(ShannonGeneratedStrings.threadsPrivate) }
        else {
            if model.phase == .loading { ProgressView(ShannonGeneratedStrings.threadsLoading) }
            if model.phase == .recovering { Label(ShannonGeneratedStrings.threadsRecovering, systemImage: "wifi.slash") }
            if stale && model.phase == .loaded { Label(ShannonGeneratedStrings.threadsStale, systemImage: "clock.badge.exclamationmark") }
            if model.threads.isEmpty && model.phase == .loaded { Text(ShannonGeneratedStrings.threadsEmpty) }
            ForEach(model.threads) { thread in
                VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                    Text(thread.title).font(.headline)
                    Label(stateText(thread.state), systemImage: stateSymbol(thread.state))
                    Text(originText(thread.origin))
                        .font(.caption).foregroundStyle(ShannonPalette.resolve(colorScheme).textSecondary)
                    if thread.state == "unknown" {
                        Text(ShannonGeneratedStrings.threadsUnknownDetail).font(.callout)
                        if let notification = thread.notification {
                            if notification.acknowledgedAt != nil {
                                Text(ShannonGeneratedStrings.threadsNoticeAcknowledged).font(.callout)
                            } else {
                                Text(ShannonGeneratedStrings.threadsNoticeMeaning).font(.callout)
                                Button(ShannonGeneratedStrings.threadsNoticeAcknowledge) {
                                    Task { await model.acknowledgeNotice(id: thread.id, notificationID: notification.id) }
                                }
                                .buttonStyle(.borderless).frame(minHeight: 44)
                                .disabled(model.controlPending || stale || model.phase != .loaded)
                                .accessibilityLabel("\(thread.title)、\(ShannonGeneratedStrings.threadsNoticeAcknowledge)")
                                .accessibilityIdentifier("action-notice-acknowledge-\(thread.id)")
                            }
                        }
                    }
                    if thread.failures >= 5 { Text(ShannonGeneratedStrings.threadsFiveFailures).font(.callout) }
                    if ["queued", "running", "waiting"].contains(thread.state) {
                        Button(ShannonGeneratedStrings.threadsStop, role: .destructive) { Task { await model.control(id: thread.id) } }
                            .buttonStyle(.borderless).frame(minHeight: 44).disabled(model.controlPending || stale || model.phase != .loaded)
                            .accessibilityLabel("\(thread.title)、\(ShannonGeneratedStrings.threadsStop)")
                    } else if thread.canResume {
                        Button(ShannonGeneratedStrings.threadsResume) { Task { await model.control(id: thread.id, resume: true) } }
                            .buttonStyle(.borderless).frame(minHeight: 44).disabled(model.controlPending || stale || model.phase != .loaded)
                    }
                }.padding(.vertical, ShannonSpacing.extraSmall)
                    .accessibilityElement(children: .contain)
#if os(macOS)
                Divider()
#endif
            }
            if (model.reading?.count ?? 0) > 0 {
                Button(ShannonGeneratedStrings.threadsStopAll, role: .destructive) { Task { await model.control(id: nil) } }
                    .buttonStyle(.borderless).frame(minHeight: 44).disabled(model.controlPending || stale || model.phase != .loaded)
            }
            if let notice = model.notice { Text(notice).font(.callout).accessibilityIdentifier("action-control-notice") }
            if model.controlPending { ProgressView(ShannonGeneratedStrings.threadsChecking) }
            Button(ShannonGeneratedStrings.threadsRefresh) { Task { await model.reload() } }.frame(minHeight: 44)
        }
    }

    private func stateText(_ state: String) -> String {
        switch state {
        case "unknown": ShannonGeneratedStrings.threadsUnknownState
        case "queued": ShannonGeneratedStrings.threadsQueued
        case "running": ShannonGeneratedStrings.threadsRunning
        case "waiting": ShannonGeneratedStrings.threadsWaiting
        case "stopping": ShannonGeneratedStrings.threadsStopping
        case "completed": ShannonGeneratedStrings.threadsCompleted
        case "failed": ShannonGeneratedStrings.threadsFailed
        case "cancelled": ShannonGeneratedStrings.threadsCancelled
        default: ShannonGeneratedStrings.threadsUnknown
        }
    }
    private func stateSymbol(_ state: String) -> String {
        switch state {
        case "completed": "checkmark.circle"
        case "cancelled": "stop.circle"
        case "unknown", "failed": "exclamationmark.triangle"
        case "stopping": "stop.circle.dotted"
        case "queued", "waiting": "clock"
        default: "gearshape.2"
        }
    }
}

public struct ShannonActionThreadsPolling: ViewModifier {
    let model: ShannonActionThreadsModel
    let connected: Bool
    let others: Bool
    @Environment(\.scenePhase) private var scenePhase
    public init(model: ShannonActionThreadsModel, connected: Bool, othersPresent: Bool) {
        self.model = model; self.connected = connected; self.others = othersPresent
    }
    public func body(content: Content) -> some View {
        content
            .onChange(of: others, initial: true) { model.reset(othersPresent: others, disconnected: !connected) }
            .onChange(of: connected) { model.reset(othersPresent: others, disconnected: !connected) }
            .task(id: "\(connected)|\(others)|\(scenePhase)") {
                guard connected, scenePhase == .active else { return }
                while !Task.isCancelled {
                    await model.reload()
                    if model.phase == .hidden { return }
                    do { try await Task.sleep(for: .seconds(3)) } catch { return }
                }
            }
    }
}
