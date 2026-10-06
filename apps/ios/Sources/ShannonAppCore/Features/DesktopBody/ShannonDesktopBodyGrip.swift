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
/// The window has to decide at the press, before the page has seen it, and the page names a part only once a touch is
/// under way, and it has no call that says the part at a point. So the part at a point comes from `zones`: where the
/// bundled page names a part that carries, measured from the page itself (see `zones`), so that the edge of a zone
/// never touches her head, hair, neck or legs.
///
/// Fallback when no part is known at a point (outside the zones, an unknown body): the page's `region`, if one is
/// known, and only `face` carries; with neither, she is not picked up and the press is a touch. Her eyes alone are her
/// face (the page always names `face` for them), so they carry wherever they are drawn.
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

    /// Measured from the bundled page (0.1.0+202610060219; its hit areas are those of the model of 2026-10-06 02:07) with
    /// `tools/live2d-grip-probe` in a 400 x 680 page, her own sway off: each point pressed once (her face settled with a
    /// pause between presses, so that the resting stroke a tap on her head starts is never credited to the next point),
    /// and a point kept only when its eight neighbours (about 4 points apart at 100%) named the same kind or nothing.
    /// Her face is the middle of her forehead (the eyes and the bangs are her head to the page, and the rest of the face
    /// is too broken up by them to keep); her boots are below her legs. Measure again when the model changes.
    static let zones: [Zone] = [
        Zone(part: .face, box: CGRect(x: -0.0250, y: 0.1200, width: 0.0420, height: 0.0180)),
        Zone(part: .other, box: CGRect(x: -0.0550, y: 0.8050, width: 0.0300, height: 0.1100)),
        Zone(part: .other, box: CGRect(x: -0.0250, y: 0.8250, width: 0.0100, height: 0.1000)),
        Zone(part: .other, box: CGRect(x: 0.0450, y: 0.8050, width: 0.0300, height: 0.1100)),
        Zone(part: .other, box: CGRect(x: 0.0350, y: 0.8550, width: 0.0100, height: 0.0700)),
    ]
}
