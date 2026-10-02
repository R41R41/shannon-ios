import SwiftUI

/// 運用: whether the services of the legacy runtime are running, and the few operations
/// the server accepts. The view shows what `ShannonOpsModel` allows and nothing else;
/// every operation goes through the confirmation sheet before it is sent.
public struct ShannonOpsView: View {
    @Bindable private var model: ShannonOpsModel
    @State private var confirming: ShannonOpsConfirmation?
    @State private var showsSkills = false

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    public init(model: ShannonOpsModel) {
        self.model = model
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        List {
            if let snapshot = model.snapshot, model.isSupported {
                report(snapshot, palette: palette)
            } else {
                emptySection
            }
        }
        .refreshable { await model.refresh() }
        // Reads while this screen is on screen and the app is in front; the task ends with either.
        .task(id: pollingKey) { await poll() }
        .sheet(item: $confirming) { confirmation in
            ShannonOpsConfirmationSheet(model: model, confirmation: confirmation) { confirming = nil }
        }
#if DEBUG
        .onChange(of: model.didLoad, initial: true) { presentPreviewConfirmation() }
#endif
    }

#if DEBUG
    /// `-ShannonPreviewYousu opsConfirm`: opens the longest confirmation over fixture data, for screenshots.
    private func presentPreviewConfirmation() {
        guard ShannonYousuFixtureClient.launchVariant == "opsConfirm", confirming == nil,
              let body = model.snapshot?.services.first(where: { $0.id == ShannonOpsText.minebotBody }),
              let server = model.minebotStartServers(for: body)?.first else { return }
        confirming = ShannonOpsConfirmation(action: .init(type: .minebotStart, target: server.id, name: ShannonOpsText.serviceName(server)))
    }
#endif

    /// Restarts the loop when the app comes to the front and when the interval changes.
    private var pollingKey: String {
        "\(scenePhase == .active)-\(model.openCommands.isEmpty)"
    }

    private func poll() async {
        guard scenePhase == .active else { return }
        while !Task.isCancelled {
            // The scene phase seen inside a sheet is not trusted alone: nothing is read while the app is not in front.
            if ShannonYousuForeground.isActive { await model.refresh() }
            do { try await Task.sleep(for: model.pollInterval) } catch { return }
        }
    }

    @ViewBuilder
    private var emptySection: some View {
        Section {
            if let message = model.unreachableMessage {
                Label(message, systemImage: "wifi.exclamationmark")
                    .font(.callout)
            } else if !model.didLoad {
                HStack(spacing: ShannonSpacing.medium) {
                    ProgressView()
                    Text("運用の報告を確認中")
                }
                .accessibilityElement(children: .combine)
            } else {
                Text("運用の報告は、まだ届いていません。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func report(_ snapshot: ShannonOpsSnapshotDTO, palette: ShannonPalette) -> some View {
        let current = model.isCurrent()
        let groups = ShannonOpsGroups(snapshot.services)

        Section {
            if let message = model.unreachableMessage {
                ShannonOpsBanner(
                    title: "サーバーに届きません", message: "\(message) 下は、最後に読めた報告です。", palette: palette
                )
            } else if !current {
                ShannonOpsBanner(
                    title: "報告が届いていません",
                    message: "最後の報告は \(receivedLabel(withAge: true)) です。サーバーか旧ランタイムが止まっているかもしれません。",
                    palette: palette
                )
            }
            ShannonOpsReportLine(
                received: "\(current ? "最新の報告" : "最後の報告") \(receivedLabel(withAge: current))",
                release: snapshot.runtime.release,
                started: snapshot.runtime.startedAt.isEmpty ? nil : ShannonYousuTime.clock(snapshot.runtime.startedAt)
            )
            notice(palette: palette)
            if !model.openCommands.isEmpty {
                Label("結果を待っている操作が \(model.openCommands.count) 件あります", systemImage: "hourglass")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }

        if !groups.services.isEmpty {
            Section(current ? "サービス" : "サービス（最後の報告のときの状態）") {
                ForEach(groups.services) { serviceRow($0, current: current, palette: palette) }
            }
        }
        if !groups.minebot.isEmpty || !snapshot.minebot.isEmpty {
            Section("Minebot") {
                ForEach(groups.minebot) { serviceRow($0, current: current, palette: palette) }
                ForEach(snapshot.minebot) { ShannonOpsMinebotTaskRow(bot: $0, current: current, palette: palette) }
            }
        }
        if !groups.minecraft.isEmpty {
            Section("Minecraft サーバー") {
                ForEach(groups.minecraft) { serviceRow($0, current: current, palette: palette) }
            }
        }
        if snapshot.services.isEmpty {
            Section("サービス") {
                Text("報告されているサービスはありません。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }

        if !snapshot.schedules.isEmpty {
            Section {
                ForEach(snapshot.schedules) { schedule in
                    ShannonOpsRow(
                        title: schedule.name,
                        detail: [ShannonOpsText.scheduleTime(schedule.time), ShannonOpsText.postedTodayLabel(schedule.postedToday)]
                            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "・"),
                        status: nil, statusLabel: nil, isCurrent: current,
                        isWaiting: model.isWaiting(target: schedule.name, schedule: true),
                        actions: model.action(for: schedule).map { [$0] } ?? [],
                        palette: palette
                    ) { confirming = ShannonOpsConfirmation(action: $0) }
                }
            } header: {
                Text("スケジュール")
            } footer: {
                if model.allowed().scheduleRun {
                    Text("「今すぐ実行」は、その予定の処理をいま動かします。実際に公開の場（X（Twitter）や YouTube など）へ投稿・返信されます（今日すでに投稿済みでも、もう一度出ます）。")
                }
            }
        }

        if let kpi = snapshot.kpi {
            Section("今日の数字") {
                LabeledContent("投稿", value: "\(kpi.postsToday) / \(kpi.postsPlanned)")
                LabeledContent("トークン", value: kpi.tokensToday.formatted(.number.locale(Locale(identifier: "ja_JP"))))
                LabeledContent("API 呼出", value: "\(kpi.apiCallsToday.formatted(.number.locale(Locale(identifier: "ja_JP")))) 回")
            }
        }

        if !snapshot.skills.isEmpty {
            Section {
                DisclosureGroup("スキル（\(snapshot.skills.count) 件）", isExpanded: $showsSkills) {
                    ForEach(snapshot.skills) { skill in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(skill.name).font(.callout.weight(.medium))
                            if !skill.description.isEmpty {
                                Text(skill.description).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }

        if model.commandsSupported {
            Section {
                if model.commands.isEmpty {
                    Text("まだ操作はありません。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.commands) { ShannonOpsCommandRow(command: $0, palette: palette) }
                }
            } header: {
                Text("操作の記録")
            } footer: {
                Text("操作は、押してから 5 分以内に実行されなければ取り消され、あとから実行されることはありません。結果が届かなかった操作も、やり直されません。もう一度行うときは、状態を見てから、あらためて押してください。")
            }
        } else {
            Section {
                Text("いまは見るだけです。開始・停止などの操作は、本体の側で止められています。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }

        if !current, model.commandsSupported {
            Section {
                Text("報告が届くまで、操作はできません")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .listRowBackground(Color.clear)
            }
        }
    }

    @ViewBuilder
    private func notice(palette: ShannonPalette) -> some View {
        switch model.notice {
        case .problem(let title, let message):
            ShannonOpsNoticeLine(symbol: "exclamationmark.circle", tint: palette.danger, title: title, message: message) {
                model.dismissNotice()
            }
        case .accepted:
            if let command = model.noticedCommand {
                ShannonOpsNoticeLine(
                    symbol: ShannonOpsCommandRow.symbol(command.status),
                    tint: ShannonOpsCommandRow.tint(command.status, palette: palette),
                    title: "\(ShannonOpsText.commandSummary(command))：\(ShannonOpsText.commandStatusLabel(command.status))",
                    message: ShannonOpsText.commandReason(command)
                        ?? (command.status.isOpen ? "旧ランタイムが受け取りに来るまで、10 秒ほどかかります。" : nil)
                ) { model.dismissNotice() }
            }
        case nil:
            EmptyView()
        }
    }

    private func serviceRow(_ service: ShannonOpsServiceDTO, current: Bool, palette: ShannonPalette) -> some View {
        let servers = model.minebotStartServers(for: service)
        return ShannonOpsRow(
            title: ShannonOpsText.serviceName(service),
            detail: [service.detail, servers?.isEmpty == true ? "起動するには、先に Minecraft サーバーを開始してください" : nil]
                .compactMap { $0 }.joined(separator: "・"),
            status: service.status,
            statusLabel: current ? ShannonOpsText.statusLabel(service.status) : ShannonOpsText.staleStatusLabel(service.status),
            isCurrent: current,
            isWaiting: model.isWaiting(target: service.id),
            actions: (servers?.first.map { [ShannonOpsAction(type: .minebotStart, target: $0.id, name: ShannonOpsText.serviceName($0))] } ?? [])
                + model.actions(for: service),
            palette: palette
        ) { confirming = ShannonOpsConfirmation(action: $0) }
    }

    private func receivedLabel(withAge: Bool) -> String {
        guard let receivedAt = model.view?.receivedAt else { return "不明" }
        let clock = ShannonYousuTime.clock(receivedAt)
        guard withAge, let ago = ShannonYousuTime.ago(receivedAt) else { return clock }
        return "\(clock)（\(ago)）"
    }
}

/// The action whose confirmation is on screen.
struct ShannonOpsConfirmation: Identifiable, Equatable {
    let action: ShannonOpsAction
    var id: String { action.id }
}

/// Services in the three places the screen shows them.
struct ShannonOpsGroups {
    let services: [ShannonOpsServiceDTO]
    let minebot: [ShannonOpsServiceDTO]
    let minecraft: [ShannonOpsServiceDTO]

    init(_ all: [ShannonOpsServiceDTO]) {
        minebot = all.filter { $0.id == "minebot" || $0.id.hasPrefix("minebot:") }
        minecraft = all.filter { $0.id == "minecraft" || $0.id.hasPrefix(ShannonOpsText.minecraftPrefix) }
        let grouped = Set((minebot + minecraft).map(\.id))
        services = all.filter { !grouped.contains($0.id) }
    }
}
