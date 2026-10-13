import SwiftUI

/// 「ようす › 点検」 (Syzygy ADR-0009 stage 2, E7; owner's answer 6: the daily counts and the capability list): today's counts
/// beside the last seven days', then what she can do, with its policy, its value (mean ± spread, how many) and how often it was
/// used. Nothing here can be changed. Shared by the iPhone and the Mac (ADR-0004).
struct ShannonInspectionView: View {
    @Bindable var model: ShannonExecutiveModel

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        List {
            countsSection(palette: palette)
            capabilitiesSection(palette: palette)
        }
        .overlay {
            if model.inspection == nil, model.capabilities == nil, model.isLoadingInspection {
                ProgressView(ShannonGeneratedStrings.yousuLoading)
            }
        }
        .refreshable { await model.reloadInspection() }
        // Read when the tab appears and when the app comes back to the front; never in the background.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await model.reloadInspection()
        }
    }

    // MARK: 回転数

    @ViewBuilder
    private func countsSection(palette: ShannonPalette) -> some View {
        Section {
            if let inspection = model.inspection {
                countRow(
                    label: "", today: ShannonGeneratedStrings.executiveInspectionToday, week: ShannonGeneratedStrings.executiveInspectionWeek,
                    palette: palette, isHeader: true
                )
                .accessibilityHidden(true)
                ForEach(ShannonExecutiveText.countRows) { row in
                    countRow(label: row.label, today: row.value(inspection.today), week: row.value(inspection.week), palette: palette, isHeader: false)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(ShannonGeneratedStrings.executiveInspectionRowAccessibility(
                            label: row.label, today: row.value(inspection.today), week: row.value(inspection.week)
                        ))
                        .accessibilityAddTraits(.isStaticText)
                }
                if model.inspectionPhase == .unreadable {
                    Text(ShannonGeneratedStrings.executiveUnreadable)
                        .font(.shannon(.caption))
                        .foregroundStyle(palette.textSecondary)
                }
            } else {
                phaseLine(model.inspectionPhase, palette: palette)
            }
        } header: {
            if let day = model.inspection?.day {
                Text(ShannonGeneratedStrings.executiveInspectionTitleDay(day: day))
            } else {
                Text(ShannonGeneratedStrings.executiveInspectionTitle)
            }
        } footer: {
            if model.inspection != nil { Text(ShannonGeneratedStrings.executiveInspectionFooter) }
        }
    }

    private func countRow(label: String, today: String, week: String, palette: ShannonPalette, isHeader: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
            Text(label)
                .font(.shannon(.callout))
                .foregroundStyle(palette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: ShannonSpacing.small)
            Text(today)
                .frame(minWidth: 64, alignment: .trailing)
            Text(week)
                .frame(minWidth: 64, alignment: .trailing)
        }
        .font(isHeader ? Font.shannon(.caption).weight(.semibold) : Font.shannon(.callout))
        .monospacedDigit()
        .foregroundStyle(isHeader ? palette.textSecondary : palette.textPrimary)
    }

    // MARK: できること

    @ViewBuilder
    private func capabilitiesSection(palette: ShannonPalette) -> some View {
        let catalogue = model.catalogue
        let activities = catalogue.filter { $0.layer != "tool" }
        let tools = catalogue.filter { $0.layer == "tool" }
        Section {
            if model.capabilities == nil {
                phaseLine(model.capabilitiesPhase, palette: palette)
            } else if catalogue.isEmpty {
                quietLine(ShannonGeneratedStrings.executiveCapabilitiesEmpty, palette: palette)
            } else {
                ForEach(activities) { capability in
                    capabilityRow(capability, palette: palette)
                }
            }
            if !tools.isEmpty {
                DisclosureGroup {
                    ForEach(tools) { capability in
                        capabilityRow(capability, palette: palette)
                    }
                } label: {
                    Text(ShannonGeneratedStrings.executiveCapabilitiesToolsTitle(count: String(tools.count)))
                        .font(.shannon(.callout))
                        .foregroundStyle(palette.textSecondary)
                }
            }
            if model.capabilities != nil, model.capabilitiesPhase == .unreadable {
                Text(ShannonGeneratedStrings.executiveUnreadable)
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
            }
        } header: {
            Text(ShannonGeneratedStrings.executiveCapabilitiesTitle)
        } footer: {
            if !catalogue.isEmpty { Text(ShannonGeneratedStrings.executiveCapabilitiesFooter) }
        }
    }

    private func capabilityRow(_ capability: ShannonCapabilitiesDTO.Capability, palette: ShannonPalette) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.small) {
                Text(capability.label ?? capability.id)
                    .font(.shannon(.body))
                    .foregroundStyle(capability.policy == "off" ? palette.textSecondary : palette.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if let policy = ShannonExecutiveText.policyWord(capability.policy) {
                    ShannonExecutiveChip(text: policy, palette: palette)
                }
            }
            if let purpose = capability.purpose, !purpose.isEmpty {
                Text(purpose)
                    .font(.shannon(.footnote))
                    .foregroundStyle(palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text([ShannonExecutiveText.valueLine(capability.value), ShannonExecutiveText.usesLine(capability)].joined(separator: "・"))
                .font(.shannon(.caption))
                .monospacedDigit()
                .foregroundStyle(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Parts

    @ViewBuilder
    private func phaseLine(_ phase: ShannonExecutiveModel.Phase, palette: ShannonPalette) -> some View {
        switch phase {
        case .notReady: quietLine(ShannonGeneratedStrings.executiveNotReady, palette: palette)
        case .unreadable: quietLine(ShannonGeneratedStrings.executiveUnreadable, palette: palette)
        case .loading, .loaded: EmptyView()
        }
    }

    private func quietLine(_ text: String, palette: ShannonPalette) -> some View {
        Text(text)
            .font(.shannon(.callout))
            .foregroundStyle(palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
