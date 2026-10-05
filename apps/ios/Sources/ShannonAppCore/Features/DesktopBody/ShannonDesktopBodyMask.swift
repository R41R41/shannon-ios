import CoreGraphics
import Foundation

/// Where her figure is drawn in her desktop window, so that the window takes the pointer only over her and lets
/// every click elsewhere through to what is behind it (the Windows body does the same with its hit regions).
///
/// It is read from a small picture of the page (the alpha of each cell). A picture that says nothing usable (all clear,
/// or all solid, as when the drawing is not in the picture) is not trusted: the figure is then estimated from where the
/// page places her (`full`, fitted to the stage). Coordinates are the window's, in points, with y growing upwards.
public struct ShannonDesktopBodyMask: Equatable, Sendable {
    public let stage: CGRect
    public let columns: Int
    public let rows: Int
    /// Row 0 is the top of the picture.
    let cells: [Bool]
    /// True when it was read from the page, false when estimated.
    public let isRead: Bool

    /// A cell is opaque from this alpha on (0–255). The clear background is 0; her softest edges are above this.
    public static let alphaThreshold: UInt8 = 24

    /// From a top-down alpha grid of the stage. nil when the picture cannot be trusted.
    public static func read(alpha: [UInt8], columns: Int, rows: Int, stage: CGRect) -> ShannonDesktopBodyMask? {
        guard columns > 0, rows > 0, alpha.count == columns * rows else { return nil }
        let cells = alpha.map { $0 >= alphaThreshold }
        let share = Double(cells.filter { $0 }.count) / Double(cells.count)
        // Nothing drawn, or the whole stage solid: the picture does not show her.
        guard share > 0.01, share < 0.9 else { return nil }
        return ShannonDesktopBodyMask(stage: stage, columns: columns, rows: rows, cells: cells, isRead: true)
    }

    /// Her figure as the page places it in `full`: the middle of the stage, about two fifths of a wide stage's width.
    public static func estimated(stage: CGRect) -> ShannonDesktopBodyMask {
        let columns = 20, rows = 20
        let figureWidth = min(stage.width, stage.height * 0.42)
        let left = (stage.width - figureWidth) / 2 / stage.width
        let right = 1 - left
        var cells: [Bool] = []
        for _ in 0..<rows {
            for column in 0..<columns {
                let x = (Double(column) + 0.5) / Double(columns)
                cells.append(x >= left && x <= right)
            }
        }
        return ShannonDesktopBodyMask(stage: stage, columns: columns, rows: rows, cells: cells, isRead: false)
    }

    /// Whether the pointer at `point` is over her (or right beside her: one cell around counts, so that her edge
    /// does not flicker between taking the pointer and letting it through).
    public func contains(_ point: CGPoint) -> Bool {
        guard let cell = cell(at: point) else { return false }
        for row in max(0, cell.row - 1)...min(rows - 1, cell.row + 1) {
            for column in max(0, cell.column - 1)...min(columns - 1, cell.column + 1) where cells[row * columns + column] {
                return true
            }
        }
        return false
    }

    /// The box around what is drawn, in window coordinates; nil when nothing is.
    public var figureBox: CGRect? {
        var minColumn = columns, maxColumn = -1, minRow = rows, maxRow = -1
        for row in 0..<rows {
            for column in 0..<columns where cells[row * columns + column] {
                minColumn = min(minColumn, column)
                maxColumn = max(maxColumn, column)
                minRow = min(minRow, row)
                maxRow = max(maxRow, row)
            }
        }
        guard maxColumn >= 0 else { return nil }
        let cellWidth = stage.width / Double(columns)
        let cellHeight = stage.height / Double(rows)
        // Row 0 is the top: the box's top edge in window coordinates is the stage's top minus the rows above it.
        return CGRect(
            x: stage.minX + Double(minColumn) * cellWidth, y: stage.maxY - Double(maxRow + 1) * cellHeight,
            width: Double(maxColumn - minColumn + 1) * cellWidth, height: Double(maxRow - minRow + 1) * cellHeight)
    }

    private func cell(at point: CGPoint) -> (row: Int, column: Int)? {
        guard stage.contains(point), stage.width > 0, stage.height > 0 else { return nil }
        let column = min(columns - 1, max(0, Int((point.x - stage.minX) / stage.width * Double(columns))))
        let row = min(rows - 1, max(0, Int((stage.maxY - point.y) / stage.height * Double(rows))))
        return (row, column)
    }
}
