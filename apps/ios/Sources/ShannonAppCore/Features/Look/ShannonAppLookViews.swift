import SwiftUI

/// 「いま見ました」 with the frame she was shown, so a look is never a secret photo.
/// Shown for a few seconds at the top of the frontmost surface, then the thumbnail is dropped.
struct ShannonAppLookCueView: View {
    let cue: ShannonAppLookCoordinator.Cue

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        HStack(spacing: ShannonSpacing.medium) {
            Image(decorative: cue.thumbnail, scale: 1)
                .resizable()
                .scaledToFill()
                .frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: ShannonShape.small, style: .continuous))
            Label(ShannonAppLookCopy.cueTitle, systemImage: "eye")
                .font(.shannon(.callout).weight(.semibold))
                .foregroundStyle(palette.textPrimary)
        }
        .padding(.leading, ShannonSpacing.small)
        .padding(.trailing, ShannonSpacing.large)
        .padding(.vertical, ShannonSpacing.small)
        .background {
            let shape = RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
            if reduceTransparency { shape.fill(palette.elevatedSurface) } else { shape.fill(.regularMaterial) }
        }
        .overlay {
            RoundedRectangle(cornerRadius: ShannonShape.large, style: .continuous)
                .stroke(palette.divider.opacity(0.7), lineWidth: 0.7)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ShannonAppLookCopy.cueAccessibility)
        .accessibilityIdentifier("app-look-cue")
    }
}

/// Makes a surface able to show the sign of a look and, on iPhone, the explanation before the
/// system's camera prompt. Several surfaces may carry it; only the frontmost one shows anything.
struct ShannonAppLookPresenter: ViewModifier {
    let coordinator: ShannonAppLookCoordinator

    @State private var id = UUID()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        let frontmost = coordinator.isFrontmost(presenter: id)
        content
            .overlay(alignment: .top) {
                if frontmost, let cue = coordinator.cue {
                    ShannonAppLookCueView(cue: cue)
                        .padding(.top, ShannonSpacing.small)
                        .padding(.horizontal, ShannonSpacing.large)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .onTapGesture { coordinator.dismissCue(cue.id) }
                        .onAppear { AccessibilityNotification.Announcement(ShannonAppLookCopy.cueAccessibility).post() }
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: coordinator.cue?.id)
            .onAppear { coordinator.register(presenter: id) }
            // The thumbnail is not kept past the screen it was shown on (nor into the app switcher's snapshot).
            .onChange(of: scenePhase) { if scenePhase != .active { coordinator.dismissCue() } }
            .onDisappear { coordinator.unregister(presenter: id) }
#if os(iOS)
            .sheet(isPresented: Binding(
                get: { frontmost && coordinator.primerPhase != nil },
                set: { shown in if !shown { coordinator.closePrimer() } }
            )) {
                ShannonPermissionPrimerSheet(
                    content: .appLook,
                    phase: coordinator.primerPhase ?? .explain,
                    allow: coordinator.allowFromPrimer,
                    notNow: coordinator.closePrimer
                )
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
            }
#endif
    }
}

public extension View {
    /// Shows 「いま見ました」 and the camera explanation for the looks of this conversation.
    func shannonAppLook(_ model: ShannonConversationModel) -> some View {
        modifier(ShannonAppLookPresenter(coordinator: model.appLook))
    }
}

extension ShannonPermissionPrimerContent {
    /// Shown before the system's camera prompt when the first look is about to be taken.
    /// Every statement is what the app does: one frame per look, a visible sign, nothing kept.
    static let appLook = ShannonPermissionPrimerContent(
        symbol: "eye.fill",
        title: "シャノンが見るために、カメラを使います",
        message: "このあと表示される確認で「許可」を選ぶと、シャノンがいま1枚だけ見ます。",
        benefits: [
            .init(symbol: "bubble.left.and.bubble.right", text: "見るのは、アプリを開いて話している時に、見てと言われた時か、話の流れで気になった時だけです。"),
            .init(symbol: "photo", text: "見た時は「いま見ました」と小さな画像を表示します。知らないうちに撮ることはありません。"),
            .init(symbol: "lock.shield", text: "写した1枚は見るために一度送るだけで、端末にもシャノンのサーバーにも保存しません。"),
            .init(symbol: "switch.2", text: "設定の「会話中にシャノンがカメラで見る」で、いつでも止められます。"),
        ],
        allowTitle: "続ける",
        deniedTitle: "カメラがオフになっています",
        deniedMessage: "設定アプリの「シャノン」でカメラをオンにすると、シャノンがカメラで見られるようになります。"
    )
}
