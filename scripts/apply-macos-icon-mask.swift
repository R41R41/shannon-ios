#!/usr/bin/env swift

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
let assets = root.appending(path: "apps/macos-app/ShannonDesk/Assets.xcassets", directoryHint: .isDirectory)
let masters = root.appending(path: "apps/ios/Sources/ShannonAppCore/Resources", directoryHint: .isDirectory)
let variants = ["ShannonL02", "ShannonL06", "ShannonL10"]
let checkOnly = CommandLine.arguments.dropFirst().contains("--check")

struct Manifest: Decodable {
    struct MacOSRendering: Decodable {
        let alphaMask: String
        let cornerRadiusRatio: Double
        let bodyScale: Double
    }

    let macosRendering: MacOSRendering
}

let manifestURL = root.appending(path: "config/shannon-app-icons.json")
let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifestURL))
guard manifest.macosRendering.alphaMask == "roundedRectangle" else {
    throw NSError(
        domain: "ShannonIconGenerator",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "macosRendering.alphaMask must be roundedRectangle"]
    )
}
let cornerRadiusRatio = manifest.macosRendering.cornerRadiusRatio
let bodyScale = manifest.macosRendering.bodyScale

struct Catalog: Decodable {
    struct Image: Decodable {
        let filename: String?
        let scale: String
        let size: String

        var pixelSize: Int? {
            guard
                let points = Double(size.split(separator: "x")[0]),
                let multiplier = Double(scale.replacingOccurrences(of: "x", with: ""))
            else { return nil }
            return Int(points * multiplier)
        }
    }

    let images: [Image]
}

func sourceImage(at url: URL) throws -> CGImage {
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        throw CocoaError(.fileReadCorruptFile, userInfo: [NSFilePathErrorKey: url.path])
    }
    return image
}

func bodyBounds(pixelSize: Int) -> CGRect {
    let bodyPixelSize = Int((Double(pixelSize) * bodyScale).rounded())
    let origin = (pixelSize - bodyPixelSize) / 2
    return CGRect(x: origin, y: origin, width: bodyPixelSize, height: bodyPixelSize)
}

func maskedPNG(source image: CGImage, pixelSize: Int, outputURL: URL) throws -> Data {
    guard let context = CGContext(
        data: nil,
        width: pixelSize,
        height: pixelSize,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: outputURL.path])
    }

    context.interpolationQuality = .high
    let bounds = bodyBounds(pixelSize: pixelSize)
    let radius = bounds.width * CGFloat(cornerRadiusRatio)
    context.addPath(CGPath(
        roundedRect: bounds,
        cornerWidth: radius,
        cornerHeight: radius,
        transform: nil
    ))
    context.clip()
    context.draw(image, in: bounds)

    guard let maskedImage = context.makeImage() else {
        throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: outputURL.path])
    }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(
        data,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: outputURL.path])
    }
    CGImageDestinationAddImage(destination, maskedImage, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: outputURL.path])
    }
    return data as Data
}

func alphaBounds(of image: CGImage) -> CGRect? {
    let width = image.width
    let height = image.height
    let bytesPerRow = width * 4
    guard
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
        let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ),
        let data = context.data
    else { return nil }

    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    let bytes = data.assumingMemoryBound(to: UInt8.self)
    var minX = width
    var minY = height
    var maxX = -1
    var maxY = -1
    for y in 0..<height {
        for x in 0..<width where bytes[y * bytesPerRow + x * 4 + 3] > 1 {
            minX = min(minX, x)
            minY = min(minY, y)
            maxX = max(maxX, x)
            maxY = max(maxY, y)
        }
    }
    guard maxX >= minX, maxY >= minY else { return nil }
    return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
}

func validateLayout(at url: URL, pixelSize: Int) throws {
    let image = try sourceImage(at: url)
    let expected = bodyBounds(pixelSize: pixelSize)
    let actual = alphaBounds(of: image)
    let edgeTolerance = max(1.0, expected.width * 0.01)
    let matchesExpectedFootprint = actual.map { bounds in
        bounds.minX >= expected.minX - edgeTolerance
            && bounds.minY >= expected.minY - edgeTolerance
            && bounds.maxX <= expected.maxX + edgeTolerance
            && bounds.maxY <= expected.maxY + edgeTolerance
            && abs(bounds.midX - expected.midX) <= edgeTolerance
            && abs(bounds.midY - expected.midY) <= edgeTolerance
            && bounds.width >= expected.width - edgeTolerance
            && bounds.height >= expected.height - edgeTolerance
            && bounds.width <= expected.width + edgeTolerance
            && bounds.height <= expected.height + edgeTolerance
    } ?? false
    guard matchesExpectedFootprint else {
        throw NSError(domain: "ShannonIconGenerator", code: 2, userInfo: [
            NSFilePathErrorKey: url.path,
            NSLocalizedDescriptionKey: "Expected alpha bounds \(expected), found \(String(describing: actual))"
        ])
    }
}

for variant in variants {
    let catalog = assets.appending(path: "\(variant).appiconset", directoryHint: .isDirectory)
    let contentsURL = catalog.appending(path: "Contents.json")
    let contents = try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: contentsURL))
    let masterURL = masters.appending(path: "\(variant)-1024.png")
    let master = try sourceImage(at: masterURL)

    for image in contents.images {
        guard let filename = image.filename, let pixelSize = image.pixelSize else { continue }
        let outputURL = catalog.appending(path: filename)
        if !checkOnly {
            try maskedPNG(source: master, pixelSize: pixelSize, outputURL: outputURL)
                .write(to: outputURL, options: .atomic)
        }
        try validateLayout(at: outputURL, pixelSize: pixelSize)
    }
}

let action = checkOnly ? "Verified" : "Applied"
print("\(action) the macOS \(bodyScale * 100)% rounded-rectangle layout for \(variants.count) Shannon icon catalogs.")
