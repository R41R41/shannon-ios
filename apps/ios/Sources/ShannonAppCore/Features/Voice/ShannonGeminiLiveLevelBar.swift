#if os(iOS)
import SwiftUI

struct ShannonGeminiLiveLevelBar: View {
    let level: Float
    let palette: ShannonPalette

    var body: some View {
        GeometryReader { geometry in
            Capsule()
                .fill(palette.intelligenceSoft)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(palette.brandPresence)
                        .frame(width: max(8, geometry.size.width * CGFloat(level)))
                }
        }
        .frame(height: 5)
        .accessibilityHidden(true)
    }
}
#endif
