import SwiftUI

/// Places buttons side by side only when every label fits on one line;
/// otherwise stacks them full width. Labels never wrap inside a button.
struct ShannonButtonRow<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: ShannonSpacing.small) { content() }
            VStack(spacing: ShannonSpacing.small) { content() }
        }
    }
}

/// A single-line, width-filling button label for use inside `ShannonButtonRow`.
struct ShannonButtonLabel: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity)
    }
}
