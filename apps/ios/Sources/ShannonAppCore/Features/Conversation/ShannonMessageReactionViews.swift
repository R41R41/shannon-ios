import SwiftUI

/// The quick reactions at the top of a message's menu (long press on the iPhone, right click on the Mac), Discord-style:
/// six emoji and 「＋」 for the full picker. Nothing while others may see the screen.
public struct ShannonReactionMenuItems: View {
    let message: ConversationMessage
    let model: ShannonReactionsModel
    let threadID: String?

    public init(message: ConversationMessage, model: ShannonReactionsModel, threadID: String?) {
        self.message = message
        self.model = model
        self.threadID = threadID
    }

    public var body: some View {
        if let target = model.target(for: message, threadID: threadID) {
            ControlGroup {
                ForEach(ShannonReactionsModel.quick, id: \.self) { emoji in
                    Button {
                        Task { await model.toggle(emoji, on: message, threadID: threadID) }
                    } label: {
                        Text(emoji)
                    }
                    .accessibilityLabel(model.emojis(for: message).contains(emoji) ? "\(emoji) を外す" : "\(emoji) を付ける")
                }
                Button {
                    model.pickerTarget = target
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("ほかの絵文字を選ぶ")
            }
            .controlGroupStyle(.palette)
        }
    }
}

/// The reactions under a message, one chip per emoji with how many put it on (the owner and she, Discord-style); his are
/// outlined. Tapping a chip turns his on or off (hers stays), 「＋」 opens the picker.
public struct ShannonReactionChips: View {
    let message: ConversationMessage
    let model: ShannonReactionsModel
    let threadID: String?
    @Environment(\.colorScheme) private var colorScheme

    public init(message: ConversationMessage, model: ShannonReactionsModel, threadID: String?) {
        self.message = message
        self.model = model
        self.threadID = threadID
    }

    public var body: some View {
        let chips = model.chips(for: message)
        let palette = ShannonPalette.resolve(colorScheme)
        if !chips.isEmpty {
            let target = model.target(for: message, threadID: threadID)
            HStack(spacing: ShannonSpacing.extraSmall) {
                ForEach(chips, id: \.emoji) { chip in
                    Button {
                        Task { await model.toggle(chip.emoji, on: message, threadID: threadID) }
                    } label: {
                        Text("\(chip.emoji) \(chip.count)")
                            .font(.shannon(.footnote).monospacedDigit())
                            .padding(.horizontal, ShannonSpacing.small)
                            .padding(.vertical, 3)
                            .background(chip.mine ? palette.intelligenceSoft : palette.subtleSurface, in: Capsule())
                            .overlay { Capsule().stroke(palette.brandPresence.opacity(chip.mine ? 0.45 : 0), lineWidth: 0.8) }
                    }
                    .buttonStyle(.plain)
                    .frame(minHeight: 32)
                    .disabled(target == nil)
                    .help("\(chip.who)が付けました")
                    .accessibilityLabel("\(chip.emoji)、\(chip.who)が付けています")
                    .accessibilityHint(target == nil ? "" : chip.mine ? "押すと外します" : "押すと付けます")
                }
                if let target {
                    Button {
                        model.pickerTarget = target
                    } label: {
                        Image(systemName: "face.smiling")
                            .font(.shannon(.footnote))
                            .foregroundStyle(palette.textSecondary)
                            .padding(.horizontal, ShannonSpacing.small)
                            .padding(.vertical, 3)
                            .background(palette.subtleSurface, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .frame(minHeight: 32)
                    .accessibilityLabel("反応を足す")
                }
                if model.isPending(message) {
                    ProgressView().controlSize(.mini)
                }
            }
            .disabled(model.isPending(message))
            .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
        }
    }
}

/// The full picker: any emoji, by category or typed with the emoji keyboard.
struct ShannonReactionPickerSheet: View {
    let target: ShannonReactionTarget
    let model: ShannonReactionsModel
    @State private var typed = ""
    @Environment(\.dismiss) private var dismiss

    struct Category: Identifiable, Sendable {
        let title: String
        let emojis: [String]
        var id: String { title }
        init(_ title: String, _ emojis: [String]) {
            self.title = title
            self.emojis = emojis
        }
    }

    static let categories: [Category] = [
        Category("よく使う", ShannonReactionsModel.quick + ["👎", "🎉", "✨", "🔥", "💯", "👀", "🤔", "😊"]),
        Category("顔", ["😀", "😄", "😁", "😆", "🥹", "😅", "🤣", "🙂", "😉", "😍", "🥰", "😘", "😋", "😎", "🤩", "🥳", "😏", "😌",
               "😴", "🫠", "😳", "🥺", "😢", "😭", "😤", "😠", "😱", "😨", "😰", "🤯", "😶", "🫡", "🤗", "🤭", "🙄", "😬"]),
        Category("手と人", ["👏", "🙌", "👌", "✌️", "🤞", "🫶", "🤝", "💪", "👋", "🙋", "🙇", "🤷", "🙆", "🙅", "👐", "☝️"]),
        Category("ハート", ["🧡", "💛", "💚", "💙", "💜", "🤍", "🖤", "💕", "💖", "💗", "💝", "💔", "❤️‍🔥", "💞"]),
        Category("もの・しるし", ["⭐️", "🌟", "💡", "📌", "✅", "❌", "⭕️", "❓", "❗️", "💤", "🎵", "🍵", "☕️", "🍰", "🌸", "🌙",
                     "☀️", "🌈", "🐱", "🐶", "🍀", "📚", "✏️", "🎁"]),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ShannonSpacing.large) {
                    TextField("絵文字を入力", text: $typed)
                        .textFieldStyle(.roundedBorder)
                        .onChange(of: typed) { _, value in
                            guard let emoji = ShannonReactionsModel.emoji(from: value) else { return }
                            choose(emoji)
                        }
                    ForEach(Self.categories) { category in
                        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
                            Text(category.title)
                                .font(.shannon(.caption).weight(.semibold))
                                .foregroundStyle(.secondary)
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: ShannonSpacing.small)], spacing: ShannonSpacing.small) {
                                ForEach(category.emojis, id: \.self) { emoji in
                                    Button {
                                        choose(emoji)
                                    } label: {
                                        Text(emoji)
                                            .font(.system(size: 28))
                                            .frame(width: 44, height: 44)
                                            .background(selected(emoji) ? Color.shannonActionColor.opacity(0.18) : Color.clear,
                                                        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel(selected(emoji) ? "\(emoji) を外す" : "\(emoji) を付ける")
                                }
                            }
                        }
                    }
                }
                .padding(ShannonSpacing.large)
            }
            .navigationTitle("反応を選ぶ")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
#if os(macOS)
        .frame(minWidth: 420, minHeight: 480)
#endif
    }

    private func selected(_ emoji: String) -> Bool {
        model.emojis(for: target.message).contains(emoji)
    }

    private func choose(_ emoji: String) {
        let message = target.message, threadID = target.threadID
        Task { await model.toggle(emoji, on: message, threadID: threadID) }
        dismiss()
    }
}

/// The Mac's hover button and right-click menu for a message's reactions (the iPhone uses the message's long-press menu).
struct ShannonMessageReactionAffordance: ViewModifier {
    let message: ConversationMessage
    let model: ShannonReactionsModel
    let threadID: String?
    @State private var hovering = false
    @State private var showsQuick = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottomTrailing) {
                if (hovering || showsQuick), let target = model.target(for: message, threadID: threadID) {
                    Button {
                        showsQuick = true
                    } label: {
                        Image(systemName: "face.smiling")
                            .padding(4)
                            .background(.regularMaterial, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .help("反応を付ける")
                    .accessibilityLabel("反応を付ける")
                    .popover(isPresented: $showsQuick) {
                        HStack(spacing: 6) {
                            ForEach(ShannonReactionsModel.quick, id: \.self) { emoji in
                                Button {
                                    showsQuick = false
                                    Task { await model.toggle(emoji, on: message, threadID: threadID) }
                                } label: {
                                    Text(emoji).font(.system(size: 22)).frame(width: 34, height: 34)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(model.emojis(for: message).contains(emoji) ? "\(emoji) を外す" : "\(emoji) を付ける")
                            }
                            Button {
                                showsQuick = false
                                model.pickerTarget = target
                            } label: {
                                Image(systemName: "plus").frame(width: 34, height: 34)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("ほかの絵文字を選ぶ")
                        }
                        .padding(8)
                    }
                }
            }
            .onHover { hovering = $0 }
            .contextMenu {
                ShannonReactionMenuItems(message: message, model: model, threadID: threadID)
            }
    }
}

public extension View {
    /// Hover button and right-click menu for reactions (the Mac).
    @MainActor
    func shannonMessageReactions(_ message: ConversationMessage, model: ShannonReactionsModel, threadID: String?) -> some View {
        modifier(ShannonMessageReactionAffordance(message: message, model: model, threadID: threadID))
    }

    /// Presents the full emoji picker of `model` (once per Talk list).
    @MainActor
    func shannonReactionPicker(_ model: ShannonReactionsModel) -> some View {
        sheet(item: Binding(get: { model.pickerTarget }, set: { model.pickerTarget = $0 })) { target in
            ShannonReactionPickerSheet(target: target, model: model)
        }
    }
}
