import SwiftUI

/// A small activity entry beside the conversation input: only work that is in progress or waiting. Finished
/// work leaves it at once (「いま」 keeps it); a swipe hides a row without stopping the work. Call phase stays separate.
public struct ShannonNowCompact: View {
    let model: ShannonConversationActivityModel
    @State private var showsDetails = false
    @State private var dragOffset: CGFloat = 0
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public init(model: ShannonConversationActivityModel) { self.model = model }
    public var body: some View {
        if model.showsStrip {
            let palette = ShannonPalette.resolve(colorScheme)
            let featured = model.stripFeatured
            Button { showsDetails = true } label: {
                HStack(alignment: .center, spacing: ShannonSpacing.small) {
                    Image(systemName: featured?.symbol ?? "gearshape.2")
                        .foregroundStyle(palette.intelligenceSky)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.state == .privateAudience ? "作業中" : featured?.title ?? "いまの活動")
                            .font(.shannon(.subheadline).weight(.medium)).lineLimit(2)
                        if model.state != .privateAudience {
                            Text(model.state == .recovering ? "最新の報告を確かめています" : model.isStale() ? "前回の報告・現在の状態を確認中" : featured?.statusTitle ?? "")
                                .font(.shannon(.caption)).foregroundStyle(palette.textSecondary).lineLimit(2)
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.shannon(.caption))
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, ShannonSpacing.medium).padding(.vertical, ShannonSpacing.extraSmall)
                .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.medium))
            }
            .buttonStyle(.plain).foregroundStyle(palette.textPrimary)
            .offset(x: dragOffset)
            .opacity(1 - min(0.6, abs(dragOffset) / 240))
            .simultaneousGesture(swipeToHide(featured))
            .contextMenu {
                if let featured { Button("この表示を隠す", systemImage: "eye.slash") { hide(featured) } }
            }
            .accessibilityIdentifier("conversation-now-entry")
            .accessibilityHint("調査の途中結果と、いま進めていることを開きます。会話は続きます。")
            .accessibilityAction(named: "この表示を隠す") { if let featured { hide(featured) } }
#if os(iOS)
            .sheet(isPresented: $showsDetails) {
                NavigationStack { ShannonNowPanel(model: model).navigationTitle("いま")
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("閉じる") { showsDetails = false } } } }
                    .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            }
#else
            .popover(isPresented: $showsDetails) { ShannonNowPanel(model: model).frame(width: 360, height: 500) }
#endif
        }
    }

    /// A horizontal swipe past a third of a short distance hides the row; the work itself goes on.
    private func swipeToHide(_ task: ShannonConversationActivityDTO.Task?) -> some Gesture {
        DragGesture(minimumDistance: 16)
            .onChanged { value in
                guard task != nil, abs(value.translation.width) > abs(value.translation.height) else { return }
                dragOffset = value.translation.width
            }
            .onEnded { value in
                guard let task, abs(value.translation.width) > 90,
                      abs(value.translation.width) > abs(value.translation.height) else {
                    withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) { dragOffset = 0 }
                    return
                }
                hide(task)
            }
    }

    private func hide(_ task: ShannonConversationActivityDTO.Task) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
            model.dismissFromStrip(task.id)
            dragOffset = 0
        }
    }
}

/// The Mac reads this beside Talk; the iPhone opens it without ending a call.
public struct ShannonNowPanel: View {
    let model: ShannonConversationActivityModel
    @State private var selectedID: String?
    @State private var steering = ""
    @Environment(\.colorScheme) private var colorScheme
    public init(model: ShannonConversationActivityModel) { self.model = model }
    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        TimelineView(.periodic(from: .now, by: 5)) { clock in
            ScrollView {
                VStack(alignment: .leading, spacing: ShannonSpacing.large) {
                    Text("いま").font(.shannon(.headline)).accessibilityAddTraits(.isHeader)
                    if model.state == .privateAudience {
                        Text("ほかの人もいる間は、作業の内容を表示しません。")
                    } else {
                        Text("会話はそのまま続けられます。")
                            .font(.shannon(.footnote)).foregroundStyle(palette.textSecondary)
                        if model.state == .recovering { Label("最新の報告を確かめています", systemImage: "wifi.slash") }
                        if model.isStale(at: clock.date), model.reading != nil {
                            Label("前回の報告です。現在の状態は確認できていません。", systemImage: "clock.badge.exclamationmark")
                                .font(.shannon(.footnote)).foregroundStyle(palette.attention)
                        }
                        if model.tasks.isEmpty { Text(model.state == .loading ? "活動を読み込んでいます…" : "いま進めている作業はありません。") }
                        ForEach(model.tasks) { task in
                            taskCard(task, stale: model.isStale(at: clock.date), palette: palette)
                        }
                        if let notice = model.notice { Text(notice).font(.shannon(.footnote)).accessibilityIdentifier("now-control-notice") }
                        Button("最新の報告を読む") { Task { await model.reload() } }.frame(minHeight: 44)
                    }
                }
                .padding(ShannonSpacing.medium).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .foregroundStyle(palette.textPrimary)
        .background(palette.canvas)
        .onChange(of: model.state) { if model.state == .privateAudience { steering = ""; selectedID = nil } }
    }
    private func taskCard(_ task: ShannonConversationActivityDTO.Task, stale: Bool, palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            if model.tasks.contains(where: { $0.id == task.parentId }) {
                Label("関連する調べもの", systemImage: "arrow.turn.down.right")
                    .font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
            }
            Text(task.title).font(.shannon(.subheadline).weight(.semibold)).accessibilityAddTraits(.isHeader)
            Label(task.phaseTitle, systemImage: task.symbol).font(.shannon(.footnote))
            Text(task.origin == "maintenance" ? "内部の記憶整理" : task.origin == "own_time" ? "自分の時間" : "あなたの依頼")
                .font(.shannon(.caption)).foregroundStyle(palette.textSecondary)
            if let currentStep = task.activeStepTitle { Text(currentStep).font(.shannon(.callout)) }
            if !task.summary.isEmpty { Text(task.summary).font(.shannon(.callout)).textSelection(.enabled) }
            if let report = task.report, !report.text.isEmpty {
                Text("途中の報告").font(.shannon(.caption).weight(.medium))
                Text(report.text).font(.shannon(.callout)).textSelection(.enabled)
            }
            if let findings = task.findings, !findings.isEmpty {
                Divider()
                ForEach(findings) { finding in
                    VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                        Label(finding.statusTitle, systemImage: finding.status == "confirmed" ? "checkmark.circle" : finding.status == "corrected" ? "arrow.uturn.backward" : "questionmark.circle")
                            .font(.shannon(.caption).weight(.medium))
                        Text(finding.text).font(.shannon(.callout)).textSelection(.enabled)
                        ForEach(Array(finding.sources.enumerated()), id: \.offset) { _, source in
                            if let url = source.webURL { Link(source.title, destination: url).font(.shannon(.footnote)).frame(minHeight: 44, alignment: .leading) }
                        }
                    }
                }
            }
            if let places = task.places, !places.isEmpty { ShannonPlaceMapCard(places: places) }
            Text("\(task.updatedTime) 更新").font(.shannon(.caption2)).foregroundStyle(palette.textSecondary)
            if task.canStop {
                HStack {
                    Button("方針を伝える") { selectedID = selectedID == task.id ? nil : task.id; steering = "" }
                    Spacer()
                    Button("この作業を停止", role: .destructive) { Task { await model.command(task: task) } }
                }.frame(minHeight: 44).disabled(stale || model.state != .ready || model.pendingID != nil)
            }
            if selectedID == task.id {
                TextField("この作業への追加の方針", text: $steering, axis: .vertical).lineLimit(2...5).textFieldStyle(.roundedBorder)
                Button("届ける") {
                    let text = steering
                    Task { await model.command(task: task, message: text) }
                    steering = ""; selectedID = nil
                }.frame(minHeight: 44).disabled(stale || model.state != .ready || model.pendingID != nil || steering.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if model.pendingID == task.id { ProgressView("届いたか確かめています…").font(.shannon(.footnote)) }
        }
        .padding(ShannonSpacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.medium))
        .accessibilityElement(children: .contain)
    }
}

public struct ShannonNowPolling: ViewModifier {
    let model: ShannonConversationActivityModel
    let connected: Bool
    let othersPresent: Bool
    @Environment(\.scenePhase) private var scenePhase
    public init(model: ShannonConversationActivityModel, connected: Bool, othersPresent: Bool) {
        self.model = model; self.connected = connected; self.othersPresent = othersPresent
    }
    public func body(content: Content) -> some View {
        content.environment(model)
            .onChange(of: othersPresent, initial: true) { model.reset(othersPresent: othersPresent, disconnected: !connected) }
            .onChange(of: connected) { model.reset(othersPresent: othersPresent, disconnected: !connected) }
            .task(id: "\(connected)|\(othersPresent)|\(scenePhase)") {
                guard connected, !othersPresent, scenePhase == .active else { return }
                while !Task.isCancelled {
                    await model.reload()
                    if model.state == .unsupported { return }
                    do { try await Task.sleep(for: .seconds(3)) } catch { return }
                }
            }
    }
}
