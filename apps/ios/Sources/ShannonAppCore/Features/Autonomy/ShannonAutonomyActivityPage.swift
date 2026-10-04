import SwiftUI

/// 「したことの記録」: the state of the stop switch, today's budget, what waits for
/// the owner, and the append-only record grouped by day. On the iPhone it is the page
/// 「シャノン › 自律活動」 (`isHub`), which also leads to her pursuits and models;
/// the Mac reaches it from 頭の中 and Settings.
public struct ShannonAutonomyActivityPage: View {
    @Bindable private var model: ShannonAutonomyModel
    private let isHub: Bool
    @State private var approvedAmount: Double = 0
    @State private var proposalToStart: ShannonAutonomyProposalDTO?
    @Environment(\.colorScheme) private var colorScheme

    public init(model: ShannonAutonomyModel, isHub: Bool = false) {
        self.model = model
        self.isHub = isHub
    }

    public var body: some View {
        List {
            if let message = model.errorMessage {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(Color.shannonDanger)
                }
            }
            if let overview = model.overview {
                stateSection(overview)
                budgetSection(overview)
                proposalSection
            }
            if isHub { pursuitsSection }
            ForEach(model.days) { day in
                Section {
                    Text(day.summary)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("この日のまとめ、\(day.summary)")
                    ForEach(day.entries) { entry in
                        ShannonAutonomyActivityRow(entry: entry, study: model.study)
                    }
                } header: {
                    Text(ShannonAutonomyFormat.dayTitle(day.dayKey))
                }
            }
            if model.days.isEmpty, model.overview != nil {
                Section("記録") {
                    Text("まだ記録はありません。シャノンが自分から動くと、いつ・何を・どこで・いくらでしたかがここに残ります。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(isHub ? ShannonGeneratedStrings.navAutonomy : "したことの記録")
        .overlay {
            if model.overview == nil, model.isLoading {
                ProgressView("記録を確認中")
            }
        }
        .refreshable { await model.reload() }
        .task { await model.reload() }
        .confirmationDialog(
            "この提案を開始しますか？",
            isPresented: Binding(get: { proposalToStart != nil }, set: { if !$0 { proposalToStart = nil } }),
            titleVisibility: .visible,
            presenting: proposalToStart
        ) { proposal in
            Button("開始する") {
                Task { await model.decideProposal(proposal, start: true) }
            }
            Button("キャンセル", role: .cancel) {}
        } message: { proposal in
            Text("「\(proposal.title)」を作業として開始します。進み具合は作業の一覧で確認できます。")
        }
    }

    // MARK: Pursuits

    /// Her own aims and questions, and the models she uses: one row to the page that has both.
    private var pursuitsSection: some View {
        Section {
            NavigationLink {
                ShannonAutonomyPursuitsPage(model: model)
            } label: {
                VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                    ForEach(model.featuredPursuits) { pursuit in
                        ShannonPursuitLine(pursuit: pursuit, palette: ShannonPalette.resolve(colorScheme))
                    }
                    if model.featuredPursuits.isEmpty {
                        Text(model.overview == nil ? (model.errorMessage ?? "読み込み中…") : "いま続けているものはありません")
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
            }
            .accessibilityHint("シャノン自身の目標・問い・作品と、使うモデルを開きます")
            .accessibilityIdentifier("autonomy-pursuits-entry")
        } header: {
            Text("シャノンのやりたいこと")
        } footer: {
            Text("あなたの目的とは別に、シャノン自身が持っている目標と問いです。使うモデルもここから見られます。")
        }
    }

    // MARK: State

    private func stateSection(_ overview: ShannonAutonomyOverviewDTO) -> some View {
        Section {
            ShannonAutonomyPauseToggle(model: model)
        } header: {
            Text("状態")
        } footer: {
            Text(overview.stateDetail)
        }
    }

    // MARK: Budget

    private func budgetSection(_ overview: ShannonAutonomyOverviewDTO) -> some View {
        Section {
            VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                LabeledContent("使った額", value: overview.budget.usedLabel)
                ProgressView(value: overview.budget.fraction)
                    .tint(overview.budget.exhausted ? Color.shannonAttention : Color.shannonActionColor)
                    .accessibilityHidden(true)
                if overview.budget.extraYen > 0 {
                    Text("今日だけ\(ShannonAutonomyFormat.yen(overview.budget.extraYen))増やしています。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if overview.budget.exhausted {
                    Label("今日の上限に達しました。お金のかかることは明日まで止まります。", systemImage: "exclamationmark.circle")
                        .font(.footnote)
                        .foregroundStyle(Color.shannonAttention)
                }
            }
            .frame(minHeight: ShannonTouchTarget.minimum)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("今日の予算、\(overview.budget.usedLabel)\(overview.budget.exhausted ? "、上限に達しました" : "")")

            if let request = overview.budgetRequest {
                budgetRequestRow(request, maximum: overview.maximumExtraYen)
            }
        } header: {
            Text("今日の予算")
        } footer: {
            Text("モデルとAPIの利用料だけが対象です。1ドル\(Int(overview.budget.yenPerUsd))円で換算しています。")
        }
    }

    @ViewBuilder
    private func budgetRequestRow(_ request: ShannonAutonomyBudgetRequestDTO, maximum: Double) -> some View {
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            Label("シャノンからのお願い", systemImage: "hand.raised")
                .font(.subheadline.weight(.semibold))
            Text(request.reason)
                .fixedSize(horizontal: false, vertical: true)
            Text("希望：あと\(ShannonAutonomyFormat.yen(request.requestedYen)) ・ \(request.statusLabel)")
                .font(.footnote)
                .foregroundStyle(.secondary)
            if request.isPending {
                let upper = max(100, min(maximum, max(request.requestedYen, 100)))
                Stepper(
                    "増やす額：\(ShannonAutonomyFormat.yen(amount(for: request, upper: upper)))",
                    value: Binding(get: { amount(for: request, upper: upper) }, set: { approvedAmount = $0 }),
                    in: 100...upper,
                    step: 100
                )
                .frame(minHeight: ShannonTouchTarget.minimum)
                .accessibilityHint("今日だけ増やす額を、100円ずつ変えます")
                HStack {
                    Button("見送る", role: .destructive) {
                        Task { await model.decideBudgetRequest(request, approve: false) }
                    }
                    Spacer()
                    Button("今日だけ増やす") {
                        Task { await model.decideBudgetRequest(request, approve: true, amountYen: amount(for: request, upper: upper)) }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .disabled(model.decidingID != nil)
                .frame(minHeight: ShannonTouchTarget.minimum)
                if model.decidingID == request.id {
                    ProgressView("保存中").controlSize(.small)
                }
            }
        }
        .padding(.vertical, ShannonSpacing.extraSmall)
        .accessibilityIdentifier("autonomy-budget-request")
    }

    /// The chosen amount, or her requested amount rounded up to 100 yen, never above the limit.
    private func amount(for request: ShannonAutonomyBudgetRequestDTO, upper: Double) -> Double {
        let base = approvedAmount > 0 ? approvedAmount : (request.requestedYen / 100).rounded(.up) * 100
        return min(upper, max(100, base))
    }

    // MARK: Proposals

    @ViewBuilder
    private var proposalSection: some View {
        let proposals = model.overview?.proposals ?? []
        if !proposals.isEmpty {
            Section {
                ForEach(proposals) { proposal in
                    VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                        Text(proposal.title).font(.headline)
                        Text(proposal.reason)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityLabel("シャノンの理由、\(proposal.reason)")
                        Text(proposal.goal)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text([proposal.coreAreaSummary, proposal.statusLabel].compactMap { $0 }.joined(separator: " ・ "))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        if proposal.isWaiting {
                            HStack {
                                Button("見送る", role: .destructive) {
                                    Task { await model.decideProposal(proposal, start: false) }
                                }
                                Spacer()
                                Button("開始する…") { proposalToStart = proposal }
                                    .buttonStyle(.borderedProminent)
                            }
                            .disabled(model.decidingID != nil)
                            .frame(minHeight: ShannonTouchTarget.minimum)
                            if model.decidingID == proposal.id {
                                ProgressView("保存中").controlSize(.small)
                            }
                        }
                    }
                    .padding(.vertical, ShannonSpacing.extraSmall)
                }
            } header: {
                Text("シャノンからの提案")
            } footer: {
                Text("シャノンが自分の活動から出した提案です。あなたが開始するまで、何も始まりません。")
            }
        }
    }
}

struct ShannonAutonomyActivityRow: View {
    let entry: ShannonAutonomyActivityEntryDTO
    var study: ShannonStudyModel?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
            Image(systemName: entry.symbolName)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.summary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = entry.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(([ShannonAutonomyFormat.time(entry.occurredAt)].filter { !$0.isEmpty } + [entry.metadataLine]).joined(separator: " ・ "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // The link stays its own element so VoiceOver can open it.
                .accessibilityElement(children: .combine)
                if let pieceID = entry.studyPieceID, let study, study.isSupported {
                    NavigationLink {
                        ShannonStudyPiecePage(study: study, pieceID: pieceID)
                    } label: {
                        Text("書斎で開く")
                            .font(.footnote)
                            .foregroundStyle(Color.shannonActionColor)
                            .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                    }
                    .accessibilityHint("この時に書いたものを書斎で開きます")
                } else if let link = entry.link, let url = URL(string: link), url.scheme == "https" {
                    Link(entry.tool == "study.read" ? "読んだページを開く" : "作ったものを開く", destination: url)
                        .font(.footnote)
                        .frame(minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                }
            }
        }
        .padding(.vertical, ShannonSpacing.extraSmall)
    }

    private var tint: Color {
        switch entry.outcome {
        case "refused", "failed": Color.shannonAttention
        case "needs_approval", "requested": Color.shannonActionColor
        default: Color.secondary
        }
    }
}
