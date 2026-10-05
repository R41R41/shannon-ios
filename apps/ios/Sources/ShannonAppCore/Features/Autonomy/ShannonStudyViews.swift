import SwiftUI

/// The way into Shannon's study from 「シャノンのやりたいこと」 (a list row on iPhone, a card row on Mac).
struct ShannonStudyEntryLabel: View {
    @Bindable var study: ShannonStudyModel
    let tint: Color

    var body: some View {
        HStack(spacing: ShannonSpacing.medium) {
            Image(systemName: "books.vertical").foregroundStyle(tint).accessibilityHidden(true)
            Text("書斎")
            Spacer(minLength: 0)
            Text(study.summary).font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("シャノンが自分の時間に書いたメモと物語を開きます")
        .task { await study.loadIfNeeded() }
    }
}

/// 書斎: her notes and stories. The owner reads; her text cannot be edited here.
public struct ShannonStudyPage: View {
    @Bindable private var study: ShannonStudyModel

    public init(study: ShannonStudyModel) {
        self.study = study
    }

    public var body: some View {
        List {
            if let message = study.errorMessage {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(Color.shannonDanger)
                }
            }
            section("物語", pieces: study.stories, footer: "シャノンが「見せてもいい」と決めるまで、題名と本文は表示されません。")
            section("メモ", pieces: study.notes, footer: "読んだものについて、シャノンが自分の言葉で書いたメモです。")
            section("しまったもの", pieces: study.putAway, footer: nil)
        }
        .navigationTitle("書斎")
        .overlay {
            if study.pieces.isEmpty, !study.isLoading, study.errorMessage == nil {
                ContentUnavailableView(
                    "まだ何もありません",
                    systemImage: "books.vertical",
                    description: Text("シャノンが自分の時間に書いたメモと物語が、ここに並びます。")
                )
            } else if study.pieces.isEmpty, study.isLoading {
                ProgressView("書斎を確認中")
            }
        }
        .refreshable { await study.reload() }
        .task { await study.reload() }
    }

    @ViewBuilder
    private func section(_ title: String, pieces: [ShannonStudyPieceCardDTO], footer: String?) -> some View {
        if !pieces.isEmpty {
            Section {
                ForEach(pieces) { piece in
                    NavigationLink {
                        ShannonStudyPiecePage(study: study, pieceID: piece.id)
                    } label: {
                        ShannonStudyPieceRow(piece: piece)
                    }
                    .accessibilityIdentifier("study-piece-\(piece.kind)")
                }
            } header: {
                Text(title)
            } footer: {
                if let footer { Text(footer) }
            }
        }
    }
}

struct ShannonStudyPieceRow: View {
    let piece: ShannonStudyPieceCardDTO

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
            Image(systemName: piece.symbolName)
                .foregroundStyle(piece.hidden ? Color.secondary : Color.shannonActionColor)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(piece.displayTitle)
                    .font(.body.weight(.medium))
                    .foregroundStyle(piece.hidden ? .secondary : .primary)
                    .fixedSize(horizontal: false, vertical: true)
                if let excerpt = piece.excerpt, !piece.hidden {
                    Text(excerpt)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Text(piece.hidden ? "\(piece.kindLabel) ・ まだ見せてもらっていません" : piece.statusLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// The reader. The owner reads the version she showed, leaves a reaction, or asks her to put the piece away.
public struct ShannonStudyPiecePage: View {
    @Bindable private var study: ShannonStudyModel
    private let pieceID: String
    @State private var selectedReaction: String?
    @State private var comment = ""
    @State private var sentReaction = false
    @State private var asksPutAway = false

    public init(study: ShannonStudyModel, pieceID: String) {
        self.study = study
        self.pieceID = pieceID
    }

    public var body: some View {
        List {
            if let message = study.errorMessage {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(Color.shannonDanger)
                }
            }
            if let piece = study.details[pieceID] {
                textSection(piece)
                if !piece.sources.isEmpty { sourceSection(piece) }
                if !piece.versions.isEmpty, piece.isStory { versionSection(piece) }
                if piece.canReact || !piece.feedback.isEmpty { reactionSection(piece) }
                if piece.canPutAway { putAwaySection(piece) }
            }
        }
        .navigationTitle(study.details[pieceID]?.card.displayTitle ?? "書斎")
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
        .overlay {
            if study.details[pieceID] == nil, study.loadingPieceID == pieceID {
                ProgressView("作品を確認中")
            }
        }
        .refreshable { await study.loadPiece(pieceID) }
        .task { await study.loadPiece(pieceID) }
        .confirmationDialog("しまってもらいますか？", isPresented: $asksPutAway, titleVisibility: .visible) {
            Button("しまってもらう", role: .destructive) {
                Task { await study.putAway(pieceID) }
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("シャノンはこの作品の続きを書かなくなります。文章と記録は残ります。")
        }
    }

    // MARK: Text

    @ViewBuilder
    private func textSection(_ piece: ShannonStudyPieceDetailDTO) -> some View {
        Section {
            VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                Text(piece.card.displayTitle)
                    .font(.title2.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(piece.card.hidden ? "\(piece.kindLabel) ・ \(piece.statusLabel)" : piece.card.statusLine)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, ShannonSpacing.extraSmall)
            .accessibilityElement(children: .combine)
            if let body = piece.body, !piece.hidden {
                Text(body)
                    .font(.body)
                    .lineSpacing(6)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, ShannonSpacing.small)
                    .accessibilityIdentifier("study-piece-body")
            } else {
                Label {
                    Text(piece.isPutAway
                        ? "シャノンが見せる前に、しまわれました。"
                        : "シャノンはまだ、これを「見せてもいい」と言っていません。見せたくなったら、ここで読めるようになります。")
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "lock.doc")
                }
                .foregroundStyle(.secondary)
                .frame(minHeight: ShannonTouchTarget.minimum)
            }
        } footer: {
            if piece.revising {
                Text("シャノンはいま、この先の稿を直しています。ここに出ているのは、見せてくれた稿です。")
            } else if !piece.hidden {
                Text("シャノンが書いた文章です。ここからは書き換えられません。")
            }
        }
    }

    private func sourceSection(_ piece: ShannonStudyPieceDetailDTO) -> some View {
        Section("読んだもの") {
            ForEach(piece.sources, id: \.url) { source in
                if let url = URL(string: source.url), url.scheme == "https" {
                    Link(destination: url) {
                        Label(source.title, systemImage: "link")
                            .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                    }
                    .accessibilityHint("読んだページをブラウザで開きます")
                } else {
                    Label(source.title, systemImage: "doc.text")
                        .foregroundStyle(.secondary)
                        .frame(minHeight: ShannonTouchTarget.minimum)
                }
            }
        }
    }

    private func versionSection(_ piece: ShannonStudyPieceDetailDTO) -> some View {
        Section {
            ForEach(piece.versions.reversed()) { version in
                VStack(alignment: .leading, spacing: 2) {
                    Text(ShannonGeneratedStrings.studyVersion(version: String(version.version)))
                        .font(.subheadline.weight(.semibold))
                    Text(version.changeNote)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, ShannonSpacing.extraSmall)
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("直したこと")
        } footer: {
            Text("何を変えたか、なぜ変えたかを、シャノンが稿ごとに書いています。")
        }
    }

    // MARK: Reaction

    @ViewBuilder
    private func reactionSection(_ piece: ShannonStudyPieceDetailDTO) -> some View {
        Section {
            if piece.canReact {
                HStack(spacing: ShannonSpacing.small) {
                    ForEach(study.reactions) { choice in
                        let isSelected = selectedReaction == choice.id
                        Button {
                            selectedReaction = isSelected ? nil : choice.id
                            sentReaction = false
                        } label: {
                            Label(choice.label, systemImage: isSelected ? "\(choice.symbolName).fill" : choice.symbolName)
                                .font(.callout)
                                .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum)
                        }
                        .buttonStyle(.bordered)
                        .tint(isSelected ? Color.shannonActionColor : Color.secondary)
                        .accessibilityAddTraits(isSelected ? .isSelected : [])
                        .accessibilityIdentifier("study-reaction-\(choice.id)")
                    }
                }
                TextField(ShannonGeneratedStrings.studyReactionPlaceholder, text: $comment, axis: .vertical)
                    .lineLimit(2...6)
                    .frame(minHeight: ShannonTouchTarget.minimum)
                    .accessibilityLabel("感想のひとこと")
                    .accessibilityHint("\(ShannonStudyLimits.comment)文字まで。書かなくても送れます")
                if comment.count > ShannonStudyLimits.comment {
                    Text("\(ShannonStudyLimits.comment)文字までです（いま\(comment.count)文字）。")
                        .font(.footnote)
                        .foregroundStyle(Color.shannonAttention)
                }
                HStack {
                    if sentReaction {
                        Label("感想を送りました", systemImage: "checkmark.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if study.savingPieceID == pieceID {
                        ProgressView().controlSize(.small).accessibilityLabel("保存中")
                    }
                    Button("感想を送る") {
                        guard let reaction = selectedReaction else { return }
                        Task {
                            if await study.react(to: pieceID, reaction: reaction, comment: comment) {
                                selectedReaction = nil
                                comment = ""
                                sentReaction = true
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(selectedReaction == nil || comment.count > ShannonStudyLimits.comment || study.savingPieceID != nil)
                    .accessibilityIdentifier("study-reaction-send")
                }
                .frame(minHeight: ShannonTouchTarget.minimum)
            }
            ForEach(piece.feedback.reversed()) { feedback in
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(feedback.reactionLabel)（\(ShannonGeneratedStrings.studyVersion(version: String(feedback.version)))に）")
                        .font(.subheadline.weight(.semibold))
                    if !feedback.comment.isEmpty {
                        Text(feedback.comment)
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(feedback.statusLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, ShannonSpacing.extraSmall)
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("あなたの感想")
        } footer: {
            Text("感想は、シャノンが次にこの作品を直す時に渡されます。どう直すかはシャノンが決めます。")
        }
    }

    private func putAwaySection(_ piece: ShannonStudyPieceDetailDTO) -> some View {
        Section {
            Button("しまってもらう…", role: .destructive) { asksPutAway = true }
                .frame(minHeight: ShannonTouchTarget.minimum)
                .disabled(study.savingPieceID != nil)
                .accessibilityHint("シャノンに、この作品をしまうよう伝えます。確認があります")
                .accessibilityIdentifier("study-put-away")
        } footer: {
            Text("しまっても、文章と記録は消えません。")
        }
    }
}

private extension ShannonStudyPieceDetailDTO {
    var isStory: Bool { kind == "story" }
    var isPutAway: Bool { status == "put_away" }
}
