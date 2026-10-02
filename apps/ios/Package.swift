// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ShannonApp",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "ShannonAppCore", targets: ["ShannonAppCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/stasel/WebRTC.git", exact: "152.0.0"),
    ],
    targets: [
        .target(
            name: "ShannonAppCore",
            dependencies: [
                .product(name: "WebRTC", package: "WebRTC", condition: .when(platforms: [.iOS])),
            ],
            // `Live2D` is copied as a folder: the embed page loads its scripts by relative path (docs/live2d-embed.md).
            resources: [.process("Resources"), .copy("Live2D")]
        ),
        .testTarget(name: "ShannonAppCoreTests", dependencies: ["ShannonAppCore"]),
    ]
)
