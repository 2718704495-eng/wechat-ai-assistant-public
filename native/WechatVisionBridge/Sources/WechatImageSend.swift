import AppKit
import CoreGraphics
import Foundation
import ImageIO
import Vision

struct WechatImageSendReceipt: Codable, Equatable {
    let imageSha256: String
    let width: Int
    let height: Int
    let attachmentCount: Int
    let textEmpty: Bool
    let submitted: Bool
    let outgoingImageMatched: Bool
    let visualFingerprintVersion: String
}

protocol WechatPreparedImageSubmitPort: AnyObject {
    func submitPreparedImage() throws
    func verifyComposerEmptyAfterSubmit() throws
    func verifyLatestOutgoingImage(_ reviewedImage: ReviewedImage) throws
}

protocol PreparedImageSubmitKeyPort: AnyObject {
    func postSubmit(command: Bool) throws
}

final class SystemPreparedImageSubmitKeyPort: PreparedImageSubmitKeyPort {
    func postSubmit(command: Bool) throws {
        guard let source = CGEventSource(stateID: .privateState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: false) else {
            throw BridgeError("KEY_EVENT_CREATION_FAILED")
        }
        if command {
            down.flags = .maskCommand
            up.flags = .maskCommand
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

enum WechatImageSendTransaction {
    static func send(
        _ expected: ImageAttachmentExpectation,
        reviewedImage: ReviewedImage,
        attachmentPort: ComposerImageAttachmentPort,
        submitPort: WechatPreparedImageSubmitPort,
        consumptionStore: any ImageAttachmentCapabilityConsumptionStore
    ) throws -> WechatImageSendReceipt {
        let prepared = try ImageAttachmentAttempt.prepare(
            expected,
            using: attachmentPort,
            consumptionStore: consumptionStore
        )
        do {
            let observed = try attachmentPort.readPreparedImage()
            guard ImageAttachmentCleanupAuthorization.permitsUndo(
                observed,
                expectedPixelSha256: expected.pixelSha256
            ) else {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_NOT_VERIFIED")
            }
            try attachmentPort.collapseSelection()
        } catch {
            do {
                try attachmentPort.clearPreparedImage(expectedPixelSha256: expected.pixelSha256)
            } catch {
                try? consumptionStore.markDirty()
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_CLEAR_FAILED")
            }
            throw error
        }

        // From this boundary onward a failure is terminally uncertain. Never mutate the
        // composer in an attempt to retry or reconstruct the send.
        try submitPort.submitPreparedImage()
        try submitPort.verifyComposerEmptyAfterSubmit()
        try submitPort.verifyLatestOutgoingImage(reviewedImage)
        return WechatImageSendReceipt(
            imageSha256: prepared.imageSha256,
            width: prepared.width,
            height: prepared.height,
            attachmentCount: prepared.attachmentCount,
            textEmpty: prepared.textEmpty,
            submitted: true,
            outgoingImageMatched: true,
            visualFingerprintVersion: "vision-featureprint-v1"
        )
    }
}

enum OutgoingReviewedImageMatcher {
    private static let maximumDistance: Float = 0.72

    static func matches(reviewedImage: ReviewedImage, in screenshot: CGImage) throws -> Bool {
        guard let source = CGImageSourceCreateWithData(reviewedImage.bytes as CFData, nil),
              let reference = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw BridgeError("WECHAT_IMAGE_SEND_REFERENCE_INVALID")
        }
        let referenceFeature = try featurePrint(reference)
        let rectangleRequest = VNDetectRectanglesRequest()
        rectangleRequest.maximumObservations = 24
        rectangleRequest.minimumConfidence = 0.45
        rectangleRequest.minimumAspectRatio = 0.68
        rectangleRequest.maximumAspectRatio = 0.92
        rectangleRequest.minimumSize = 0.08
        rectangleRequest.quadratureTolerance = 20
        try VNImageRequestHandler(cgImage: screenshot).perform([rectangleRequest])
        let rectangles = rectangleRequest.results ?? []
        var matchedBounds: [CGRect] = []
        for rectangle in rectangles where isAllowedOutgoingRegion(rectangle.boundingBox) {
            guard let crop = crop(screenshot, normalized: rectangle.boundingBox) else { continue }
            let candidateFeature = try featurePrint(crop)
            var distance: Float = 0
            try candidateFeature.computeDistance(&distance, to: referenceFeature)
            if distance <= maximumDistance { matchedBounds.append(rectangle.boundingBox) }
        }
        var clusters: [CGRect] = []
        for bounds in matchedBounds.sorted(by: { $0.width * $0.height > $1.width * $1.height }) {
            if clusters.contains(where: { overlapRatio(bounds, $0) >= 0.55 }) { continue }
            clusters.append(bounds)
        }
        return clusters.count == 1
    }

    private static func isAllowedOutgoingRegion(_ bounds: CGRect) -> Bool {
        bounds.midX >= 0.56 && bounds.maxX >= 0.68 &&
            bounds.minY >= 0.34 && bounds.maxY <= 0.94
    }

    private static func crop(_ image: CGImage, normalized bounds: CGRect) -> CGImage? {
        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        let rectangle = CGRect(
            x: bounds.minX * width,
            y: (1 - bounds.maxY) * height,
            width: bounds.width * width,
            height: bounds.height * height
        ).integral.intersection(CGRect(x: 0, y: 0, width: width, height: height))
        guard rectangle.width > 0, rectangle.height > 0 else { return nil }
        return image.cropping(to: rectangle)
    }

    private static func overlapRatio(_ left: CGRect, _ right: CGRect) -> CGFloat {
        let intersection = left.intersection(right)
        guard !intersection.isNull else { return 0 }
        let smaller = min(left.width * left.height, right.width * right.height)
        guard smaller > 0 else { return 0 }
        return intersection.width * intersection.height / smaller
    }

    private static func featurePrint(_ image: CGImage) throws -> VNFeaturePrintObservation {
        let request = VNGenerateImageFeaturePrintRequest()
        try VNImageRequestHandler(cgImage: image).perform([request])
        guard let feature = request.results?.first as? VNFeaturePrintObservation else {
            throw BridgeError("WECHAT_IMAGE_SEND_FEATURE_UNAVAILABLE")
        }
        return feature
    }
}

final class SystemWechatPreparedImageSubmitPort: WechatPreparedImageSubmitPort {
    private let windowID: UInt32
    private let attachmentPort: ComposerImageAttachmentPort
    private let expectedPixelSha256: String
    private let keyPort: PreparedImageSubmitKeyPort
    private let delay: (TimeInterval) -> Void

    init(
        windowID: UInt32,
        attachmentPort: ComposerImageAttachmentPort,
        expectedPixelSha256: String,
        keyPort: PreparedImageSubmitKeyPort = SystemPreparedImageSubmitKeyPort(),
        delay: @escaping (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }
    ) {
        self.windowID = windowID
        self.attachmentPort = attachmentPort
        self.expectedPixelSha256 = expectedPixelSha256
        self.keyPort = keyPort
        self.delay = delay
    }

    func submitPreparedImage() throws {
        try keyPort.postSubmit(command: false)
        delay(0.65)
        let observation: ImageAttachmentObservation
        do {
            observation = try attachmentPort.readPreparedImage()
        } catch {
            // An unreadable composer is not proof that the reviewed attachment survived.
            // Do not emit a second key event; the outer empty/readback checks fail closed.
            return
        }
        guard ImageAttachmentCleanupAuthorization.permitsUndo(
            observation,
            expectedPixelSha256: expectedPixelSha256
        ) else {
            throw BridgeError("WECHAT_IMAGE_SEND_RESULT_UNCERTAIN")
        }
        try attachmentPort.collapseSelection()
        try keyPort.postSubmit(command: true)
        delay(0.65)
    }

    func verifyComposerEmptyAfterSubmit() throws {
        let snapshot = try attachmentPort.snapshotPasteboard()
        do {
            try attachmentPort.assertComposerEmptyBaseline()
            try attachmentPort.restorePasteboard(snapshot)
        } catch {
            let original = error
            do {
                try attachmentPort.restorePasteboard(snapshot)
            } catch {
                throw BridgeError("PASTEBOARD_RESTORE_FAILED")
            }
            throw original
        }
    }

    func verifyLatestOutgoingImage(_ reviewedImage: ReviewedImage) throws {
        let captureURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("wechat-image-send-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: captureURL) }
        try WindowAccess.capture(windowID: windowID, outputURL: captureURL)
        guard let image = NSImage(contentsOf: captureURL),
              let screenshot = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
              try OutgoingReviewedImageMatcher.matches(reviewedImage: reviewedImage, in: screenshot) else {
            throw BridgeError("WECHAT_IMAGE_SEND_RESULT_NOT_VERIFIED")
        }
    }
}
