import SwiftUI

/// Opens a piece of Shannon's study from anywhere below the app root: a message in
/// which she tells the owner about it, or an entry of the activity record.
public struct ShannonOpenStudyPieceAction {
    private let handler: @MainActor (String) -> Void

    public init(_ handler: @escaping @MainActor (String) -> Void) {
        self.handler = handler
    }

    @MainActor
    public func callAsFunction(_ pieceID: String) {
        handler(pieceID)
    }
}

private struct ShannonOpenStudyPieceKey: EnvironmentKey {
    static var defaultValue: ShannonOpenStudyPieceAction? { nil }
}

public extension EnvironmentValues {
    /// Nil where no reader can be presented; the link card then does not appear.
    var shannonOpenStudyPiece: ShannonOpenStudyPieceAction? {
        get { self[ShannonOpenStudyPieceKey.self] }
        set { self[ShannonOpenStudyPieceKey.self] = newValue }
    }
}

/// The card under a message in which she says a piece is ready. It is the link that opens the draft.
public struct ShannonStudyPieceLinkCard: View {
    private let link: ShannonStudyPieceLinkDTO
    @Environment(\.shannonOpenStudyPiece) private var openStudyPiece

    public init(link: ShannonStudyPieceLinkDTO) {
        self.link = link
    }

    public var body: some View {
        if let openStudyPiece {
            Button {
                openStudyPiece(link.id)
            } label: {
                HStack(alignment: .center, spacing: ShannonSpacing.small) {
                    Image(systemName: "book.closed")
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(link.title.isEmpty ? "シャノンの物語" : link.title)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("書斎で読む")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
                .padding(.horizontal, ShannonSpacing.medium)
                .padding(.vertical, ShannonSpacing.small)
                .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(link.title.isEmpty ? "シャノンの物語" : link.title)、書斎で読む")
            .accessibilityHint("シャノンが書いた作品を開きます")
            .accessibilityIdentifier("study-piece-link")
        }
    }
}

/// Put on the app root: provides the open action and presents the reader as a sheet.
public struct ShannonStudyPieceOpening: ViewModifier {
    @Bindable private var study: ShannonStudyModel
    @State private var opened: OpenedPiece?

    private struct OpenedPiece: Identifiable {
        let id: String
    }

    public init(study: ShannonStudyModel) {
        self.study = study
    }

    public func body(content: Content) -> some View {
        content
            .environment(\.shannonOpenStudyPiece, study.isSupported ? ShannonOpenStudyPieceAction { opened = OpenedPiece(id: $0) } : nil)
            .sheet(item: $opened) { piece in
                NavigationStack {
                    ShannonStudyPiecePage(study: study, pieceID: piece.id)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("完了") { opened = nil }
                            }
                        }
                }
#if os(macOS)
                .frame(minWidth: 520, minHeight: 600)
#endif
            }
    }
}

public extension View {
    /// Lets message cards and record entries below this view open Shannon's study.
    func shannonOpensStudyPieces(with study: ShannonStudyModel) -> some View {
        modifier(ShannonStudyPieceOpening(study: study))
    }
}
