import CoreGraphics

enum ShannonWorkspaceMotionPolicy {
    static let drawerOpeningRegionFraction: CGFloat = 0.5

    static func canBeginDrawerDrag(
        isTalkSelected: Bool,
        composerIsFocused: Bool,
        currentProgress: CGFloat,
        viewWidth: CGFloat,
        startX: CGFloat,
        translation: CGSize
    ) -> Bool {
        guard isTalkSelected, !composerIsFocused else { return false }
        guard abs(translation.width) > abs(translation.height) * 1.15 else { return false }
        if currentProgress > 0 { return true }
        let openingRegionWidth = max(0, viewWidth) * drawerOpeningRegionFraction
        return startX <= openingRegionWidth && translation.width > 0
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
