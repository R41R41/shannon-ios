import ShannonAppCore
import SwiftUI

/// 作業 holds the task list and the desktop additions 開発 and 配信 (roadmap A10). The three pages
/// are switched with one segmented control in the toolbar, so each page keeps its own tools.
extension ShannonDesktopRootView {
    var workPageSelection: Binding<DesktopWorkPage> {
        Binding(
            get: { DesktopWorkPage(destination: destination) ?? .tasks },
            set: { selectDestination($0.destination) }
        )
    }
}

extension DesktopWorkPage {
    var title: String {
        switch self {
        case .tasks: ShannonGeneratedStrings.navWork
        case .development: "開発"
        case .release: ShannonGeneratedStrings.navDelivery
        }
    }
}

extension View {
    func desktopWorkPagePicker(selection: Binding<DesktopWorkPage>) -> some View {
        toolbar {
            ToolbarItem(placement: .navigation) {
                Picker(ShannonGeneratedStrings.navWork, selection: selection) {
                    ForEach(DesktopWorkPage.allCases) { page in
                        Text(page.title).tag(page)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .help("作業・開発・配信を切り替えます")
            }
        }
    }
}
