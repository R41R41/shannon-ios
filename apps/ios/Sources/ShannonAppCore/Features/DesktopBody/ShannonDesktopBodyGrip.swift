import CoreGraphics
import Foundation

/// Where her desktop body on the Mac may be picked up (owner decision 2026-10-06: the rule of her Windows body).
///
/// The rule is the acting code's (`embed.js`, the carry of the touch recogniser the page shares with Windows): a press
/// carries her only on her face (the parts of `region: face`: forehead, cheeks and the rest of the face) or on what has
/// no named part (`other`: her boots and the like). Her head and hair, neck, chest, waist, legs, skirt, shoulders, arms,
/// hands, belly and sides never pick her up: such a press is the page's at once and stays a touch, and the parts she
/// may not want touched flinch as the page makes them.
///
/// The window has to decide at the press, before the page has seen it. It asks the page (`shannonBody.partAt`, pages
/// since 0.1.0+202610060340), which says without starting a touch whether the point is `carriable` by that rule (her
/// face, eyes and nose included, and her boots; with her eyes alone, the eyes and just around them). The press is held
/// until the answer, which comes within a few milliseconds; moved far enough before it, the fallback below decides
/// (`ShannonDesktopBodyCarry.Grip.asking`). A clear spot (`null`) is not where she is picked up.
///
/// Fallback, for a page without `partAt` (an older page), an error, or an answer this app cannot read: `zones`, where an
/// earlier page named a part that carries, measured from the page itself (see `zones`), so that the edge of a zone never
/// touches her head, hair, neck or legs. Outside them the page's `region`, if one is known, decides (only `face`
/// carries); with neither, she is not picked up and the press is a touch. Her eyes alone are her face, so they carry
/// wherever they are drawn. With no figure shown at all she is carried from anywhere (`mayCarry`, `pageShown`).
public enum ShannonDesktopBodyGrip {
    /// The rule, from what the page names at a point.
    public static func carries(part: ShannonLive2DTouch.Part?, region: ShannonLive2DTouch.Region?) -> Bool {
        if let part { return part == .other || Self.region(of: part) == .face }
        return region == .face
    }

    /// The parent region of a part (`docs/body-contract.md`, the table of parts).
    static func region(of part: ShannonLive2DTouch.Part) -> ShannonLive2DTouch.Region {
        switch part {
        case .head, .hair: .head
        case .forehead, .cheek, .face: .face
        case .hand: .hand
        case .side: .side
        case .shoulder, .arm, .belly, .neck, .chest, .waist, .leg, .skirt, .other: .body
        }
    }

    /// Whether a press at `point` (window coordinates, y up) may pick her up. `stage` is where the page is drawn.
    /// `pageShown`: her Live2D figure is what the window shows. While it is not (the page loading or failed, Live2D not in
    /// this build, the waterlight eye standing in), there is no figure to touch and no part to name: like her eyes
    /// alone, she is picked up wherever she is drawn.
    public static func mayCarry(at point: CGPoint, stage: CGRect, body: ShannonLive2DBody, pageShown: Bool) -> Bool {
        carries(part: part(at: point, stage: stage, body: pageShown ? body : .eyes), region: nil)
    }

    /// What the page said to `partAt`.
    public enum PageAnswer: Equatable, Sendable {
        /// A part of her, and whether she may be picked up there.
        case part(carriable: Bool)
        /// A clear spot, or outside her drawing.
        case clear
        /// No answer this app can use: no `partAt` (an older page), an error, or a shape it does not know.
        case unavailable
    }

    /// One statement for the page, at a point in CSS pixels. It always answers text, so that an older page (no `partAt`)
    /// or a `null` never meets the web view's handling of `undefined`: "missing", or the answer as JSON ("null" included).
    public static func partAtScript(x: Double, y: Double) -> String {
        let number = { (value: Double) in value.isFinite ? String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), value) : "0" }
        return "(function(){var b=window.shannonBody;if(!b||typeof b.partAt!=='function')return 'missing';"
            + "var r=b.partAt(\(number(x)),\(number(y)));return JSON.stringify(r===undefined?null:r);})()"
    }

    /// The page's text, read as an answer.
    public static func pageAnswer(_ result: Any?, failed: Bool = false) -> PageAnswer {
        guard !failed, let text = result as? String, text != "missing", let data = text.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return .unavailable }
        if value is NSNull { return .clear }
        guard let object = value as? [String: Any], let carriable = object["carriable"] as? Bool else { return .unavailable }
        return .part(carriable: carriable)
    }

    /// Whether she may be picked up, from the page's answer, or from the fallback when it has none.
    public static func decision(_ answer: PageAnswer, fallback: Bool) -> Bool {
        switch answer {
        case let .part(carriable): carriable
        case .clear: false
        case .unavailable: fallback
        }
    }

    /// Asks the page at a point (CSS pixels) and decides. `evaluate` runs one statement in the page and answers its
    /// result; it throws when the page could not run it.
    @MainActor public static func ask(
        at css: CGPoint, fallback: Bool, evaluate: @MainActor (String) async throws -> Any?
    ) async -> Bool {
        let result: Any?
        let failed: Bool
        do {
            result = try await evaluate(partAtScript(x: css.x, y: css.y))
            failed = false
        } catch {
            result = nil
            failed = true
        }
        return decision(pageAnswer(result, failed: failed), fallback: fallback)
    }

    /// The part the page names at a point, where that part carries her; nil elsewhere (which never carries).
    public static func part(at point: CGPoint, stage: CGRect, body: ShannonLive2DBody) -> ShannonLive2DTouch.Part? {
        guard stage.width > 0, stage.height > 0, stage.contains(point) else { return nil }
        if body == .eyes { return .face }
        let canvas = canvas(stage.size)
        guard canvas.height > 0 else { return nil }
        let u = (point.x - stage.midX) / canvas.height
        let v = (stage.maxY - point.y - canvas.top) / canvas.height
        return zones.first { $0.box.contains(CGPoint(x: u, y: v)) }?.part
    }

    /// The page's drawing of her in `full` fitted to a stage of this size (`embed.js`, `wa`: the full figure spans
    /// 0.03–0.95 of the canvas height, and is at most as wide as the stage allows): its height and its top, in points
    /// from the top of the stage.
    static func canvas(_ size: CGSize) -> (height: Double, top: Double) {
        let fromHeight = max(1, size.height) / (0.95 - 0.03)
        let fromWidth = max(1, size.width) / (3507.0 / 5592.0 * 0.96)
        let height = min(fromHeight, fromWidth)
        return (height.rounded(), (size.height / 2 - (0.03 + 0.95) / 2 * height).rounded())
    }

    struct Zone: Equatable {
        let part: ShannonLive2DTouch.Part
        /// `x` across from the middle of the stage, `y` down from the top of the drawing, both in drawing heights.
        let box: CGRect
    }

    /// The `modelUpdatedAt` of the bundled page the zones were measured on. A test holds it equal to the bundled
    /// `version.json`, so that a new model cannot be bundled with zones of the old one (`docs/live2d-embed.md`,
    /// "Updating the page").
    static let measuredFor = "2026-10-06T08:06:16.503Z"

    /// Measured from the bundled page (0.1.0+202610060827, the model of 2026-10-06 08:06) with `tools/live2d-grip-probe`
    /// in a 400 x 680 page, her own sway off, by asking its `partAt` at every point (6/1000 of the drawing apart on her
    /// face, 1/100 on her boots), and keeping a point only when its eight neighbours (about 4 points apart at 100%) named
    /// the same kind or nothing; pieces of fewer than three points are left out. Her face is the middle of her forehead and
    /// a few pieces of her cheeks, eyes and nose (the bangs and the eyelids are her head to the page and break the rest
    /// up); her boots are below her legs. Measure again when the model changes.
    static let zones: [Zone] = [
        Zone(part: .face, box: CGRect(x: -0.0250, y: 0.1200, width: 0.0420, height: 0.0180)),
        Zone(part: .face, box: CGRect(x: 0.0170, y: 0.1620, width: 0.0060, height: 0.0180)),
        Zone(part: .face, box: CGRect(x: -0.0250, y: 0.1680, width: 0.0060, height: 0.0180)),
        Zone(part: .face, box: CGRect(x: -0.0190, y: 0.1740, width: 0.0060, height: 0.0180)),
        Zone(part: .face, box: CGRect(x: 0.0110, y: 0.1740, width: 0.0060, height: 0.0180)),
        Zone(part: .face, box: CGRect(x: -0.0130, y: 0.1800, width: 0.0240, height: 0.0120)),
        Zone(part: .other, box: CGRect(x: -0.0550, y: 0.7950, width: 0.0300, height: 0.1200)),
        Zone(part: .other, box: CGRect(x: -0.0250, y: 0.8250, width: 0.0100, height: 0.1000)),
        Zone(part: .other, box: CGRect(x: 0.0450, y: 0.7950, width: 0.0300, height: 0.1200)),
        Zone(part: .other, box: CGRect(x: 0.0350, y: 0.8450, width: 0.0100, height: 0.0800)),
    ]
}
