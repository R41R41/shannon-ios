import SwiftUI

extension View {
    /// Runs the device-action outbox for the app (`ShannonDeviceActionModel.run`) and hands the model to the views below,
    /// where the now-playing card reads it.
    public func shannonDeviceActions(_ model: ShannonDeviceActionModel) -> some View {
        modifier(ShannonDeviceActionLifecycle(model: model))
    }
}

private struct ShannonDeviceActionLifecycle: ViewModifier {
    let model: ShannonDeviceActionModel
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .environment(model)
            .task { await model.run() }
            .onChange(of: scenePhase) {
                model.isForeground = scenePhase == .active
            }
    }
}

/// A small card in the conversation while a song she chose is playing: the song, her one line of why, and skip and stop.
/// Nothing shows while nothing she chose is playing.
public struct ShannonNowPlayingCard: View {
    @Environment(ShannonDeviceActionModel.self) private var model: ShannonDeviceActionModel?
    @Environment(\.colorScheme) private var colorScheme

    public init() {}

    public var body: some View {
        if let model, let playing = model.nowPlaying {
            let palette = ShannonPalette.resolve(colorScheme)
            HStack(alignment: .center, spacing: ShannonSpacing.small) {
                Image(systemName: playing.isPaused ? "pause.circle" : "music.note")
                    .font(.shannon(.title3))
                    .foregroundStyle(palette.action)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(playing.title)
                        .font(.shannon(.callout).weight(.medium))
                        .foregroundStyle(palette.textPrimary)
                        .lineLimit(1)
                    if let artist = playing.artist, !artist.isEmpty {
                        Text(artist)
                            .font(.shannon(.caption))
                            .foregroundStyle(palette.textSecondary)
                            .lineLimit(1)
                    }
                    if !playing.reason.isEmpty {
                        Text("選んだ理由: \(playing.reason)")
                            .font(.shannon(.caption))
                            .foregroundStyle(palette.textSecondary)
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    Task { await model.togglePause() }
                } label: {
                    Image(systemName: playing.isPaused ? "play.fill" : "pause.fill")
                        .frame(minWidth: ShannonTouchTarget.minimum, minHeight: ShannonTouchTarget.minimum)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(playing.isPaused ? "再生する" : "一時停止")
                Button {
                    Task { await model.skip() }
                } label: {
                    Image(systemName: "forward.fill")
                        .frame(minWidth: ShannonTouchTarget.minimum, minHeight: ShannonTouchTarget.minimum)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("次の曲へ")
                Button {
                    Task { await model.stop() }
                } label: {
                    Image(systemName: "stop.fill")
                        .frame(minWidth: ShannonTouchTarget.minimum, minHeight: ShannonTouchTarget.minimum)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("止める")
            }
            .tint(palette.action)
            .padding(ShannonSpacing.medium)
            .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.large))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("シャノンがかけている曲")
        }
    }
}
