import SwiftUI

/// The confirmation before any operation is sent: what it is, the full text, and for the
/// Minebot body the server it joins. Decided with the same hold as a work approval; a tap,
/// the keyboard and VoiceOver get a dialog with the same text instead, so holding is never
/// required. Nothing is sent by opening or closing this sheet.
struct ShannonOpsConfirmationSheet: View {
    @Bindable var model: ShannonOpsModel
    let confirmation: ShannonOpsConfirmation
    let close: () -> Void

    @State private var chosenServerID: String?
    @Environment(\.colorScheme) private var colorScheme

    /// Running Minecraft servers, when this is the start of the Minebot body.
    private var servers: [ShannonOpsServiceDTO] {
        guard confirmation.action.type == .minebotStart, let snapshot = model.snapshot else { return [] }
        return ShannonOpsText.minebotServers(snapshot.services)
    }

    /// The action as it would be sent now: for the Minebot body, with the chosen server.
    private var action: ShannonOpsAction {
        let original = confirmation.action
        guard original.type == .minebotStart,
              // A chosen server that stopped running meanwhile falls back to the one the sheet was opened for.
              let server = servers.first(where: { $0.id == chosenServerID }) ?? servers.first(where: { $0.id == original.target })
        else { return original }
        return ShannonOpsAction(type: .minebotStart, target: server.id, name: ShannonOpsText.serviceName(server))
    }

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        let action = action
        let canSend = model.canSend(action)

        ScrollView {
            VStack(alignment: .leading, spacing: ShannonSpacing.large) {
                Text(ShannonOpsText.confirmationTitle(action))
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(palette.textPrimary)
                    .accessibilityAddTraits(.isHeader)

                if action.type == .minebotStart, !servers.isEmpty {
                    serverPicker(palette: palette)
                }

                VStack(alignment: .leading, spacing: ShannonSpacing.medium) {
                    ForEach(Array(paragraphs(action).enumerated()), id: \.offset) { _, paragraph in
                        Text(paragraph)
                            .font(.body)
                            .foregroundStyle(palette.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if !canSend {
                    Label(
                        model.isCurrent() ? "いまは、この操作を受け付けていません。" : "報告が届いていません。報告が届くまで、操作はできません。",
                        systemImage: "exclamationmark.triangle"
                    )
                    .font(.callout)
                    .foregroundStyle(palette.onAttentionTint)
                    .padding(ShannonSpacing.medium)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.attentionTint, in: RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous))
                }
            }
            .padding(.horizontal, ShannonSpacing.extraLarge)
            .padding(.top, ShannonSpacing.extraLarge)
            .padding(.bottom, ShannonSpacing.large)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: ShannonSpacing.small) {
                ShannonHoldToConfirmButton(
                    title: ShannonOpsText.holdTitle(action.type),
                    prominence: .prominent,
                    confirmationTitle: ShannonOpsText.confirmationTitle(action),
                    confirmationMessage: ShannonOpsText.confirmationText(action),
                    confirmActionTitle: ShannonOpsText.commandLabel(action.type)
                ) {
                    close()
                    Task { await model.send(action) }
                }
                .disabled(!canSend)

                Button(action: close) {
                    Text("やめる")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.plain)
                .foregroundStyle(palette.textPrimary)
                .background(palette.subtleSurface, in: Capsule())
                .contentShape(Capsule())
            }
            .padding(.horizontal, ShannonSpacing.extraLarge)
            .padding(.vertical, ShannonSpacing.medium)
            .background(.bar)
        }
        .background(palette.canvas)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onAppear { chosenServerID = chosenServerID ?? confirmation.action.target }
    }

    /// The text as it is, one paragraph per line of it.
    private func paragraphs(_ action: ShannonOpsAction) -> [String] {
        ShannonOpsText.confirmationText(action).split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }

    private func serverPicker(palette: ShannonPalette) -> some View {
        HStack(spacing: ShannonSpacing.small) {
            Text("入るサーバー")
                .font(.callout)
                .foregroundStyle(palette.textSecondary)
            Spacer(minLength: ShannonSpacing.small)
            Picker("入るサーバー", selection: Binding(
                get: { action.target },
                set: { chosenServerID = $0 }
            )) {
                ForEach(servers) { server in
                    Text(String(server.id.dropFirst(ShannonOpsText.minecraftPrefix.count))).tag(server.id)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .frame(minHeight: 44)
            .accessibilityLabel("Minebot の体を入らせる Minecraft サーバー")
        }
        .padding(.horizontal, ShannonSpacing.medium)
        .frame(minHeight: 48)
        .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.medium, style: .continuous))
    }
}
