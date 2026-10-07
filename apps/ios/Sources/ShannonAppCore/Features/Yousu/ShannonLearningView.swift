import SwiftUI

/// 「ようす › 学び」 (Syzygy ADR-0008 §13, option A; owner 2026-10-07): her skills with how they went and a pin, 手応え of the
/// last seven days, and the value table's version with 「前の版に戻す」 and resume. A number is never shown without its word.
/// Shared by the iPhone and the Mac (ADR-0004); a part the server does not offer to this device is left out.
struct ShannonLearningView: View {
    @Bindable var model: ShannonLearningModel

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var rollbackToConfirm: ShannonValuesDTO.Version?
    @State private var confirmsResume = false
    @State private var openedSkill: String?

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        ScrollViewReader { proxy in
            List {
                if model.isUnavailable {
                    Section {
                        quietLine(ShannonGeneratedStrings.yousuLearningUnavailable, palette: palette)
                    }
                }
                if model.skillsPhase != .hidden { skillsSection(palette: palette) }
                if model.valuesPhase != .hidden {
                    valuesSection(palette: palette)
                    versionSection(palette: palette)
                }
            }
#if DEBUG
            .task(id: model.values != nil) { await previewScroll(proxy) }
#endif
        }
        .overlay {
            if model.skills == nil, model.values == nil, model.isLoading {
                ProgressView(ShannonGeneratedStrings.yousuLoading)
            }
        }
        .refreshable { await model.reload() }
        // Read when the tab appears and when the app comes back to the front; never in the background.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await model.reload()
        }
        .navigationDestination(item: $openedSkill) { skillID in
            ShannonSkillDetailPage(model: model.detailModel(for: skillID))
        }
        .confirmationDialog(
            ShannonGeneratedStrings.yousuLearningVersionRollbackConfirmTitle,
            isPresented: Binding(get: { rollbackToConfirm != nil }, set: { if !$0 { rollbackToConfirm = nil } }),
            titleVisibility: .visible,
            presenting: rollbackToConfirm
        ) { target in
            Button(ShannonGeneratedStrings.yousuLearningVersionRollback, role: .destructive) {
                Task { await model.rollback(to: target) }
            }
            Button(ShannonGeneratedStrings.yousuLearningCancel, role: .cancel) {}
        } message: { target in
            Text(ShannonGeneratedStrings.yousuLearningVersionRollbackConfirmMessage(time: ShannonYousuTime.clock(target.createdAt)))
        }
        .confirmationDialog(ShannonGeneratedStrings.yousuLearningVersionResumeConfirmTitle, isPresented: $confirmsResume, titleVisibility: .visible) {
            Button(ShannonGeneratedStrings.yousuLearningVersionResumeConfirm) {
                Task { await model.resume() }
            }
            Button(ShannonGeneratedStrings.yousuLearningCancel, role: .cancel) {}
        } message: {
            Text(ShannonGeneratedStrings.yousuLearningVersionResumeConfirmMessage)
        }
    }

#if DEBUG
    /// Design previews only (`-ShannonPreviewLearningScroll values|version`): brings the lower cards up for screenshots.
    private func previewScroll(_ proxy: ScrollViewProxy) async {
        guard model.values != nil, let target = UserDefaults.standard.string(forKey: "ShannonPreviewLearningScroll") else { return }
        try? await Task.sleep(for: .milliseconds(600))
        withAnimation { proxy.scrollTo("learning.\(target)", anchor: .top) }
    }
#endif

    private func quietLine(_ text: String, palette: ShannonPalette) -> some View {
        Text(text)
            .font(.shannon(.callout))
            .foregroundStyle(palette.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Skills

    @ViewBuilder
    private func skillsSection(palette: ShannonPalette) -> some View {
        Section {
            if let notice = model.skillNotice {
                Label(notice, systemImage: "exclamationmark.triangle")
                    .font(.shannon(.footnote))
                    .foregroundStyle(palette.onAttentionTint)
                    .listRowBackground(palette.attentionTint)
            }
            if model.skills == nil {
                if model.skillsPhase == .unreadable { quietLine(ShannonGeneratedStrings.yousuLearningUnreadable, palette: palette) }
            } else if model.activeSkills.isEmpty {
                quietLine(ShannonGeneratedStrings.yousuLearningSkillsEmpty, palette: palette)
            } else {
                ForEach(model.activeSkills) { skill in
                    skillRow(skill, palette: palette)
                }
            }
            if !model.retiredSkills.isEmpty {
                DisclosureGroup {
                    ForEach(model.retiredSkills) { skill in
                        skillRow(skill, palette: palette)
                    }
                } label: {
                    Text(ShannonGeneratedStrings.yousuLearningSkillsRetiredTitle(count: String(model.retiredSkills.count)))
                        .font(.shannon(.callout))
                        .foregroundStyle(palette.textSecondary)
                }
            }
            if model.skills != nil, model.skillsPhase == .unreadable {
                Text(ShannonGeneratedStrings.yousuLearningUnreadable)
                    .font(.shannon(.caption))
                    .foregroundStyle(palette.textSecondary)
            }
        } header: {
            if let capacity = model.skills?.capacity {
                Text(ShannonGeneratedStrings.yousuLearningSkillsTitle(used: String(capacity.used), limit: String(capacity.limit)))
                    .accessibilityLabel(ShannonGeneratedStrings.yousuLearningSkillsTitleAccessibility(limit: String(capacity.limit), used: String(capacity.used)))
            } else {
                Text(ShannonGeneratedStrings.yousuLearningSkillsHeading)
            }
        } footer: {
            if model.skills != nil {
                Text(ShannonGeneratedStrings.yousuLearningSkillsFooter)
            }
        }
    }

    private func skillRow(_ skill: ShannonSkillDTO, palette: ShannonPalette) -> some View {
        HStack(alignment: .center, spacing: ShannonSpacing.small) {
            Button {
                openedSkill = skill.id
            } label: {
                HStack(spacing: ShannonSpacing.small) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(skill.description)
                            .font(.shannon(.body))
                            .foregroundStyle(skill.isRetired ? palette.textSecondary : palette.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: ShannonSpacing.small) {
                            Text(ShannonLearning.skillLine(skill))
                                .monospacedDigit()
                            if skill.ownerVersion {
                                Text(ShannonGeneratedStrings.yousuLearningSkillsOwnerVersion)
                            }
                        }
                        .font(.shannon(.footnote))
                        .foregroundStyle(palette.textSecondary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.shannon(.caption).weight(.semibold))
                        .foregroundStyle(palette.textSecondary)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(ShannonLearning.skillAccessibilityLabel(skill))
            .accessibilityHint(ShannonGeneratedStrings.yousuLearningSkillsOpenHint)
            .accessibilityAddTraits(.isButton)
            if !skill.isRetired { pinButton(skill, palette: palette) }
        }
    }

    private func pinButton(_ skill: ShannonSkillDTO, palette: ShannonPalette) -> some View {
        let sending = model.pinsInFlight.contains(skill.id)
        return Button {
            Task { await model.setPinned(skill.id, pinned: !skill.pinned) }
        } label: {
            Image(systemName: skill.pinned ? "pin.fill" : "pin")
                .font(.shannon(.body))
                .foregroundStyle(skill.pinned ? palette.action : palette.textSecondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(sending)
        .accessibilityLabel(skill.pinned ? ShannonGeneratedStrings.yousuLearningSkillsUnpin : ShannonGeneratedStrings.yousuLearningSkillsPin)
        .accessibilityValue(skill.pinned ? ShannonGeneratedStrings.yousuLearningSkillsPinned : ShannonGeneratedStrings.yousuLearningSkillsNotPinned)
        .accessibilityHint(ShannonGeneratedStrings.yousuLearningSkillsPinHint)
    }

    // MARK: 手応え

    @ViewBuilder
    private func valuesSection(palette: ShannonPalette) -> some View {
        let lines = model.recentValues
        Section {
            if model.values == nil {
                if model.valuesPhase == .unreadable { quietLine(ShannonGeneratedStrings.yousuLearningUnreadable, palette: palette) }
            } else if lines.isEmpty {
                quietLine(ShannonGeneratedStrings.yousuLearningValuesEmpty, palette: palette)
            } else {
                ForEach(lines) { line in
                    HStack(alignment: .firstTextBaseline, spacing: ShannonSpacing.medium) {
                        Text(line.label)
                            .font(.shannon(.callout))
                            .foregroundStyle(palette.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: ShannonSpacing.small)
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(line.value)
                                .font(.shannon(.callout).weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(palette.textPrimary)
                            Text(ShannonGeneratedStrings.yousuLearningValuesWordCount(word: line.level.word, count: String(line.n)))
                                .font(.shannon(.caption))
                                .foregroundStyle(palette.textSecondary)
                                .lineLimit(1)
                        }
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(line.accessibilityLabel)
                    .id(line.id == lines.first?.id ? "learning.values" : "learning.values.\(line.id)")
                }
            }
        } header: {
            Text(ShannonGeneratedStrings.yousuLearningValuesTitle)
        } footer: {
            if !lines.isEmpty { Text(ShannonGeneratedStrings.yousuLearningValuesFooter) }
        }
    }

    // MARK: The value table's version

    @ViewBuilder
    private func versionSection(palette: ShannonPalette) -> some View {
        if let values = model.values {
            Section(ShannonGeneratedStrings.yousuLearningVersionTitle) {
                if let active = values.active {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ShannonGeneratedStrings.yousuLearningVersionCurrent(time: ShannonYousuTime.clock(active.createdAt), maker: ShannonLearning.makerWord(active.madeBy)))
                            .font(.shannon(.callout))
                            .foregroundStyle(palette.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(ShannonGeneratedStrings.yousuLearningVersionEvidence(count: String(ShannonLearning.evidenceCount(active))))
                            .font(.shannon(.footnote))
                            .foregroundStyle(palette.textSecondary)
                    }
                    .accessibilityElement(children: .combine)
                    .id("learning.version")
                    if values.frozen {
                        Label(ShannonGeneratedStrings.yousuLearningVersionFrozen, systemImage: "pause.circle")
                            .font(.shannon(.footnote))
                            .foregroundStyle(palette.onAttentionTint)
                            .fixedSize(horizontal: false, vertical: true)
                            .listRowBackground(palette.attentionTint)
                        controlButton(ShannonGeneratedStrings.yousuLearningVersionResume, color: palette.action) { confirmsResume = true }
                    } else if let target = model.rollbackTarget {
                        controlButton(ShannonGeneratedStrings.yousuLearningVersionRollback, color: palette.danger) { rollbackToConfirm = target }
                            .accessibilityHint(ShannonGeneratedStrings.yousuLearningVersionRollbackHint(time: ShannonYousuTime.clock(target.createdAt)))
                    } else {
                        quietLine(ShannonGeneratedStrings.yousuLearningVersionNoEarlier, palette: palette)
                    }
                } else {
                    quietLine(ShannonGeneratedStrings.yousuLearningVersionNone, palette: palette)
                }
                if let notice = model.valuesNotice {
                    Label(notice, systemImage: "exclamationmark.triangle")
                        .font(.shannon(.footnote))
                        .foregroundStyle(palette.onAttentionTint)
                        .listRowBackground(palette.attentionTint)
                }
            }
        }
    }

    private func controlButton(_ title: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: ShannonSpacing.small) {
                Text(title)
                    .font(.shannon(.body).weight(.medium))
                    .foregroundStyle(color)
                if model.isChangingValues {
                    Spacer(minLength: 0)
                    ProgressView()
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(model.isChangingValues)
    }
}

/// One skill: what it is for, its SKILL.md (or the note in its place) and its versions. Nothing here can be changed.
struct ShannonSkillDetailPage: View {
    @Bindable var model: ShannonSkillDetailModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        List {
            if let detail = model.detail {
                Section {
                    VStack(alignment: .leading, spacing: ShannonSpacing.extraSmall) {
                        Text(detail.skill.description)
                            .font(.shannon(.title3).weight(.semibold))
                            .foregroundStyle(palette.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(ShannonLearning.skillLine(detail.skill))
                            .font(.shannon(.footnote))
                            .monospacedDigit()
                            .foregroundStyle(palette.textSecondary)
                        Text(detail.skill.name)
                            .font(.shannon(.caption).monospaced())
                            .foregroundStyle(palette.textSecondary)
                            .accessibilityLabel(ShannonGeneratedStrings.yousuLearningSkillName(name: detail.skill.name))
                    }
                    .accessibilityElement(children: .combine)
                }
                Section(ShannonGeneratedStrings.yousuLearningSkillBody) {
                    if detail.bodyHidden {
                        Text(ShannonGeneratedStrings.yousuLearningSkillBodyHidden)
                            .font(.shannon(.callout))
                            .foregroundStyle(palette.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(detail.body)
                            .font(.shannon(.callout))
                            .foregroundStyle(palette.textPrimary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if !model.versions.isEmpty {
                    Section(ShannonGeneratedStrings.yousuLearningSkillVersions) {
                        ForEach(model.versions, id: \.version) { revision in
                            revisionRow(revision, palette: palette)
                        }
                    }
                }
            } else if model.phase == .unreadable {
                Text(ShannonGeneratedStrings.yousuLearningUnreadable)
                    .font(.shannon(.callout))
                    .foregroundStyle(palette.textSecondary)
            }
        }
        .overlay {
            if model.detail == nil, model.phase == .loading { ProgressView() }
        }
        .navigationTitle(model.detail?.skill.description ?? ShannonGeneratedStrings.yousuLearningSkillsHeading)
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
        .task { await model.load() }
    }

    private func revisionRow(_ revision: ShannonSkillDetailDTO.Revision, palette: ShannonPalette) -> some View {
        let uses = revision.uses ?? 0
        let usage = uses == 0
            ? ShannonGeneratedStrings.yousuLearningSkillsUnused
            : ShannonGeneratedStrings.yousuLearningSkillsSuccess(successes: String(revision.successes ?? 0), uses: String(uses))
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: ShannonSpacing.small) {
                Text(ShannonGeneratedStrings.yousuLearningSkillVersion(version: String(revision.version)))
                    .font(.shannon(.callout).weight(.semibold))
                Text(ShannonLearning.actorWord(revision.actor))
                    .font(.shannon(.callout))
                if let createdAt = revision.createdAt {
                    Spacer(minLength: ShannonSpacing.small)
                    Text(ShannonYousuTime.clock(createdAt))
                        .font(.shannon(.footnote))
                        .monospacedDigit()
                        .foregroundStyle(palette.textSecondary)
                }
            }
            .foregroundStyle(palette.textPrimary)
            Text(usage)
                .font(.shannon(.footnote))
                .monospacedDigit()
                .foregroundStyle(palette.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }
}
