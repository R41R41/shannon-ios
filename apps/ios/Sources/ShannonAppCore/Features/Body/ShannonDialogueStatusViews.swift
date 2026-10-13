#if os(iOS)
import SwiftUI

/// Talk's dialogue display in the Live2D form has no status pills (owner pick 2026-10-13, option C): her mood is
/// her expression, the camera is a small eye on her, and work in progress is this one line over the composer.
/// The line joins what `ShannonNowCompact` (the work he asked for) and `ShannonActionThreadsCapsule` (裏の作業)
/// show elsewhere, and opens the same lists. Nothing is shown while nothing runs.
struct ShannonDialogueActivityLine: View {
    let now: ShannonConversationActivityModel
    let threads: ShannonActionThreadsModel

    @State private var showsNow = false
    @State private var showsThreads = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if now.showsStrip || threads.showsCapsule {
            let palette = ShannonPalette.resolve(colorScheme)
            HStack(spacing: ShannonSpacing.small) {
                if now.showsStrip { nowButton(palette) }
                Spacer(minLength: 0)
                if threads.showsCapsule { threadsButton(palette) }
            }
            .font(.shannon(.footnote))
            .padding(.horizontal, ShannonSpacing.medium)
            .frame(minHeight: ShannonTouchTarget.minimum)
            .modifier(ShannonFloatingComposerSurface(cornerRadius: ShannonTouchTarget.minimum / 2))
            .padding(.horizontal, ShannonSpacing.medium)
            .sheet(isPresented: $showsNow) {
                NavigationStack {
                    ShannonNowPanel(model: now).navigationTitle("いま")
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("閉じる") { showsNow = false } } }
                }
                .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showsThreads) {
                ShannonActionThreadsList(model: threads).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("dialogue-activity-line")
        }
    }

    private func nowButton(_ palette: ShannonPalette) -> some View {
        let featured = now.stripFeatured
        let title = now.state == .privateAudience ? "作業中" : featured?.title ?? "いまの活動"
        let detail: String? = now.state == .privateAudience ? nil
            : now.state == .recovering ? "最新の報告を確かめています" : featured?.statusTitle
        return Button { showsNow = true } label: {
            HStack(spacing: ShannonSpacing.extraSmall) {
                Image(systemName: featured?.symbol ?? "gearshape.2")
                    .foregroundStyle(palette.intelligenceSky)
                (Text(title).foregroundStyle(palette.textPrimary)
                    + Text(detail.map { "・\($0)" } ?? "").foregroundStyle(palette.textSecondary))
                    .lineLimit(1)
            }
            .frame(minHeight: ShannonTouchTarget.minimum)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if let featured { Button("この表示を隠す", systemImage: "eye.slash") { now.dismissFromStrip(featured.id) } }
        }
        .accessibilityLabel([title, detail].compactMap { $0 }.joined(separator: "、"))
        .accessibilityHint("調査の途中結果と、いま進めていることを開きます。会話は続きます。")
        .accessibilityAction(named: "この表示を隠す") { if let featured { now.dismissFromStrip(featured.id) } }
        .accessibilityIdentifier("conversation-now-entry")
    }

    private func threadsButton(_ palette: ShannonPalette) -> some View {
        Button { showsThreads = true } label: {
            HStack(spacing: 2) {
                Text(threads.capsuleText).lineLimit(1)
                Image(systemName: "chevron.right").font(.shannon(.caption2))
            }
            .foregroundStyle(palette.textSecondary)
            .frame(minHeight: ShannonTouchTarget.minimum)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityHint(ShannonGeneratedStrings.threadsTitle)
        .accessibilityIdentifier("action-threads-capsule")
    }
}

/// The camera's state as a small eye on her (切／見てよい／いま見ています), always there, never a button: the same
/// state as `ShannonAppLookStateBadge`, read by VoiceOver as 「カメラ：…」.
struct ShannonAppLookEyeBadge: View {
    let coordinator: ShannonAppLookCoordinator
    var othersPresent = false
    var diameter: CGFloat = 30

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        ShannonAppLookStateReader(coordinator: coordinator, othersPresent: othersPresent) { state in
            Image(systemName: state.symbol)
                .font(.system(size: diameter * 0.46, weight: state == .looking ? .bold : .medium))
                .foregroundStyle(state == .looking ? palette.action : palette.textSecondary)
                .frame(width: diameter, height: diameter)
                .background {
                    if reduceTransparency { Circle().fill(palette.elevatedSurface) } else { Circle().fill(.thinMaterial) }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(state.line)
                .accessibilityIdentifier("app-look-state")
        }
    }
}
#endif
