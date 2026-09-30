#if os(iOS)
import SwiftUI

struct ShannonVoiceSessionBar: View {
    @Bindable var model: ShannonGeminiLiveSessionModel
    let task: ShannonAgentTask?
    let showDetails: () -> Void
    let end: () -> Void
    let openTask: (UUID) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    private var detailSubtitle: String {
        if model.phase == .failed { return "詳細を開いて再接続" }
        if model.participantMode == .guest { return "友人も一緒 · 保存しない通話" }
        return "本人だけ · 詳細を開く"
    }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        VStack(spacing: 0) {
            let controls = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: ShannonSpacing.extraSmall))
                : AnyLayout(HStackLayout(spacing: ShannonSpacing.small))
            controls {
                Button(action: showDetails) {
                    HStack(spacing: ShannonSpacing.small) {
                        Image(systemName: model.phase == .failed ? "wifi.exclamationmark" : "waveform")
                            .foregroundStyle(palette.action)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(model.phase.workspaceTitle).font(.subheadline.weight(.semibold))
                            Text(detailSubtitle)
                                .font(.caption).foregroundStyle(palette.textSecondary)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.up").font(.caption.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity, minHeight: ShannonTouchTarget.minimum, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("音声会話の詳細、\(model.phase.workspaceTitle)、\(model.participantMode.japaneseName)")
                Button(role: .destructive, action: end) {
                    Label("終了", systemImage: "phone.down.fill")
                        .font(.subheadline.weight(.medium))
                        .frame(minHeight: ShannonTouchTarget.minimum)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("音声会話を終了する")
            }
            if let task {
                Divider().padding(.vertical, ShannonSpacing.extraSmall)
                Button { openTask(task.id) } label: {
                    HStack(spacing: ShannonSpacing.small) {
                        Image(systemName: task.status.symbolName).foregroundStyle(palette.action)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(task.title).font(.subheadline.weight(.medium))
                                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                            Text(task.status == .proposed ? "実装案 · 内容を確認して開始" : "\(task.status.japaneseName) · 作業を見る")
                                .font(.caption).foregroundStyle(palette.textSecondary)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.caption)
                    }
                    .frame(minHeight: ShannonTouchTarget.minimum)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(task.title)、\(task.status.japaneseName)、作業を開く")
            }
        }
        .padding(.horizontal, ShannonSpacing.medium)
        .padding(.vertical, ShannonSpacing.extraSmall)
        .foregroundStyle(palette.textPrimary)
        .background {
            if reduceTransparency || contrast == .increased { palette.elevatedSurface }
            else { Rectangle().fill(.regularMaterial) }
        }
        .overlay(alignment: .bottom) { Rectangle().fill(palette.divider).frame(height: 1) }
    }
}
#endif
