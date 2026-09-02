import AppKit
import CoreGraphics
import Foundation
import XCTest
@testable import WechatVisionBridge

final class WechatImageSendTests: XCTestCase {
    private let imageSha256 =
        "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177"

    func testSendsOnceOnlyAfterTwoExactPreparedImageReadsAndOutgoingMatch() throws {
        let attachment = ImageSendAttachmentPort(observations: [observation(), observation()])
        let submit = ImageSendSubmitPort()

        let receipt = try WechatImageSendTransaction.send(
            expectation(),
            reviewedImage: try reviewedImage(),
            attachmentPort: attachment,
            submitPort: submit,
            consumptionStore: ImageSendConsumptionStore()
        )

        XCTAssertEqual(receipt.imageSha256, imageSha256)
        XCTAssertTrue(receipt.submitted)
        XCTAssertTrue(receipt.outgoingImageMatched)
        XCTAssertEqual(receipt.visualFingerprintVersion, "vision-featureprint-v1")
        XCTAssertEqual(submit.submitCount, 1)
        XCTAssertEqual(attachment.clearCount, 0)
        XCTAssertEqual(attachment.collapseCount, 2)
    }

    func testClearsBeforeSubmitWhenPreparedPixelsDrift() throws {
        let attachment = ImageSendAttachmentPort(observations: [
            observation(),
            observation(pixelSha256: String(repeating: "f", count: 64)),
        ])
        let submit = ImageSendSubmitPort()

        XCTAssertThrowsError(try WechatImageSendTransaction.send(
            expectation(),
            reviewedImage: try reviewedImage(),
            attachmentPort: attachment,
            submitPort: submit,
            consumptionStore: ImageSendConsumptionStore()
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IMAGE_ATTACHMENT_NOT_VERIFIED")
        }
        XCTAssertEqual(attachment.clearCount, 1)
        XCTAssertEqual(submit.submitCount, 0)
    }

    func testNeverAttemptsComposerCleanupAfterSubmitReadbackFails() throws {
        let attachment = ImageSendAttachmentPort(observations: [observation(), observation()])
        let submit = ImageSendSubmitPort(outgoingError: BridgeError(
            "WECHAT_IMAGE_SEND_RESULT_NOT_VERIFIED"
        ))

        XCTAssertThrowsError(try WechatImageSendTransaction.send(
            expectation(),
            reviewedImage: try reviewedImage(),
            attachmentPort: attachment,
            submitPort: submit,
            consumptionStore: ImageSendConsumptionStore()
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IMAGE_SEND_RESULT_NOT_VERIFIED")
        }
        XCTAssertEqual(submit.submitCount, 1)
        XCTAssertEqual(attachment.clearCount, 0)
    }

    func testUsesCommandReturnOnlyWhenTheExactPreparedCardSurvivesReturn() throws {
        let attachment = ImageSendAttachmentPort(observations: [observation()])
        let keys = ImageSendKeyPort()
        let submit = SystemWechatPreparedImageSubmitPort(
            windowID: 1,
            attachmentPort: attachment,
            expectedPixelSha256: "1".repeatHex(),
            keyPort: keys,
            delay: { _ in }
        )

        try submit.submitPreparedImage()

        XCTAssertEqual(keys.commandFlags, [false, true])
        XCTAssertEqual(attachment.collapseCount, 1)
    }

    func testNeverUsesCommandReturnForChangedOrUnreadableAttachment() throws {
        let changed = ImageSendAttachmentPort(observations: [
            observation(pixelSha256: "f".repeatHex()),
        ])
        let changedKeys = ImageSendKeyPort()
        let changedSubmit = SystemWechatPreparedImageSubmitPort(
            windowID: 1,
            attachmentPort: changed,
            expectedPixelSha256: "1".repeatHex(),
            keyPort: changedKeys,
            delay: { _ in }
        )
        XCTAssertThrowsError(try changedSubmit.submitPreparedImage()) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IMAGE_SEND_RESULT_UNCERTAIN")
        }
        XCTAssertEqual(changedKeys.commandFlags, [false])

        let unreadable = ImageSendAttachmentPort(observations: [])
        let unreadableKeys = ImageSendKeyPort()
        let unreadableSubmit = SystemWechatPreparedImageSubmitPort(
            windowID: 1,
            attachmentPort: unreadable,
            expectedPixelSha256: "1".repeatHex(),
            keyPort: unreadableKeys,
            delay: { _ in }
        )
        XCTAssertNoThrow(try unreadableSubmit.submitPreparedImage())
        XCTAssertEqual(unreadableKeys.commandFlags, [false])
    }

    func testVisualMatcherAcceptsOneReviewedOutgoingCardAndRejectsDuplicates() throws {
        let reviewed = try reviewedImage()
        XCTAssertTrue(try OutgoingReviewedImageMatcher.matches(
            reviewedImage: reviewed,
            in: try screenshot(cardCount: 1, reviewed: reviewed)
        ))
        XCTAssertFalse(try OutgoingReviewedImageMatcher.matches(
            reviewedImage: reviewed,
            in: try screenshot(cardCount: 2, reviewed: reviewed)
        ))
        XCTAssertFalse(try OutgoingReviewedImageMatcher.matches(
            reviewedImage: reviewed,
            in: try screenshot(cardCount: 0, reviewed: reviewed)
        ))
        XCTAssertFalse(try OutgoingReviewedImageMatcher.matches(
            reviewedImage: reviewed,
            in: try wrongCardScreenshot()
        ))
    }

    private func expectation() -> ImageAttachmentExpectation {
        ImageAttachmentExpectation(
            receipt: ImageAttachmentReceipt(
                imageSha256: imageSha256,
                width: 1080,
                height: 1350,
                attachmentCount: 1,
                textEmpty: true
            ),
            pixelSha256: "1".repeatHex()
        )
    }

    private func observation(pixelSha256: String = "1".repeatHex()) -> ImageAttachmentObservation {
        ImageAttachmentObservation(
            pixelSha256: pixelSha256,
            width: 1080,
            height: 1350,
            attachmentCount: 1,
            textEmpty: true,
            hasUnknownRepresentations: false
        )
    }

    private func reviewedImage() throws -> ReviewedImage {
        try ReviewedImageFile.open(
            path: reviewedCardPath(),
            expectedSha256: imageSha256,
            expectedWidth: 1080,
            expectedHeight: 1350
        )
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

    private func screenshot(cardCount: Int, reviewed: ReviewedImage) throws -> CGImage {
        guard let card = NSImage(data: reviewed.bytes)?.cgImage(
            forProposedRect: nil,
            context: nil,
            hints: nil
        ), let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
        let context = CGContext(
            data: nil,
            width: 1600,
            height: 900,
            bitsPerComponent: 8,
            bytesPerRow: 1600 * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw BridgeError("TEST_SCREENSHOT_INVALID")
        }
        context.setFillColor(CGColor(gray: 0.96, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 1600, height: 900))
        let rectangles = [
            CGRect(x: 1250, y: 350, width: 240, height: 300),
            CGRect(x: 920, y: 350, width: 240, height: 300),
        ]
        for rectangle in rectangles.prefix(cardCount) {
            context.setStrokeColor(CGColor(gray: 0.35, alpha: 1))
            context.setLineWidth(2)
            context.stroke(rectangle)
            context.interpolationQuality = .high
            context.draw(card, in: rectangle.insetBy(dx: 2, dy: 2))
        }
        guard let result = context.makeImage() else {
            throw BridgeError("TEST_SCREENSHOT_INVALID")
        }
        return result
    }

    private func wrongCardScreenshot() throws -> CGImage {
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                  data: nil,
                  width: 1600,
                  height: 900,
                  bitsPerComponent: 8,
                  bytesPerRow: 1600 * 4,
                  space: colorSpace,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else {
            throw BridgeError("TEST_SCREENSHOT_INVALID")
        }
        context.setFillColor(CGColor(gray: 0.96, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 1600, height: 900))
        let rectangle = CGRect(x: 1250, y: 350, width: 240, height: 300)
        context.setFillColor(CGColor(red: 0.12, green: 0.62, blue: 0.25, alpha: 1))
        context.fill(rectangle)
        context.setStrokeColor(CGColor(gray: 0.1, alpha: 1))
        context.setLineWidth(2)
        context.stroke(rectangle)
        guard let result = context.makeImage() else {
            throw BridgeError("TEST_SCREENSHOT_INVALID")
        }
        return result
    }
}

private final class ImageSendAttachmentPort: ComposerImageAttachmentPort {
    private var observations: [ImageAttachmentObservation]
    private(set) var clearCount = 0
    private(set) var collapseCount = 0

    init(observations: [ImageAttachmentObservation]) {
        self.observations = observations
    }

    func snapshotPasteboard() throws -> PasteboardSnapshot { PasteboardSnapshot(items: []) }
    func restorePasteboard(_: PasteboardSnapshot) throws {}
    func assertComposerEmptyBaseline() throws {}
    func pasteReviewedImage(_: ImageAttachmentExpectation) throws {}
    func readPreparedImage() throws -> ImageAttachmentObservation {
        guard !observations.isEmpty else { throw BridgeError("TEST_OBSERVATION_MISSING") }
        return observations.removeFirst()
    }
    func collapseSelection() throws { collapseCount += 1 }
    func clearPreparedImage(expectedPixelSha256 _: String) throws { clearCount += 1 }
}

private final class ImageSendSubmitPort: WechatPreparedImageSubmitPort {
    private let outgoingError: Error?
    private(set) var submitCount = 0

    init(outgoingError: Error? = nil) { self.outgoingError = outgoingError }
    func submitPreparedImage() throws { submitCount += 1 }
    func verifyComposerEmptyAfterSubmit() throws {}
    func verifyLatestOutgoingImage(_: ReviewedImage) throws {
        if let outgoingError { throw outgoingError }
    }
}

private final class ImageSendKeyPort: PreparedImageSubmitKeyPort {
    private(set) var commandFlags: [Bool] = []
    func postSubmit(command: Bool) throws { commandFlags.append(command) }
}

private final class ImageSendConsumptionStore: ImageAttachmentCapabilityConsumptionStore {
    func assertClean() throws {}
    func consume(_: ImageAttachmentCapabilityBinding) throws {}
    func markDirty() throws {}
}

private extension String {
    func repeatHex() -> String { String(repeating: self, count: 64) }
}
