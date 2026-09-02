import CryptoKit
import CoreGraphics
import Darwin
import Foundation
import ImageIO

struct ReviewedImage: Equatable {
    let bytes: Data
    let receipt: ImageAttachmentReceipt
    let pixelSha256: String
}

enum ReviewedImagePixels {
    static func sha256(_ image: CGImage) throws -> String {
        guard image.width == 1080, image.height == 1350,
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
            throw BridgeError("WECHAT_IMAGE_ATTACHMENT_CANDIDATE_MISMATCH")
        }
        let bytesPerRow = image.width * 4
        var pixels = Data(count: bytesPerRow * image.height)
        let rendered = pixels.withUnsafeMutableBytes { rawBuffer -> Bool in
            guard let baseAddress = rawBuffer.baseAddress,
                  let context = CGContext(
                    data: baseAddress,
                    width: image.width,
                    height: image.height,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: colorSpace,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                        | CGBitmapInfo.byteOrder32Big.rawValue
                  ) else {
                return false
            }
            context.setBlendMode(.copy)
            context.interpolationQuality = .none
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return true
        }
        guard rendered else { throw BridgeError("WECHAT_IMAGE_ATTACHMENT_CANDIDATE_MISMATCH") }
        var canonical = Data()
        var width = UInt32(image.width).bigEndian
        var height = UInt32(image.height).bigEndian
        withUnsafeBytes(of: &width) { canonical.append(contentsOf: $0) }
        withUnsafeBytes(of: &height) { canonical.append(contentsOf: $0) }
        canonical.append(pixels)
        return SHA256.hash(data: canonical).map { String(format: "%02x", $0) }.joined()
    }
}

enum ReviewedImageFile {
    private static let maximumBytes: Int64 = 2 * 1024 * 1024

    static func open(
        path: String,
        expectedSha256: String,
        expectedWidth: Int,
        expectedHeight: Int
    ) throws -> ReviewedImage {
        guard path.hasPrefix("/"), !path.contains("\0"),
              expectedSha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              expectedWidth == 1080, expectedHeight == 1350 else {
            throw BridgeError("WECHAT_IMAGE_ATTACHMENT_INVALID")
        }
        let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw BridgeError("WECHAT_IMAGE_ATTACHMENT_INVALID") }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        do {
            var before = stat()
            guard Darwin.fstat(descriptor, &before) == 0,
                  (before.st_mode & S_IFMT) == S_IFREG,
                  before.st_nlink == 1,
                  before.st_uid == getuid(),
                  (before.st_mode & (S_IWGRP | S_IWOTH)) == 0,
                  before.st_size > 0, before.st_size <= maximumBytes else {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_INVALID")
            }
            guard let bytes = try handle.readToEnd(), bytes.count == Int(before.st_size) else {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_INVALID")
            }
            var after = stat()
            guard Darwin.fstat(descriptor, &after) == 0,
                  before.st_dev == after.st_dev,
                  before.st_ino == after.st_ino,
                  before.st_size == after.st_size,
                  before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
                  before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_INVALID")
            }
            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            guard digest == expectedSha256 else {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_CANDIDATE_MISMATCH")
            }
            guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                  CGImageSourceGetType(source) as String? == "public.png",
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
                  image.width == expectedWidth, image.height == expectedHeight else {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_CANDIDATE_MISMATCH")
            }
            try handle.close()
            return ReviewedImage(
                bytes: bytes,
                receipt: ImageAttachmentReceipt(
                    imageSha256: digest,
                    width: image.width,
                    height: image.height,
                    attachmentCount: 1,
                    textEmpty: true
                ),
                pixelSha256: try ReviewedImagePixels.sha256(image)
            )
        } catch {
            try? handle.close()
            throw error
        }
    }
}
