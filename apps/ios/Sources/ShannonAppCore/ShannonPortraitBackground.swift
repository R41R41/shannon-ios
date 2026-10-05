import CoreGraphics

/// The face and kind icons are drawn on an opaque pale lavender canvas. At display time the canvas becomes
/// white, on iPhone and Mac alike, and nothing of the figure changes.
///
/// Only the canvas is replaced: the pixels joined to the picture's edge whose colour is within
/// `canvasDistance` of the top corners' colour, plus a soft band where the figure's outline meets it. Pale
/// lavender, blue and pink inside her hair are never touched, even when they are as pale as the canvas.
/// (Until 2026-10-05 every pale lavender pixel anywhere became white; on the 2026-10-05 art that turned
/// about 12% of each picture white, mostly the pink and lavender highlights of her hair.) Background
/// enclosed by the figure, such as the inside of her hair loops, keeps the canvas colour.
enum ShannonPortraitBackground {
    /// The side of the rendered icon. The apps show icons at 96 points at most (192 pixels at 2×).
    static let outputSide = 384
    /// Largest per-channel distance from the corner colour that is canvas.
    static let canvasDistance = 12
    /// An outline pixel next to the canvas up to this distance is lifted toward white in proportion.
    static let edgeDistance = 48
    /// A picture whose corners are not pale has no canvas to replace and is shown as it is.
    static let paleChannelMinimum = 200

    static func whitened(_ source: CGImage) -> CGImage? {
        let side = outputSide
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return pixels.withUnsafeMutableBytes { buffer -> CGImage? in
            guard let context = CGContext(
                data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return nil }
            context.interpolationQuality = .high
            context.draw(source, in: CGRect(x: 0, y: 0, width: side, height: side))
            let bytes = buffer.bindMemory(to: UInt8.self)
            let canvas = cornerColour(bytes, side: side)
            if canvas.allSatisfy({ $0 >= paleChannelMinimum }) {
                replaceCanvas(bytes, side: side, canvas: canvas)
            }
            return context.makeImage()
        }
    }

    /// The median of each channel over the two top 8×8 corner patches. Her hair reaches the bottom corners
    /// of these bust pictures, so those are not canvas. (The context's first row is the picture's top.)
    private static func cornerColour(_ bytes: UnsafeMutableBufferPointer<UInt8>, side: Int) -> [Int] {
        let patch = 8
        var channels: [[Int]] = [[], [], []]
        for (originX, originY) in [(0, 0), (side - patch, 0)] {
            for y in originY..<(originY + patch) {
                for x in originX..<(originX + patch) {
                    let index = (y * side + x) * 4
                    for channel in 0..<3 { channels[channel].append(Int(bytes[index + channel])) }
                }
            }
        }
        return channels.map { $0.sorted()[$0.count / 2] }
    }

    private static func replaceCanvas(_ bytes: UnsafeMutableBufferPointer<UInt8>, side: Int, canvas: [Int]) {
        let count = side * side
        var distance = [Int](repeating: 0, count: count)
        for pixel in 0..<count {
            let index = pixel * 4
            distance[pixel] = max(
                abs(Int(bytes[index]) - canvas[0]),
                abs(Int(bytes[index + 1]) - canvas[1]),
                abs(Int(bytes[index + 2]) - canvas[2])
            )
        }
        // Flood the canvas from the picture's edge.
        var isCanvas = [Bool](repeating: false, count: count)
        var stack: [Int] = []
        for position in 0..<side {
            for pixel in [position, (side - 1) * side + position, position * side, position * side + side - 1]
            where distance[pixel] <= canvasDistance && !isCanvas[pixel] {
                isCanvas[pixel] = true
                stack.append(pixel)
            }
        }
        func visit(_ neighbour: Int) {
            if !isCanvas[neighbour] && distance[neighbour] <= canvasDistance {
                isCanvas[neighbour] = true
                stack.append(neighbour)
            }
        }
        while let pixel = stack.popLast() {
            let x = pixel % side
            if x > 0 { visit(pixel - 1) }
            if x < side - 1 { visit(pixel + 1) }
            if pixel >= side { visit(pixel - side) }
            if pixel < count - side { visit(pixel + side) }
        }
        // The outline next to the canvas: lift by how close it is to the canvas colour, then whiten the canvas.
        for pixel in 0..<count where !isCanvas[pixel] && distance[pixel] <= edgeDistance && touchesCanvas(pixel, isCanvas, side: side) {
            let weight = 1 - Double(distance[pixel] - canvasDistance) / Double(edgeDistance - canvasDistance)
            let index = pixel * 4
            for channel in 0..<3 {
                let lifted = Double(bytes[index + channel]) + min(1, weight) * Double(255 - canvas[channel])
                bytes[index + channel] = UInt8(max(0, min(255, lifted.rounded())))
            }
        }
        for pixel in 0..<count where isCanvas[pixel] {
            let index = pixel * 4
            bytes[index] = 255
            bytes[index + 1] = 255
            bytes[index + 2] = 255
        }
    }

    private static func touchesCanvas(_ pixel: Int, _ isCanvas: [Bool], side: Int) -> Bool {
        let x = pixel % side
        let y = pixel / side
        for neighbourY in max(0, y - 1)...min(side - 1, y + 1) {
            for neighbourX in max(0, x - 1)...min(side - 1, x + 1) where isCanvas[neighbourY * side + neighbourX] {
                return true
            }
        }
        return false
    }
}
