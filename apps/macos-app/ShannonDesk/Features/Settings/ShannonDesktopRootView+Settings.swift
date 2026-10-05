import AppKit
import ShannonAppCore
import SwiftUI

/// 設定 on the Mac (docs/product/information-architecture.md 2): parts on the left, the chosen one on
/// the right. 管理 comes first, with 運用 carrying the mark and its reason in one line (roadmap A12).
extension ShannonDesktopRootView {
    var settingsPage: DesktopSettingsPage {
        DesktopSettingsPage.restoring(settingsPageRawValue, opsSupported: yousu.ops.isSupported)
    }

    func openSettings(_ page: DesktopSettingsPage) {
        settingsPageRawValue = page.rawValue
        selectDestination(.settings)
    }

    var settingsView: some View {
        HStack(spacing: 0) {
            settingsColumn
                .frame(width: 250)
            Divider()
            settingsContent
                .id(settingsPage)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle(ShannonGeneratedStrings.navSettings)
        .sheet(isPresented: $showsStateDetails) {
            ShannonStateSheet(state: conversation.state, face: conversation.presentFace)
                .frame(minWidth: 480, minHeight: 560)
        }
        .sheet(isPresented: $showsBody) {
            NavigationStack { ShannonBodyScreen(memory: memory) }
                .frame(minWidth: 460, minHeight: 720)
        }
        .task { await worldSubscriptions.reload() }
    }

    private var settingsColumn: some View {
        List(selection: Binding(
            get: { settingsPage },
            set: { page in if let page { settingsPageRawValue = page.rawValue } }
        )) {
            Section {
                settingsProfileCard
            }
            Section(ShannonGeneratedStrings.navAdmin) {
                if yousu.ops.isSupported {
                    settingsOpsRow
                        .tag(DesktopSettingsPage.ops)
                        .accessibilityHint(ShannonGeneratedStrings.adminOpsHint)
                }
                Label(ShannonGeneratedStrings.settingsSectionDevices, systemImage: "laptopcomputer.and.iphone")
                    .tag(DesktopSettingsPage.devices)
                    .accessibilityHint(ShannonGeneratedStrings.adminDevicesHint)
                Label(ShannonGeneratedStrings.navDelivery, systemImage: "arrow.down.app")
                    .tag(DesktopSettingsPage.delivery)
                Label(ShannonGeneratedStrings.navDiagnostics, systemImage: "waveform.badge.magnifyingglass")
                    .tag(DesktopSettingsPage.diagnostics)
            }
            Section {
                Label(ShannonGeneratedStrings.settingsFigure, systemImage: "person.crop.rectangle")
                    .tag(DesktopSettingsPage.figure)
                Label(ShannonGeneratedStrings.settingsSectionCamera, systemImage: "camera")
                    .tag(DesktopSettingsPage.camera)
                Label(ShannonPrivateListeningCopy.sectionTitle, systemImage: "earbuds")
                    .tag(DesktopSettingsPage.earphones)
                Label(ShannonGeneratedStrings.settingsSectionVoice, systemImage: "speaker.wave.2")
                    .tag(DesktopSettingsPage.voice)
                Label(ShannonCalendarSharingCopy.sectionTitle, systemImage: "calendar")
                    .tag(DesktopSettingsPage.calendar)
                Label("外観", systemImage: "circle.lefthalf.filled")
                    .tag(DesktopSettingsPage.appearance)
                Label(ShannonGeneratedStrings.settingsConnection, systemImage: "link")
                    .tag(DesktopSettingsPage.connection)
                Label("情報源", systemImage: "newspaper")
                    .tag(DesktopSettingsPage.sources)
            }
        }
        .listStyle(.sidebar)
    }

    /// Her state at the top of 設定, as on the iPhone (A14): her face and how she is; it opens her state.
    private var settingsProfileCard: some View {
        Button {
            showsStateDetails = true
        } label: {
            HStack(spacing: ShannonDesktopSpacing.medium) {
                ShannonChatAvatarView(face: conversation.presentFace, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ShannonGeneratedStrings.appName)
                        .font(.shannonDesktop(.headline))
                    Text("いま：\(conversation.presentFace.japaneseName)")
                        .font(.shannonDesktop(.caption))
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.shannonDesktop(.caption))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("シャノンの状態を表示します")
        .accessibilityIdentifier("settings-shannon-profile")
    }

    /// 運用, with the mark and its reason while something there deserves a look. Before the first
    /// report it says so; a refused connection says that instead (no mark).
    private var settingsOpsRow: some View {
        let reason = yousu.ops.attentionReason()
        let detail = reason
            ?? (yousu.ops.connectionIsInvalid ? ShannonGeneratedStrings.opsConnectionInvalid : nil)
            ?? (yousu.ops.didLoad && !yousu.ops.hasReport ? ShannonGeneratedStrings.opsNotReported : nil)
        return HStack(spacing: ShannonDesktopSpacing.small) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(ShannonGeneratedStrings.opsTitle)
                    if let detail {
                        Text(detail)
                            .font(.shannonDesktop(.caption))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } icon: {
                Image(systemName: "server.rack")
            }
            Spacer(minLength: ShannonDesktopSpacing.small)
            if reason != nil {
                DesktopOpsMark()
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var settingsContent: some View {
        switch settingsPage {
        case .ops:
            NavigationStack {
                ShannonOpsView(model: yousu.ops)
                    .navigationTitle(ShannonGeneratedStrings.opsTitle)
            }
        case .devices:
            ShannonConnectionView(model: connection, part: .devices)
        case .delivery:
            ShannonTestFlightDeliveryView(
                model: release,
                showsDismissButton: false,
                requestRelease: requestAppleRelease
            )
        case .diagnostics:
            ShannonVoiceDiagnosticsView(showsCloseButton: false)
        case .connection:
            ShannonConnectionView(model: connection, part: .connection)
        case .sources:
            ShannonWorldSubscriptionView(model: worldSubscriptions)
        case .figure, .camera, .earphones, .voice, .calendar, .appearance:
            settingsForm
        }
    }
}
