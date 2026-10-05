import CoreGraphics
import Foundation

/// The owner's settings of her desktop body on the Mac (roadmap A17). Per Mac, in `UserDefaults`; changed in
/// 設定 › すがた, 設定 › カメラ and the menu bar item (docs/product/information-architecture.md, 3 and 8 #27).
public enum ShannonDesktopBodyPreference {
    /// Her window on the desktop. Off until the owner shows her.
    public static let shownKey = "shannon.desktop-body.shown"
    /// Above other windows (the default, as on Windows).
    public static let alwaysOnTopKey = "shannon.desktop-body.always-on-top"
    /// 「シャノンから話しかける」: her own messages and the lines of a moment, shown and said by the body.
    public static let speaksKey = "shannon.desktop-body.speaks"
    /// 「小さくしたときは、目だけにする」 (body.small-eyes, owner decision 2026-10-05). On by default.
    public static let smallEyesKey = "shannon.desktop-body.small-eyes"
    /// 「シャノンがカメラで部屋を見てよい」. Off by default (Syzygy ADR-0002, 部屋をひと目見る).
    public static let cameraKey = "shannon.desktop-body.camera"
    /// Where she stands and how large she is, per display.
    public static let placesKey = "shannon.desktop-body.places"
    public static let lastDisplayKey = "shannon.desktop-body.last-display"

    public static func isShown(_ defaults: UserDefaults = .standard) -> Bool { defaults.bool(forKey: shownKey) }
    public static func alwaysOnTop(_ defaults: UserDefaults = .standard) -> Bool { defaults.object(forKey: alwaysOnTopKey) as? Bool ?? true }
    public static func speaks(_ defaults: UserDefaults = .standard) -> Bool { defaults.object(forKey: speaksKey) as? Bool ?? true }
    public static func smallEyes(_ defaults: UserDefaults = .standard) -> Bool { defaults.object(forKey: smallEyesKey) as? Bool ?? true }
    public static func camera(_ defaults: UserDefaults = .standard) -> Bool { defaults.bool(forKey: cameraKey) }
}

/// Her place on one display: the window's origin from the display's visible corner, and her size.
public struct ShannonDesktopBodyPlace: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var scale: Double

    public init(x: Double, y: Double, scale: Double) {
        self.x = x
        self.y = y
        self.scale = scale
    }
}

/// The size of her window and where it may stand. Pure, so it is tested without a screen.
/// At 100% the figure is 520 points high with 160 above it for her words, as the Windows body's (`bodySize.ts`).
public enum ShannonDesktopBodyGeometry {
    public static let stageHeight = 520.0
    public static let headroom = 160.0
    public static let baseWidth = 400.0
    /// Narrower than this and her words would not be readable.
    public static let minimumWidth = 300.0
    public static let scaleRange: ClosedRange<Double> = 0.4...3
    /// The sizes offered in the menu and in 設定 › すがた.
    public static let presets: [Double] = [0.5, 0.75, 1, 1.5, 2, 3]
    /// One step of ⌘ and a scroll over her.
    public static let step = 1.06
    /// Below this she shows her eyes alone when 「小さくしたときは、目だけにする」 is on.
    public static let smallEyesBelow = 0.6
    /// At least this much of her window stays on some display when she is carried.
    public static let keptOnScreen = 80.0

    public static func clampScale(_ scale: Double) -> Double {
        guard scale.isFinite else { return 1 }
        return (min(scaleRange.upperBound, max(scaleRange.lowerBound, scale)) * 1000).rounded() / 1000
    }

    /// The window for a size, never larger than the display's visible area.
    public static func windowSize(scale: Double, visible: CGRect) -> CGSize {
        let scale = clampScale(scale)
        let width = min(max(minimumWidth, (baseWidth * scale).rounded()), max(minimumWidth, visible.width))
        let height = min(((stageHeight + headroom) * scale).rounded(), visible.height)
        return CGSize(width: width, height: max(200, height))
    }

    /// Where her figure is drawn inside the window: the lower part, under the room for her words.
    public static func stageRect(in size: CGSize, scale: Double) -> CGRect {
        let stage = min(size.height, (stageHeight * clampScale(scale)).rounded())
        return CGRect(x: 0, y: 0, width: size.width, height: stage)
    }

    /// The first place on a display: its lower right corner, a little in from the edges.
    public static func defaultOrigin(size: CGSize, visible: CGRect) -> CGPoint {
        CGPoint(x: visible.maxX - size.width - 24, y: visible.minY)
    }

    /// Keeps her on the display: her window fully inside its visible area when it fits.
    public static func clamped(origin: CGPoint, size: CGSize, visible: CGRect) -> CGPoint {
        CGPoint(
            x: min(max(origin.x, visible.minX), max(visible.minX, visible.maxX - size.width)),
            y: min(max(origin.y, visible.minY), max(visible.minY, visible.maxY - size.height)))
    }

    /// While she is carried she may hang over an edge, but some of her stays on one of the displays.
    public static func carried(origin: CGPoint, size: CGSize, displays: [CGRect]) -> CGPoint {
        let frame = CGRect(origin: origin, size: size)
        if displays.contains(where: { $0.intersection(frame).width >= keptOnScreen && $0.intersection(frame).height >= keptOnScreen }) {
            return origin
        }
        guard let nearest = displays.min(by: { distance($0, frame) < distance($1, frame) }) else { return origin }
        let inset = nearest.insetBy(dx: -(size.width - keptOnScreen), dy: -(size.height - keptOnScreen))
        return clamped(origin: origin, size: size, visible: inset)
    }

    private static func distance(_ display: CGRect, _ frame: CGRect) -> Double {
        hypot(display.midX - frame.midX, display.midY - frame.midY)
    }

    /// The place a window frame is, kept as offsets from the display's visible corner (so a rearranged display keeps it).
    public static func place(of frame: CGRect, scale: Double, visible: CGRect) -> ShannonDesktopBodyPlace {
        ShannonDesktopBodyPlace(x: frame.minX - visible.minX, y: frame.minY - visible.minY, scale: clampScale(scale))
    }

    /// The window frame for a stored place on a display, or the default place at 100%.
    public static func frame(for place: ShannonDesktopBodyPlace?, visible: CGRect) -> CGRect {
        let scale = place?.scale ?? 1
        let size = windowSize(scale: scale, visible: visible)
        let origin = place.map { CGPoint(x: visible.minX + $0.x, y: visible.minY + $0.y) } ?? defaultOrigin(size: size, visible: visible)
        return CGRect(origin: clamped(origin: origin, size: size, visible: visible), size: size)
    }

    /// The new size after `notches` steps of ⌘ and a scroll (positive is larger).
    public static func stepped(_ scale: Double, notches: Double) -> Double {
        clampScale(scale * pow(step, max(-5, min(5, notches))))
    }

    /// The preset nearest to a size, for the checkmark of the menu.
    public static func nearestPreset(_ scale: Double) -> Double? {
        presets.first { abs($0 - scale) < 0.01 }
    }
}

/// Places per display, read from and written to `UserDefaults` as JSON.
public struct ShannonDesktopBodyPlaces: Equatable, Sendable {
    public var byDisplay: [String: ShannonDesktopBodyPlace]

    public init(byDisplay: [String: ShannonDesktopBodyPlace] = [:]) {
        self.byDisplay = byDisplay
    }

    public static func load(_ defaults: UserDefaults = .standard) -> Self {
        guard let data = defaults.data(forKey: ShannonDesktopBodyPreference.placesKey),
              let decoded = try? JSONDecoder().decode([String: ShannonDesktopBodyPlace].self, from: data) else { return Self() }
        return Self(byDisplay: decoded)
    }

    public func save(_ defaults: UserDefaults = .standard) {
        // A handful of displays at most; an old one is kept, as it may be connected again.
        guard let data = try? JSONEncoder().encode(byDisplay.count > 32 ? [:] : byDisplay) else { return }
        defaults.set(data, forKey: ShannonDesktopBodyPreference.placesKey)
    }
}
