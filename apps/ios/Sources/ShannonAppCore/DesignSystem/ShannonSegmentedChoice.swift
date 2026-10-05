import SwiftUI

/// A small segmented choice drawn by SwiftUI itself, for places inside a list on the Mac.
///
/// The system segmented control (`Picker` with `.segmented`) is an AppKit view. Inside a `List` row on
/// the Mac (an `NSTableView`) it sets its accessibility label on every update, and
/// while an accessibility client is active AppKit then asks the table row for its accessibility
/// children, which asks SwiftUI's view graph again in the middle of the same update. The graph
/// finds a cycle and the main thread hangs (2026-10-05, Mac review of A10–A15: the 24時間／7日 switch of
/// 気分の推移 in the ようす list). This control has no platform view, so nothing re-enters the graph.
/// Outside lists the system control is still used.
public struct ShannonSegmentedChoice<Value: Hashable>: View {
    public struct Option: Identifiable {
        public let value: Value
        public let title: String
        public var id: Value { value }

        public init(_ title: String, value: Value) {
            self.title = title
            self.value = value
        }
    }

    private let label: String
    private let options: [Option]
    @Binding private var selection: Value
    @Environment(\.colorScheme) private var colorScheme

    public init(_ label: String, selection: Binding<Value>, options: [Option]) {
        self.label = label
        _selection = selection
        self.options = options
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        HStack(spacing: 2) {
            ForEach(options) { option in
                let isSelected = option.value == selection
                Button {
                    selection = option.value
                } label: {
                    Text(option.title)
                        .font(.shannon(.caption).weight(isSelected ? .semibold : .regular))
                        .foregroundStyle(isSelected ? palette.textPrimary : palette.textSecondary)
                        .lineLimit(1)
                        .padding(.horizontal, ShannonSpacing.small)
                        .padding(.vertical, 3)
                        .background {
                            if isSelected {
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .fill(palette.elevatedSurface)
                                    .shadow(color: .black.opacity(0.12), radius: 1, y: 0.5)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
            }
        }
        .padding(2)
        .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }
}
