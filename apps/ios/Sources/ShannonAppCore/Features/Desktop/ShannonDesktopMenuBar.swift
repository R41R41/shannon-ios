#if os(macOS)
import AppKit

/// One part of the app's single menu bar item. The item exists while any part wants it, its button shows the
/// first part that has something to show, and its menu lists every part's items in order, separated.
///
/// Two parts: the voice conversation (roadmap A16, owner decision 2026-10-06, option B), which wants the item
/// while a call is on and no window of the app is on screen, and the app's own part (roadmap A17: her desktop
/// body's 出す・隠す, 常に手前, 大きさ, the four entries and 終了), which wants it while the app runs. There is
/// never a second item: the call is the first section of the same menu.
@MainActor
public protocol ShannonDesktopMenuBarSection: AnyObject {
    /// The item is shown while at least one part wants it.
    var wantsMenuBarItem: Bool { get }
    /// What the button shows, with its symbol and its spoken form; nil leaves the button to another part.
    var menuBarButton: ShannonDesktopMenuBarButton? { get }
    /// This part's items, built each time the menu opens so that they are current.
    func menuBarItems() -> [NSMenuItem]
    /// Where the part stands in the menu: lower first.
    var menuBarOrder: Int { get }
}

public extension ShannonDesktopMenuBarSection {
    var menuBarOrder: Int { 0 }
}

public struct ShannonDesktopMenuBarButton: Equatable, Sendable {
    public let title: String
    public let symbol: String
    public let accessibilityLabel: String

    public init(title: String, symbol: String, accessibilityLabel: String) {
        self.title = title
        self.symbol = symbol
        self.accessibilityLabel = accessibilityLabel
    }
}

/// The app's one `NSStatusItem`, made only while a part wants it and removed when none does.
@MainActor
public final class ShannonDesktopMenuBar: NSObject, NSMenuDelegate {
    public static let shared = ShannonDesktopMenuBar()

    private var sections: [ShannonDesktopMenuBarSection] = []
    private var item: NSStatusItem?
    private var appliedSymbol: String?
    /// For tests: makes no status item, only records what would be shown.
    var makesStatusItem = true
    private(set) var shownButton: ShannonDesktopMenuBarButton?

    public func register(_ section: ShannonDesktopMenuBarSection) {
        guard !sections.contains(where: { $0 === section }) else { return }
        sections.append(section)
        sections.sort { $0.menuBarOrder < $1.menuBarOrder }
        refresh()
    }

    public func unregister(_ section: ShannonDesktopMenuBarSection) {
        sections.removeAll { $0 === section }
        refresh()
    }

    /// Whether the item is in the menu bar now.
    public var isShown: Bool { shownButton != nil || item != nil }

    /// Re-reads every part: shows, updates or removes the item.
    public func refresh() {
        guard sections.contains(where: \.wantsMenuBarItem) else {
            if let item { NSStatusBar.system.removeStatusItem(item) }
            item = nil
            appliedSymbol = nil
            shownButton = nil
            return
        }
        let button = sections.lazy.filter(\.wantsMenuBarItem).compactMap(\.menuBarButton).first
            ?? ShannonDesktopMenuBarButton(title: "", symbol: "sparkle", accessibilityLabel: ShannonGeneratedStrings.appName)
        shownButton = button
        guard makesStatusItem else { return }
        if item == nil {
            let made = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            let menu = NSMenu()
            menu.delegate = self
            made.menu = menu
            item = made
        }
        guard let statusButton = item?.button else { return }
        // Refreshed every second while a call shows its time: only what changed is written.
        if appliedSymbol != button.symbol {
            appliedSymbol = button.symbol
            let image = NSImage(systemSymbolName: button.symbol, accessibilityDescription: nil)
            image?.isTemplate = true
            statusButton.image = image
        }
        let position: NSControl.ImagePosition = button.title.isEmpty ? .imageOnly : .imageLeading
        if statusButton.imagePosition != position { statusButton.imagePosition = position }
        if statusButton.title != button.title { statusButton.title = button.title }
        if statusButton.accessibilityLabel() != button.accessibilityLabel {
            statusButton.setAccessibilityLabel(button.accessibilityLabel)
        }
    }

    /// The items of every part that wants the item, in order, with a separator between parts.
    func currentItems() -> [NSMenuItem] {
        var items: [NSMenuItem] = []
        for section in sections where section.wantsMenuBarItem {
            let part = section.menuBarItems()
            guard !part.isEmpty else { continue }
            if !items.isEmpty { items.append(.separator()) }
            items.append(contentsOf: part)
        }
        return items
    }

    public func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        currentItems().forEach(menu.addItem)
    }
}

/// A menu item that runs a closure.
@MainActor
public final class ShannonDesktopMenuItem: NSMenuItem {
    private let run: @MainActor () -> Void

    public init(_ title: String, symbol: String? = nil, state: NSControl.StateValue = .off, run: @escaping @MainActor () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(runAction), keyEquivalent: "")
        target = self
        self.state = state
        if let symbol { image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func runAction() {
        run()
    }

    /// A line that only says something (the call's state at the top of its section).
    public static func caption(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }
}
#endif
