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
    targets: [
        .target(name: "ShannonAppCore"),
        .testTarget(name: "ShannonAppCoreTests", dependencies: ["ShannonAppCore"]),
    ]
)

