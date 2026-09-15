#!/usr/bin/env swift

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
let assets = root.appending(path: "apps/macos-app/ShannonDesk/Assets.xcassets", directoryHint: .isDirectory)
let masters = root.appending(path: "apps/ios/Sources/ShannonAppCore/Resources", directoryHint: .isDirectory)
let variants = ["ShannonL02", "ShannonL06", "ShannonL10"]
let cornerRadiusRatio = 0.223

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
    let bounds = CGRect(x: 0, y: 0, width: pixelSize, height: pixelSize)
    let radius = CGFloat(pixelSize) * cornerRadiusRatio
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

for variant in variants {
    let catalog = assets.appending(path: "\(variant).appiconset", directoryHint: .isDirectory)
    let contentsURL = catalog.appending(path: "Contents.json")
    let contents = try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: contentsURL))
    let masterURL = masters.appending(path: "\(variant)-1024.png")
    let master = try sourceImage(at: masterURL)

    for image in contents.images {
        guard let filename = image.filename, let pixelSize = image.pixelSize else { continue }
        let outputURL = catalog.appending(path: filename)
        try maskedPNG(source: master, pixelSize: pixelSize, outputURL: outputURL)
            .write(to: outputURL, options: .atomic)
    }
}

print("Applied the macOS rounded-rectangle alpha mask to \(variants.count) Shannon icon catalogs.")
