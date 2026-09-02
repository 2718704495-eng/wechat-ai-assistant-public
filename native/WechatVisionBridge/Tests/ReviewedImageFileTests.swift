import Foundation
import XCTest
@testable import WechatVisionBridge

final class ReviewedImageFileTests: XCTestCase {
    private let expectedHash = "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177"

    func testOpensTheReviewedPngFromOneDescriptorAndBindsItsBytesAndDimensions() throws {
        let image = try ReviewedImageFile.open(
            path: reviewedCardPath(),
            expectedSha256: expectedHash,
            expectedWidth: 1080,
            expectedHeight: 1350
        )

        XCTAssertEqual(image.receipt, ImageAttachmentReceipt(
            imageSha256: expectedHash,
            width: 1080,
            height: 1350,
            attachmentCount: 1,
            textEmpty: true
        ))
        XCTAssertEqual(image.bytes.count, 420_209)
        XCTAssertNotNil(image.pixelSha256.range(
            of: "^[a-f0-9]{64}$",
            options: .regularExpression
        ))
    }

    func testRejectsASymlinkOrHashDriftBeforeProducingImageBytes() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("reviewed-image-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let link = root.appendingPathComponent("card.png")
        try FileManager.default.createSymbolicLink(
            at: link,
            withDestinationURL: URL(fileURLWithPath: reviewedCardPath())
        )

        XCTAssertThrowsError(try ReviewedImageFile.open(
            path: link.path,
            expectedSha256: expectedHash,
            expectedWidth: 1080,
            expectedHeight: 1350
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IMAGE_ATTACHMENT_INVALID")
        }
        XCTAssertThrowsError(try ReviewedImageFile.open(
            path: reviewedCardPath(),
            expectedSha256: String(repeating: "0", count: 64),
            expectedWidth: 1080,
            expectedHeight: 1350
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IMAGE_ATTACHMENT_CANDIDATE_MISMATCH")
        }
    }

    private func reviewedCardPath() -> String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("assets/relationship-care/intro-card.png")
            .path
    }
}
