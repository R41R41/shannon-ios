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
            name: "ShannonVoiceDSP",
            path: "Sources/ShannonVoiceDSP",
            publicHeadersPath: "include",
            cxxSettings: [
                .define("SIGNALSMITH_USE_ACCELERATE"),
                .headerSearchPath("vendor"),
            ],
            linkerSettings: [.linkedFramework("Accelerate")]
        ),
        .target(
            name: "ShannonAppCore",
            dependencies: [
                "ShannonVoiceDSP",
                .product(name: "WebRTC", package: "WebRTC", condition: .when(platforms: [.iOS])),
            ],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "ShannonAppCoreTests", dependencies: ["ShannonAppCore"]),
    ]
)
