import CoreGraphics

enum ShannonWorkspaceMotionPolicy {
    static func pageProgress(
        from start: CGFloat,
        translation: CGFloat,
        width: CGFloat,
        pageCount: Int
    ) -> CGFloat {
        guard width > 0, pageCount > 0 else { return start }
        return clamp(start - translation / width, lower: 0, upper: CGFloat(pageCount - 1))
    }

    static func targetPage(
        from start: CGFloat,
        predictedTranslation: CGFloat,
        width: CGFloat,
        pageCount: Int
    ) -> Int {
        let projected = pageProgress(
            from: start,
            translation: predictedTranslation,
            width: width,
            pageCount: pageCount
        )
        let origin = min(max(Int(start.rounded()), 0), max(0, pageCount - 1))
        let projectedTarget = Int(projected.rounded())
        return min(max(projectedTarget, origin - 1), origin + 1)
    }

    static func drawerProgress(
        from start: CGFloat,
        translation: CGFloat,
        drawerWidth: CGFloat
    ) -> CGFloat {
        guard drawerWidth > 0 else { return start }
        return clamp(start + translation / drawerWidth, lower: 0, upper: 1)
    }

    static func shouldOpenDrawer(
        from start: CGFloat,
        predictedTranslation: CGFloat,
        drawerWidth: CGFloat
    ) -> Bool {
        drawerProgress(
            from: start,
            translation: predictedTranslation,
            drawerWidth: drawerWidth
        ) > 0.42
    }

    private static func clamp(_ value: CGFloat, lower: CGFloat, upper: CGFloat) -> CGFloat {
        min(max(value, lower), upper)
    }
}
