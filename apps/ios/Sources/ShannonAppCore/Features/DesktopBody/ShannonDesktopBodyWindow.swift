#if os(macOS)
import AppKit
import SwiftUI
import WebKit

/// Her window: borderless, transparent and shadowless, on every Space and beside full-screen apps, never the key or
/// main window (a click on her does not bring the app forward), and not hidden with the app (⌘H hides its windows,
/// not her). It is not one of the app's windows for the voice call's rules either (`canBecomeMain` is false).
final class ShannonDesktopBodyPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Shows her window where she stood on this display, at her size there; carries her; and lets the pointer through
/// everywhere but over her figure.
@MainActor
final class ShannonDesktopBodyWindowController {
    let panel: ShannonDesktopBodyPanel
    let hostID = UUID()
    private weak var body: ShannonDesktopBody?
    private var carry = ShannonDesktopBodyCarry()
    private var heldDown: NSEvent?
    private var monitor: Any?
    private var hitTask: Task<Void, Never>?
    private var holdTask: Task<Void, Never>?
    private var screenObserver: NSObjectProtocol?
    private var occlusionObserver: NSObjectProtocol?
    private var places = ShannonDesktopBodyPlaces.load()
    private var mask: ShannonDesktopBodyMask?
    private var maskReadAt = Date.distantPast
    private var readingMask = false

    init(body: ShannonDesktopBody) {
        self.body = body
        panel = ShannonDesktopBodyPanel(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 680), styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.canHide = false
        panel.isReleasedWhenClosed = false
        panel.isMovable = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.title = ShannonGeneratedStrings.desktopBodyFigure
        let hosting = NSHostingView(rootView: ShannonDesktopBodyView(model: body, hostID: hostID))
        hosting.sizingOptions = []
        panel.contentView = hosting
    }

    func show(alwaysOnTop: Bool) {
        restorePlace()
        applyLevel(alwaysOnTop: alwaysOnTop)
        panel.orderFrontRegardless()
        if monitor == nil {
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp, .scrollWheel]) { [weak self] event in
                guard let self, self.handle(event) else { return event }
                return nil
            }
        }
        screenObserver = screenObserver ?? NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.screensChanged() } }
        occlusionObserver = occlusionObserver ?? NotificationCenter.default.addObserver(
            forName: NSWindow.didChangeOcclusionStateNotification, object: panel, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.body?.updateSeen() } }
        hitTask?.cancel()
        hitTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.followPointer()
                try? await Task.sleep(for: .milliseconds(80))
            }
        }
    }

    func hide() {
        endPress()
        hitTask?.cancel()
        hitTask = nil
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        screenObserver = nil
        if let occlusionObserver { NotificationCenter.default.removeObserver(occlusionObserver) }
        occlusionObserver = nil
        panel.orderOut(nil)
    }

    func applyLevel(alwaysOnTop: Bool) {
        panel.level = alwaysOnTop ? .floating : .normal
    }

    // MARK: Her place, per display

    static func key(for screen: NSScreen) -> String {
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return screen.localizedName }
        let id = CGDirectDisplayID(number.uint32Value)
        guard let uuid = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue(),
              let text = CFUUIDCreateString(nil, uuid) as String? else { return "display-\(id)" }
        return text
    }

    /// On the display she was last on when it is connected, otherwise the main one, where she stood there.
    private func restorePlace() {
        let last = UserDefaults.standard.string(forKey: ShannonDesktopBodyPreference.lastDisplayKey)
        guard let screen = NSScreen.screens.first(where: { Self.key(for: $0) == last }) ?? NSScreen.main ?? NSScreen.screens.first else { return }
        let place = places.byDisplay[Self.key(for: screen)]
        body?.scale = place?.scale ?? 1
        panel.setFrame(ShannonDesktopBodyGeometry.frame(for: place, visible: screen.visibleFrame), display: true)
        mask = nil
        body?.applySmallEyes()
    }

    private func savePlace() {
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let key = Self.key(for: screen)
        places.byDisplay[key] = ShannonDesktopBodyGeometry.place(of: panel.frame, scale: body?.scale ?? 1, visible: screen.visibleFrame)
        places.save()
        UserDefaults.standard.set(key, forKey: ShannonDesktopBodyPreference.lastDisplayKey)
    }

    /// A new size keeps her feet where they were.
    func resize(scale: Double) {
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let size = ShannonDesktopBodyGeometry.windowSize(scale: scale, visible: screen.visibleFrame)
        let old = panel.frame
        let origin = ShannonDesktopBodyGeometry.clamped(
            origin: CGPoint(x: old.midX - size.width / 2, y: old.minY), size: size, visible: screen.visibleFrame)
        panel.setFrame(CGRect(origin: origin, size: size), display: true)
        mask = nil
        savePlace()
    }

    /// A display was removed or rearranged: she goes back to a place she knows on a display that is there.
    private func screensChanged() {
        guard panel.isVisible else { return }
        let onScreen = NSScreen.screens.contains { $0.frame.intersects(panel.frame) }
        if !onScreen { restorePlace() }
    }

    // MARK: The pointer

    /// The page's web view while it is in her window.
    private var webView: WKWebView? {
        guard let webView = ShannonLive2DStage.shared.webView, webView.window === panel else { return nil }
        return webView
    }

    /// Her figure in window coordinates: read from a picture of the page, or estimated.
    private var currentMask: ShannonDesktopBodyMask {
        let size = panel.frame.size
        let stage = ShannonDesktopBodyGeometry.stageRect(in: size, scale: body?.scale ?? 1)
        if let mask, mask.stage == stage, webView != nil { return mask }
        return ShannonDesktopBodyMask.estimated(stage: stage)
    }

    /// The window takes the pointer only over her (and while a press on her lasts).
    private func followPointer() {
        guard panel.isVisible else { return }
        if carry.isPressed {
            if panel.ignoresMouseEvents { panel.ignoresMouseEvents = false }
            return
        }
        let mouse = NSEvent.mouseLocation
        let frame = panel.frame
        guard frame.contains(mouse) else {
            if !panel.ignoresMouseEvents { panel.ignoresMouseEvents = true }
            return
        }
        let over = currentMask.contains(CGPoint(x: mouse.x - frame.minX, y: mouse.y - frame.minY))
        if panel.ignoresMouseEvents == over { panel.ignoresMouseEvents = !over }
        if Date().timeIntervalSince(maskReadAt) > 0.4 { readMask() }
    }

    /// A small picture of the page, for where she is drawn. Her figure moves (breathing, gestures), so it is read again
    /// while the pointer is over her window.
    private func readMask() {
        guard !readingMask, let webView else { return }
        readingMask = true
        maskReadAt = Date()
        let configuration = WKSnapshotConfiguration()
        configuration.snapshotWidth = 48
        let stage = ShannonDesktopBodyGeometry.stageRect(in: panel.frame.size, scale: body?.scale ?? 1)
        webView.takeSnapshot(with: configuration) { [weak self] image, _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.readingMask = false
                guard let cgImage = image?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
                self.mask = Self.alphaGrid(cgImage).flatMap { ShannonDesktopBodyMask.read(alpha: $0.alpha, columns: $0.columns, rows: $0.rows, stage: stage) }
            }
        }
    }

    /// The alpha of a picture, at most 48 cells across, top row first.
    nonisolated static func alphaGrid(_ image: CGImage) -> (alpha: [UInt8], columns: Int, rows: Int)? {
        let columns = min(48, max(1, image.width))
        let rows = max(1, Int((Double(image.height) / Double(max(1, image.width)) * Double(columns)).rounded()))
        var pixels = [UInt8](repeating: 0, count: columns * rows * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: columns, height: rows, bitsPerComponent: 8, bytesPerRow: columns * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: columns, height: rows))
            return true
        }
        guard drawn else { return nil }
        // A bitmap context's first row in memory is the top of the picture.
        return (stride(from: 3, to: pixels.count, by: 4).map { pixels[$0] }, columns, rows)
    }

    // MARK: Pressing and carrying

    /// Every press on her window is the window's to decide (see `ShannonDesktopBodyCarry`).
    private func handle(_ event: NSEvent) -> Bool {
        guard event.window === panel else { return false }
        switch event.type {
        case .leftMouseDown:
            heldDown = event
            // Only her face or her boots pick her up (`ShannonDesktopBodyGrip`); any other press is a touch at once.
            let stage = ShannonDesktopBodyGeometry.stageRect(in: panel.frame.size, scale: body?.scale ?? 1)
            let page = ShannonLive2DStage.shared
            let pageShown = webView != nil && ShannonLive2DStage.isAvailable && page.status == .ready && page.activeHost == hostID
            let mayCarry = ShannonDesktopBodyGrip.mayCarry(at: event.locationInWindow, stage: stage, body: page.body, pageShown: pageShown)
            apply(carry.down(at: NSEvent.mouseLocation, mayCarry: mayCarry, origin: panel.frame.origin, time: event.timestamp), event: event)
            if mayCarry { waitForHold() }
        case .leftMouseDragged:
            apply(carry.drag(to: NSEvent.mouseLocation, time: event.timestamp), event: event)
        case .leftMouseUp:
            holdTask?.cancel()
            apply(carry.up(time: event.timestamp), event: event)
            heldDown = nil
        case .scrollWheel:
            // ⌘ and a scroll over her: her size, as the Windows body's Ctrl and the wheel.
            guard event.modifierFlags.contains(.command), let body else { return false }
            let delta = event.scrollingDeltaY * (event.isDirectionInvertedFromDevice ? -1 : 1)
            let notches = event.hasPreciseScrollingDeltas ? delta / 12 : delta
            guard notches != 0 else { return true }
            body.setScale(ShannonDesktopBodyGeometry.stepped(body.scale, notches: Double(notches)))
        default:
            return false
        }
        return true
    }

    private func waitForHold() {
        holdTask?.cancel()
        holdTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(ShannonDesktopBodyCarry.holdSeconds + 0.02))
            guard !Task.isCancelled, let self, let down = self.heldDown else { return }
            self.apply(self.carry.tick(time: ProcessInfo.processInfo.systemUptime), event: down)
        }
    }

    private func apply(_ effects: [ShannonDesktopBodyCarry.Effect], event: NSEvent) {
        for effect in effects {
            switch effect {
            case .deliverDown:
                if let down = heldDown { webView?.mouseDown(with: down) }
            case .deliverDrag:
                webView?.mouseDragged(with: event)
            case .deliverUp:
                webView?.mouseUp(with: event)
            case .beginCarry:
                NSCursor.closedHand.push()
                ShannonLive2DStage.shared.express("surprised", seconds: 2)
            case let .moveWindow(origin):
                let size = panel.frame.size
                panel.setFrameOrigin(ShannonDesktopBodyGeometry.carried(origin: origin, size: size, displays: NSScreen.screens.map(\.frame)))
            case let .endCarry(durationMs):
                NSCursor.pop()
                savePlace()
                body?.carried(durationMs: durationMs)
            }
        }
    }

    /// The window goes while a press lasts: a carry ends where she is, and a press the page holds is released there
    /// (with a release made from the press), so that no touch of the page stays held.
    private func endPress() {
        holdTask?.cancel()
        let down = heldDown
        let release = down.flatMap { down in
            NSEvent.mouseEvent(
                with: .leftMouseUp, location: down.locationInWindow, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: down.windowNumber, context: nil, eventNumber: down.eventNumber, clickCount: down.clickCount, pressure: 0)
        }
        let effects = carry.cancel(time: ProcessInfo.processInfo.systemUptime)
        if let release { apply(effects, event: release) }
        heldDown = nil
    }
}
#endif
